import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as chat from '@botpress/chat'
import express from 'express'

const webhookId = process.env.BOTPRESS_WEBHOOK_ID
if (!webhookId) {
  console.error('Missing BOTPRESS_WEBHOOK_ID. Create a .env file next to server.js containing:')
  console.error('  BOTPRESS_WEBHOOK_ID=<the Chat integration webhook id>')
  process.exit(1)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

/** sessionId -> session. Process memory: every session dies with the server. */
const sessions = new Map()

/** How long a session survives with no browser attached before it is reaped.
 *  Overridable so the reaper can be tested without waiting two minutes. */
const IDLE_GRACE_MS = Number(process.env.IDLE_GRACE_MS ?? 2 * 60 * 1000)

const disposeSession = async (sessionId) => {
  const session = sessions.get(sessionId)
  if (!session) {
    return
  }
  session.closed = true
  clearTimeout(session.idleTimer)
  sessions.delete(sessionId)
  console.log('[session] disposed %s (%d still open)', sessionId, sessions.size)
  try {
    await session.listener?.disconnect()
  } catch (err) {
    console.warn('[session] disconnect failed:', err?.message ?? err)
  }
}

/**
 * Opens the Botpress signal stream and re-opens it when it drops.
 *
 * SignalListener has a 60s watchdog and no retry loop of its own. A person
 * filling in a form is silent for well over 60s, so without this the stream
 * dies mid-form and the next bot reply never arrives.
 */
const attachListener = async (session) => {
  const listener = await session.client.listenConversation({ id: session.conversationId })

  listener.on('message_created', (ev) => {
    if (!ev.isBot) {
      return
    }
    const text = ev.payload?.text ?? ev.payload?.markdown
    if (text) {
      session.emit({ kind: 'message', text })
    }
  })

  listener.on('event_created', (ev) => {
    if (ev.userId === session.client.user.id) {
      return
    }
    session.emit({ kind: 'event', payload: ev.payload })
  })

  listener.on('error', (err) => {
    if (session.closed) {
      return
    }
    console.warn('[signal] %s — reconnecting', err.message)
    setTimeout(() => {
      attachListener(session).catch((e) => {
        console.error('[signal] reconnect failed', e)
        session.emit({ kind: 'error', message: 'Connexion interrompue. Rechargez la page.' })
      })
    }, 500)
  })

  session.listener = listener
  return listener
}

const openSession = async () => {
  const client = await chat.Client.connect({ webhookId })
  const { conversation } = await client.createConversation({})

  const session = {
    client,
    conversationId: conversation.id,
    listener: null,
    closed: false,
    // Signals start arriving before the browser has opened its SSE stream, so
    // hold them until there is somewhere to put them.
    pending: [],
    sink: null,
  }

  session.emit = (payload) => {
    if (session.sink) {
      session.sink(payload)
    } else {
      session.pending.push(payload)
    }
  }

  await attachListener(session)
  return session
}

app.post('/api/session', async (_req, res) => {
  try {
    const session = await openSession()
    const sessionId = randomUUID()
    sessions.set(sessionId, session)

    // No sentinel message here on purpose. The chat integration has no
    // conversationStarted event, so a conversation alone never wakes the bot —
    // but the opening form is a constant, and the page renders it locally rather
    // than paying ~3s of LLM to regenerate it. The bot first hears from us when
    // the customer submits.
    res.json({ sessionId })
  } catch (err) {
    console.error('[session]', err)
    res.status(500).json({ error: String(err?.message ?? err) })
  }
})

app.get('/api/stream/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId)
  if (!session) {
    res.status(404).end()
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.flushHeaders?.()

  clearTimeout(session.idleTimer)
  session.sink = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
  for (const payload of session.pending.splice(0)) {
    session.sink(payload)
  }

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000)
  req.on('close', () => {
    clearInterval(keepAlive)
    session.sink = null
    // A closed tab or a sleeping laptop leaves the Botpress listener
    // reconnecting every 60s forever, so reap the session if the browser does
    // not come back. EventSource retries within seconds, so this is generous.
    session.idleTimer = setTimeout(() => disposeSession(req.params.sessionId), IDLE_GRACE_MS)
  })
})

/** Called by the page when the customer restarts. Without it each restart would
 *  leave a live Botpress signal stream behind, reconnecting forever. */
app.post('/api/session/:sessionId/end', async (req, res) => {
  await disposeSession(req.params.sessionId)
  res.json({ ok: true })
})

app.post('/api/answers/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId)
  if (!session) {
    res.status(404).json({ error: 'unknown session' })
    return
  }

  try {
    await session.client.createMessage({
      conversationId: session.conversationId,
      payload: { type: 'text', text: JSON.stringify(req.body) },
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('[answers]', err)
    res.status(500).json({ error: String(err?.message ?? err) })
  }
})

const port = process.env.PORT ?? 3000
app.listen(port, () => console.log(`Hybrid form PoC on http://localhost:${port}`))
