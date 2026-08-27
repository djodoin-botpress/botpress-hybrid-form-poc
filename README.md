# Hybrid contact form — PoC

> **Private proof of concept.** No credentials, bot IDs or webhook IDs are stored in
> this repository — supply them via `.env` (see [Run it](#run-it)). The prefilled demo
> customer is fictional.
>
> Architecture write-up: [`docs/architecture.html`](docs/architecture.html) ·
> [PDF](docs/architecture.pdf) — French: [`docs/architecture.fr.html`](docs/architecture.fr.html) ·
> [PDF](docs/architecture.fr.pdf)

A contact form where the questions change based on what the user typed. Classic fields
up front, then 1–3 follow-ups the LLM decides are actually still needed. No chat widget.

## Shape

```
browser (Alpine.js via CDN)  <--SSE + fetch-->  Node/Express  <--@botpress/chat-->  Chat API  <-->  scratch Studio bot
```

The Node server holds the Chat API client, so the webhook ID stays server-side and
there is no CORS story to explain mid-demo.

The bot drives the form by sending `chat:sendEvent` payloads shaped like:

```json
{
  "type": "form_step",
  "title": "Encore deux précisions",
  "fields": [
    { "id": "travel_date", "label": "Date de départ", "type": "text" },
    { "id": "passengers", "label": "Nombre de voyageurs", "type": "text" }
  ]
}
```

`fields` supports `text`, `email`, `textarea`, and `select` (with `options`), plus an
optional `placeholder`. A step with `"done": true` switches the page to the confirmation
state. Each step **replaces** the visible fields — the form changes shape rather than
growing.

Answers travel back the other way as a single message whose text is a JSON blob of
`{ fieldId: value }`.

Once it has enough, the bot attempts an answer instead of handing straight to a human.
That step carries `answer` and `choices` instead of `fields`:

```json
{
  "type": "form_step",
  "title": "Notre réponse",
  "done": false,
  "fields": [],
  "answer": "Vous pouvez modifier les dates de votre séjour en vous connectant à votre compte-membre…",
  "links": [
    { "label": "Accéder à mon compte-membre", "url": "https://www.example.com/account" }
  ],
  "choices": [
    { "id": "resolved", "label": "Cette réponse répond à ma question" },
    { "id": "human", "label": "Transférer ma demande à un conseiller" }
  ]
}
```

`links` render as buttons under the answer. The client filters to `http(s)` only — the
bot supplies these, but a rendered anchor is the one place a bad value becomes
clickable.

The page renders the answer as the main content with the choices as buttons, and posts
back `{ "choice": "resolved" }` or `{ "choice": "human" }`.

Under the two buttons there is also a free-text box (*"Écrivez votre réponse
complémentaire ici..."*) which posts `{ "followUp": "…" }`. The bot answers again with a
fresh `answer` and the same two choices, so the customer can go round as many times as
they like before deciding. It sits **below** the buttons on purpose: resolving stays the
path of least resistance, and the box is there for when the answer was close but not
quite. The bot then closes with
`done: true` and a title that differs per branch ("Ravi d'avoir pu vous aider" vs
"Transmis à un conseiller"). The confirmation body is the assistant's own last line, so
the closing text always matches what actually happened.

### Why the opening form is not generated

The page renders the first form **locally and instantly**, from `OPENING_STEP` in
`public/app.js`, then opens the Botpress session in the background. Measured before the
change:

```
  260 ms  Client.connect()
  202 ms  createConversation()
  454 ms  listenConversation()
  269 ms  createMessage(sentinel)
 3236 ms  bot LLM -> first form_step
 4153 ms  TOTAL to first form
```

Three of those four seconds were an LLM call regenerating five fields that are hardcoded
in the prompt and never vary — a constant, priced as inference, on every page load. The
sentinel message is gone with it: the bot now first hears from us when the customer
submits.

The cost is one duplicated definition. The bot keeps STEP 1 so it still works from the
Studio emulator or any other client, so **if you change the opening fields, change them
in both places**. The dynamic part — follow-ups, answers, choices — is untouched and
still comes entirely from the LLM.

## The bot

Build it in a sandbox workspace. You will need two identifiers, both kept out of
this repo:

- **Bot ID** — from the Studio URL once the bot exists
- **Chat integration webhook ID** — Dashboard → your bot → Integrations → Chat

It is **one Autonomous Node with one tool**, not the AI-Task-plus-Execute-Code chain
originally planned. Same behaviour, far less canvas wiring, and the LLM genuinely
decides the fields rather than following a scripted branch.

- **Tool:** Chat → *Send Custom Event* (there is also a Webchat card with the same
  name — take the Chat one).
- **Instructions:** define the `form_step` payload shape, then three steps — bootstrap
  on `{"__start":true}`, decide at most three follow-ups from the answers, finish with
  `done: true`. Read them in Studio; they are the whole behaviour.
- Knowledge Base removed from the node — it was noise.

Two things that will bite anyone rebuilding this:

- **The chat integration has no `conversationStarted` event.** Creating a conversation
  does not wake the bot — only messages and events do. That is why `POST /api/session`
  sends a `{"__start":true}` sentinel message.
- **The tool's Conversation ID field defaults to "Let AI Decide".** Click the purple
  wand beside the label, switch to **Manual**, and enter `{{event.conversationId}}`.
  Left on AI-fill, the LLM writes `conversationId: conversation.id`, which is
  `undefined` inside the LLMz sandbox (the node has no readable variables), and every
  call dies with:

  ```
  Tool 'sendEvent' received invalid input:
    code: "invalid_type", expected: "string", received: "undefined",
    path: ["conversationId"], message: "Required"
  ```

  The user just sees "Une erreur technique est survenue." The real error is only in the
  bot's Logs view in the Dashboard — Sauron's `get_bot_cloud_logs` does not surface it.

## Run it

```bash
cd botpress-hybrid-form-poc
npm install
```

Create a `.env` file next to `server.js`:

```
BOTPRESS_WEBHOOK_ID=<the Chat integration webhook id>
PORT=3000
```

Then `npm start` and open http://localhost:3000. Requires Node 20.6+ (for `--env-file`).

## Demo script

The moment worth showing is that the second screen differs by intent. Both runs below
are verified output from the live bot, not mock-ups.

1. Open the page. The first form step appears in a second or two. If it never does, the
   bot did not get the sentinel — check the Chat integration is enabled.
2. Fill it in with **Sujet: Annulation** and a description mentioning a medical reason.
   Observed:
   - *"Merci pour votre message, nous espérons que vous allez vite vous rétablir."*
   - **Pouvez-vous fournir un justificatif médical ?** (Oui / Non)
   - **Préférez-vous un report de séjour ou un remboursement ?**
3. In a fresh tab, do it again with a **double charge** on Sujet: Paiement. Observed:
   - *"Merci pour ces précisions, nous allons examiner votre dossier rapidement."*
   - **Pouvez-vous joindre un justificatif du second prélèvement ?** (free text)
   - **Le moyen de paiement était-il le même pour les deux prélèvements ?**
4. Answer the follow-ups. Expect a summary line and the confirmation state.

Put steps 2 and 3 side by side. Different questions, different field *types*, different
tone — that contrast is the whole pitch.

5. The bot then proposes an answer with two buttons. Both branches are verified:
   *Cette réponse répond à ma question* closes on "Ravi d'avoir pu vous aider";
   *Transférer ma demande à un conseiller* closes on "Transmis à un conseiller".

6. Before deciding, type into **Besoin d'une précision ?** — e.g. *"Je ne trouve aucune
   option de modification dans mon espace membre, et mon départ est dans 3 jours."*
   Verified: the bot answers again taking both new facts into account, and the two
   buttons stay available.
7. **Faire une nouvelle demande** on the confirmation screen resets to a blank form on a
   brand new conversation — no page reload, nothing carried over from the last run. The
   same button appears as *Recommencer* on the error state, so a dropped stream is not a
   dead end either.

Allow ~15s per step; the autonomous node is doing a real LLM call each turn.

Restarting also tears the old session down server-side (`POST /api/session/:id/end`
disconnects the Botpress signal listener and drops it from the map). Without that, every
restart would leave a live stream behind reconnecting forever — which matters, because a
demo gets restarted a lot.

Sessions are also reaped when the browser simply goes away — a closed tab, a sleeping
laptop — after `IDLE_GRACE_MS` (default 2 min, overridable for testing) with no SSE
attached. Re-attaching within the grace cancels the reap, so an ordinary EventSource
retry is safe. This was found the hard way: a tab left open overnight had the server
logging `[signal] Client connection timed out — reconnecting` 57 times, once a minute,
forever.

### A worked example

The cleanest single screen to demo. With **Sujet: Réservation** and
*"Puis-je modifier les dates de mon séjour ?"*:

> Vous pouvez modifier les dates de votre séjour en vous connectant à votre
> compte-membre et en accédant à la section réservations. Cliquez sur votre réservation
> puis sélectionnez l'option pour modifier les dates. Si besoin, un conseiller
> confirmera les changements.
>
> **[ Accéder à mon compte-membre → ]**

That is the cleanest single screen to demo.

### Two behaviours to know before you demo this

- **The follow-up round is not guaranteed.** The LLM decides whether it needs more
  information, and on a clearly-stated request it skips straight from the first form to
  the answer. Correct behaviour, but the "questions adapt" beat can vanish. For that
  beat, use a deliberately vague description (the medical cancellation works), or force
  a follow-up round in the instructions.
- **The link URL is a placeholder.** The instructions carry a one-entry allow-list
  pointing at `https://www.example.com/account`. Swap it for the real deep link to your
  member area, and add entries for any other destination you want the bot to be able to
  offer. The bot is told never to emit a URL outside that list and never to put a raw
  URL in the answer text, which is what keeps it from inventing plausible-looking paths.

### Why the prompt has a NEVER PUNT block

Two prompt bugs, in sequence, both worth understanding before editing the instructions.

First the answers invented delays — *"généralement de 10 jours ouvrés"*, *"par email
sous 24h"*. Nothing in the bot knows either figure.

The obvious fix made things worse: the correction said *"say that a conseiller will
confirm instead"*, which is a direct instruction to defer. Answers started ending on
*"Un conseiller confirmera la faisabilité de la modification"* — handing the request to
a human on the customer's behalf, which is the one thing they can already do themselves
by pressing the second button. A deflection flow that pre-empts the escalation deflects
nothing.

So the instructions now carry two separate blocks:

- **NEVER PUNT** — the answer may never say the request is being transferred, that a
  conseiller will contact or confirm, or that someone will get back to them. If part of
  the request depends on a case-by-case decision, say what it depends on and what the
  customer should do next.
- **WHAT YOU DO NOT KNOW** — never state delays, amounts, prices, availability, dates,
  policy conditions or reference numbers, and **do not replace them with a promise that
  someone will confirm them**. Leave them out and answer the rest.

Verified after the change:

> Pour annuler votre séjour pour raison médicale, merci de préparer un justificatif
> médical à votre nom et de le joindre à votre demande via votre espace membre en
> cliquant sur le lien ci-dessous.

> Vous pouvez généralement modifier les dates de votre séjour sous réserve de
> disponibilité et des conditions de votre réservation. Connectez-vous à votre compte en
> cliquant sur le lien ci-dessous pour vérifier les options de modification.

Both name what the outcome depends on and give the customer the next action, without
inventing a figure and without escalating for them. Keep both blocks if you edit the
prompt — dropping either one brings its failure straight back.
