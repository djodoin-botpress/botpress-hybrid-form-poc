/**
 * The opening step never varies, so it is not worth a ~3s LLM round trip on
 * every page load. Rendering it here puts the form on screen immediately while
 * the Botpress session opens in the background — by the time anyone has typed
 * their name, the conversation is ready.
 *
 * The bot still defines the same step (STEP 1, on the `{"__start":true}`
 * sentinel) so it stays usable from the Studio emulator or any other client.
 * If you change these fields, change them there too.
 */
/**
 * Prefilled so the demo does not start with someone typing their own name.
 * In production these come from the member session, not a constant.
 */
const DEMO_CUSTOMER = {
  name: 'Camille Durand',
  email: 'camille.durand@example.com',
  booking: 'BK-0000000 - Grèce / Agia Paraskevi',
}

const OPENING_STEP = {
  type: 'form_step',
  title: 'Comment pouvons-nous vous aider ?',
  done: false,
  fields: [
    { id: 'name', label: 'Nom', type: 'text', value: DEMO_CUSTOMER.name },
    { id: 'email', label: 'Email', type: 'email', value: DEMO_CUSTOMER.email },
    { id: 'booking', label: 'Référence de séjour', type: 'text', value: DEMO_CUSTOMER.booking },
    {
      id: 'topic',
      label: 'Sujet',
      type: 'select',
      options: ['Réservation', 'Paiement', 'Annulation', 'Autre'],
    },
    { id: 'details', label: 'Décrivez votre demande', type: 'textarea' },
  ],
}

document.addEventListener('alpine:init', () => {
  let entryId = 0

  Alpine.data('hybridForm', () => ({
    sessionId: null,
    stream: null,
    title: 'Nous contacter',

    /** The running conversation: every bot line and every message the customer
     *  writes back, oldest first. Grows — it is never replaced. */
    timeline: [],

    /** The current form step. Replaced wholesale each time: the form changes
     *  shape, it does not accumulate. */
    fields: [],
    answers: {},

    choices: [],
    followUp: '',
    thinkingText: 'Un instant…',
    ready: false,
    busy: false,
    done: false,
    error: null,

    /** Resolves once the conversation exists. Awaited before the first send. */
    sessionReady: null,

    init() {
      // Paint the form first, connect second.
      this._handle({ kind: 'event', payload: OPENING_STEP })
      this.sessionReady = this._openSession()
    },

    async _openSession() {
      try {
        const res = await fetch('/api/session', { method: 'POST' })
        if (!res.ok) {
          throw new Error((await res.json()).error ?? res.statusText)
        }
        this.sessionId = (await res.json()).sessionId
      } catch (err) {
        this.error = `Impossible de démarrer la session : ${err.message}`
        return
      }

      const stream = new EventSource(`/api/stream/${this.sessionId}`)
      this.stream = stream
      stream.onmessage = (raw) => this._handle(JSON.parse(raw.data))
      stream.onerror = () => {
        // Ignore the error a closed stream fires while restarting.
        if (this.stream !== stream) {
          return
        }
        this.error = 'Connexion interrompue. Rechargez la page.'
        stream.close()
      }
    },

    _push(role, text, links = []) {
      if (!text) {
        return
      }
      this.timeline.push({ id: ++entryId, role, text, links })
      this._scrollToEnd()
    },

    /** Called again at the end of _handle: showing the dock shrinks the
     *  timeline, so a scroll taken at push time is no longer the bottom. */
    _scrollToEnd() {
      // nextTick alone lands short: the new entry is in the DOM but not yet laid
      // out, so scrollHeight is stale. rAF waits for that layout.
      this.$nextTick(() => {
        requestAnimationFrame(() => {
          const el = this.$refs.timeline
          if (el) {
            el.scrollTop = el.scrollHeight
          }
        })
      })
    },

    _handle(payload) {
      if (payload.kind === 'error') {
        this.error = payload.message
        return
      }

      if (payload.kind === 'message') {
        this._push('bot', payload.text)
        return
      }

      if (payload.kind === 'event' && payload.payload?.type === 'form_step') {
        const step = payload.payload
        this.busy = false
        this.ready = true
        this.done = Boolean(step.done)
        if (step.title) {
          this.title = step.title
        }

        if (step.answer) {
          // Only http(s) — the bot supplies these, but a rendered anchor is the
          // one place a bad value would become clickable.
          const links = (step.links ?? []).filter((l) => /^https?:\/\//i.test(l.url ?? ''))
          this._push('bot', step.answer, links)
        }

        this.choices = step.choices ?? []
        this.fields = step.fields ?? []
        for (const field of this.fields) {
          // Seed from the step's own `value` when it supplies one; answers
          // already given are never overwritten.
          if (!(field.id in this.answers)) {
            this.answers[field.id] = field.value ?? ''
          }
        }
        this._scrollToEnd()
      }
    },

    async submit() {
      if (this.busy) {
        return
      }
      // Free text is what belongs in a conversation; short structured fields do
      // not, so only textareas are echoed into the timeline.
      for (const field of this.fields) {
        if (field.type === 'textarea') {
          this._push('user', (this.answers[field.id] ?? '').trim())
        }
      }
      const payload = { ...this.answers }
      this.busy = true
      this.thinkingText = 'L\'assistant analyse votre demande…'
      // Drop the fields now rather than when the next step lands: the LLM call
      // takes seconds, and leaving the answered form on screen that whole time
      // reads as if the click did nothing.
      this.fields = []
      await this._post(payload)
    },

    async choose(choice) {
      if (this.busy) {
        return
      }
      this.busy = true
      this.thinkingText = 'Un instant…'
      await this._post({ choice })
    },

    /** The answer was close but not quite: let them say more without forcing
     *  them to pick one of the two buttons. */
    async sendFollowUp() {
      const text = this.followUp.trim()
      if (!text || this.busy) {
        return
      }
      this._push('user', text)
      this.busy = true
      this.thinkingText = 'Un instant…'
      this.followUp = ''
      await this._post({ followUp: text })
    },

    async _post(body) {
      try {
        // The form is on screen before the session exists, so the first send may
        // arrive first. In practice it never waits: filling the form takes far
        // longer than opening the conversation.
        await this.sessionReady
        if (!this.sessionId) {
          throw new Error('session indisponible')
        }
        const res = await fetch(`/api/answers/${this.sessionId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          throw new Error((await res.json()).error ?? res.statusText)
        }
      } catch (err) {
        this.busy = false
        this.error = `Envoi impossible : ${err.message}`
      }
      // busy stays true until the next form_step arrives — that wait is the
      // moment the demo has to feel alive.
    },

    /** Back to a blank form on a brand new conversation, without a page reload. */
    async restart() {
      const previous = this.sessionId
      this.stream?.close()
      this.stream = null

      this.sessionId = null
      this.sessionReady = null
      this.title = 'Nous contacter'
      this.timeline = []
      this.fields = []
      this.answers = {}
      this.choices = []
      this.followUp = ''
      this.thinkingText = 'Un instant…'
      this.ready = false
      this.busy = false
      this.done = false
      this.error = null

      if (previous) {
        // Fire and forget: tearing down the old stream must not delay the new form.
        void fetch(`/api/session/${previous}/end`, { method: 'POST' }).catch(() => {})
      }
      this.init()
    },
  }))
})
