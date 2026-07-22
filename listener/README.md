# SalesOgre Live Listener (Chrome MV3)

A Chrome-extension audio listener that runs during a live sales call and delivers, in
real time, what the SalesOgre platform already produces after the fact: persona /
stakeholder reads, buyer-role categorization, MEDDPICC + committee field capture, and
next-best-action coaching.

> **The governing rule: one engine, one contract, two tempos.**
> The listener is **not** a new engine. It is a new **input adapter** into the pipeline
> that already exists. The paste-notes path produces a *note object* that flows into the
> engine (sentence split → signal matching → stance reads → persona suggestion →
> contact-hub stance log → deal recalibration → MEDDPICC → no-decision checks). Audio
> normalizes into the **same note object** and hits the **same ingestion entry point**.
> There is no "live engine" fork. If the live path needs new behavior, it goes in the
> shared engine — never a copy here.

---

## Where this lives (read this first)

This code was built **standalone inside the `website-v.03` repo** (the marketing site),
because that is the repo this session is scoped to push to. The actual engine + paste
path live in **`meridian-ai-engine`**, and the Cloud Functions boundary
(entitlements + caps) lives in **`SalesOgre-Ai-Paid`**. Two integration points must be
reconciled against those repos before this is production-wired — both are isolated to a
single file each on purpose:

1. **The note object shape** — `src/pipeline/note-object.js`. `buildNote()` is the *only*
   place a note is constructed. Reconcile its fields with whatever the paste path sends
   to the engine. `text` + `dealId` + `source` are assumed to be the primary inputs
   (parity with paste); everything else is additive metadata.
2. **The ingestion endpoint** — `src/pipeline/ingest-client.js` + the `ingestUrl` config.
   Point it at the **same** Cloud Function the paste path calls. Until then it runs in
   **dry-run** mode (logs the note object instead of POSTing) so the whole capture → STT
   pipeline is testable with no backend.

Everything else (capture, STT, messaging, UI) is engine-agnostic and needs no changes to
switch backends.

---

## Architecture

MV3 forbids service workers from holding `MediaStream`s, so capture + STT run in an
**offscreen document**. The service worker is a pure router + lifecycle owner and the one
caller of the ingestion seam.

```
 side panel  ──START/STOP──▶  service worker  ──control──▶  offscreen document
     ▲                             │                            │  (holds streams,
     │                             │                            │   runs STT)
     │◀── transcript / coaching ───┤◀── TRANSCRIPT_FINAL ───────┘
                                   │
                                   └── buildNote() → ingestNote() → engine → coaching
```

| File | Responsibility |
|------|----------------|
| `src/common/messaging.js` | The typed message contract between all three surfaces. |
| `src/common/config.js` | Runtime config (ingestUrl, STT provider, audio framing), storage-overridable. |
| `src/background/service-worker.js` | Session lifecycle, offscreen lifecycle, **the one ingest seam call**. |
| `src/offscreen/offscreen.{html,js}` | Hosts capture + STT. Emits interim + finalized transcript. No engine work. |
| `src/offscreen/pcm-worklet.js` | AudioWorklet that reframes mono PCM off the main thread. |
| `src/capture/dual-stream.js` | Dual, **separately captured** streams: tab (them) + mic (us). |
| `src/stt/stt-adapter.js` | Provider-agnostic streaming STT factory. |
| `src/stt/providers/mock-provider.js` | Offline, no-key default provider. |
| `src/stt/providers/deepgram-provider.js` | Reference real streaming provider (diarization pass-through). |
| `src/pipeline/transcript-buffer.js` | STT results → finalized utterances (+ session seq). |
| `src/pipeline/note-object.js` | **The shared contract.** `buildNote()` / `validateNote()`. |
| `src/pipeline/ingest-client.js` | **The one seam.** POSTs the note object to the engine. |
| `src/sidepanel/*` | Rep-facing UI: live transcript + coaching. Thin view over messages. |

## Speaker separation (v1)

We capture **two streams, separately** — `chrome.tabCapture` for the remote participants
("them") and `getUserMedia` for the rep ("us"). That gives the separation that matters
(them vs us) **for free**, with no diarization. Within the "them" channel, if the STT
provider returns speaker labels we pass them through untouched; otherwise the utterance is
left unattributed. Full diarization is explicitly **out of scope for v1**.

## Swapping the STT provider

Streaming STT sits behind a provider-agnostic interface (`start` / `pushAudio` / `stop`,
emitting `{ text, isFinal, speakerLabel, confidence }`). To change vendors:

1. Add `src/stt/providers/<vendor>-provider.js` implementing the interface.
2. Register it in `src/stt/stt-adapter.js`.
3. Set `sttProvider` in config (or `chrome.storage.local`).

Nothing downstream (buffer, note object, ingestion, UI) changes. The default is `mock`
(no key, no network) so the extension loads and runs end-to-end out of the box.

## ⚠️ Scope limit — desktop calls are invisible

`chrome.tabCapture` **only sees audio playing in a browser tab.** A call running in the
**desktop** Zoom or Teams app is **not** captured by this extension — there is no browser
tab for it to attach to. v1 supports **browser-tab calls** (Zoom/Teams/Meet *web*
clients, etc.). Desktop-app capture would require a different mechanism (native messaging
/ system audio loopback) and is out of scope for v1.

## Running it (dev)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this
   `listener/` folder.
2. Open a browser tab with audio (e.g. a web Zoom/Meet call, or any playing tab).
3. Click the extension icon to open the side panel → optionally enter a Deal id →
   **Start listening**.
4. With the default `mock` provider you'll see a scripted them/us transcript and, in
   dry-run mode, the note objects logged in the service-worker console
   (`chrome://extensions` → *Inspect views: service worker*).

### Going live
- Set `ingestUrl` (config or `chrome.storage.local` under `salesogre.listener.config`) to
  the engine's ingestion Cloud Function — the same one the paste path uses.
- Put the user's session token in `chrome.storage.local` under
  `salesogre.listener.authToken` (sent as `Authorization: Bearer …`). Entitlements + caps
  are enforced server-side; a `402/403` is surfaced verbatim in the panel.
- For a real STT provider, set `sttProvider` and store the key under
  `salesogre.listener.sttKey` (fetched lazily; never bundled).

## Not yet done / follow-ups
- Toolbar icon assets (`icons/`) — manifest `icons` key intentionally omitted so nothing
  ships a broken path.
- Reconcile `buildNote()` fields + `ingestUrl` against `meridian-ai-engine` /
  `SalesOgre-Ai-Paid` (see "Where this lives").
- Short-lived STT-token fetch endpoint (currently a static storage key).
