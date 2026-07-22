// service-worker.js
// The orchestrator. It owns session lifecycle, the offscreen document, and — critically —
// it is the ONE place that calls the ingestion seam. It holds no media (MV3 forbids it);
// audio lives in the offscreen document. Flow:
//
//   side panel --START--> SW --getMediaStreamId--> SW --createOffscreen--> offscreen
//   offscreen --TRANSCRIPT_FINAL--> SW --buildNote--> ingestNote() --> engine
//   engine --coaching--> SW --COACHING_UPDATE--> side panel
//
// buildNote() + ingestNote() are the same contract + seam the paste path uses. Audio is
// just a second producer feeding the one engine at a live tempo.

import { Target, MsgType, SessionState, msg, onMessage } from '../common/messaging.js';
import { loadConfig } from '../common/config.js';
import { buildNote, validateNote } from '../pipeline/note-object.js';
import { ingestNote } from '../pipeline/ingest-client.js';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
const AUTH_TOKEN_STORAGE = 'salesogre.listener.authToken';

// In-memory session. Reset whenever the SW is respawned; the side panel re-syncs via
// GET_STATE on open.
let session = null;

function freshSession(dealId) {
  return {
    sessionId: crypto.randomUUID(),
    dealId: dealId ?? null,
    state: SessionState.IDLE,
    startedChannels: [],
  };
}

function setState(state, extra = {}) {
  if (session) session.state = state;
  broadcast(MsgType.STATE_CHANGED, { state, session: publicSession(), ...extra });
}

function publicSession() {
  if (!session) return { state: SessionState.IDLE };
  return { sessionId: session.sessionId, dealId: session.dealId, state: session.state, startedChannels: session.startedChannels };
}

function broadcast(type, payload) {
  chrome.runtime.sendMessage(msg(Target.SIDEPANEL, type, payload)).catch(() => {});
}

// --- Offscreen lifecycle ---------------------------------------------------

async function hasOffscreen() {
  // getContexts is the reliable MV3 way to check for an existing offscreen document.
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Capture and transcribe live sales-call audio (tab + microphone).',
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    try { await chrome.offscreen.closeDocument(); } catch { /* already gone */ }
  }
}

// --- Session control -------------------------------------------------------

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
}

async function startSession({ dealId }) {
  session = freshSession(dealId);
  setState(SessionState.STARTING);

  const cfg = await loadConfig();

  // Mint the tabCapture stream id for the active tab. Requires the user gesture that
  // opened/clicked the panel (activeTab). If there's no eligible tab, we proceed mic-only.
  let themStreamId = null;
  try {
    const tabId = await getActiveTabId();
    if (tabId != null) {
      themStreamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    }
  } catch (err) {
    // Non-fatal: fall back to mic-only. Document for the user in the panel.
    broadcast(MsgType.SESSION_ERROR, { level: 'warn', error: `Tab audio unavailable: ${String(err?.message || err)}. Continuing mic-only.` });
  }

  await ensureOffscreen();

  await chrome.runtime.sendMessage(
    msg(Target.OFFSCREEN, MsgType.OFFSCREEN_START_CAPTURE, {
      themStreamId,
      sttProvider: cfg.sttProvider,
      sampleRate: cfg.audio.sampleRate,
      frameSize: Math.round((cfg.audio.sampleRate * cfg.audio.chunkMs) / 1000),
      maxSilenceMs: cfg.utteranceMaxSilenceMs,
    }),
  ).catch((e) => { throw new Error(`Offscreen did not start: ${e}`); });
}

async function stopSession() {
  if (!session) return;
  setState(SessionState.STOPPING);
  await chrome.runtime.sendMessage(msg(Target.OFFSCREEN, MsgType.OFFSCREEN_STOP_CAPTURE, {})).catch(() => {});
  await closeOffscreen();
  setState(SessionState.IDLE);
  session = null;
}

// --- The ingest seam: finalized utterance -> note object -> engine ---------

async function handleFinalUtterance(utterance) {
  if (!session) return;
  const cfg = await loadConfig();
  const tokenBag = await chrome.storage.local.get(AUTH_TOKEN_STORAGE);
  const authToken = tokenBag[AUTH_TOKEN_STORAGE];

  const note = buildNote({
    text: utterance.text,
    channel: utterance.channel,
    dealId: session.dealId,
    sessionId: session.sessionId,
    seq: utterance.seq,
    speakerLabel: utterance.speakerLabel,
    confidence: utterance.confidence,
    sttProvider: utterance.sttProvider,
  });

  // Always show the finalized line in the transcript, even before the engine responds.
  broadcast(MsgType.TRANSCRIPT_APPEND, { final: true, note });

  const check = validateNote(note);
  if (!check.ok) return; // skip empty/garbage; nothing to ingest

  const result = await ingestNote(note, { ingestUrl: cfg.ingestUrl, authToken });
  if (!result.ok) {
    broadcast(MsgType.SESSION_ERROR, {
      level: 'error',
      status: result.status,
      // 402/403 = entitlements/caps boundary. Relay verbatim so the panel can explain.
      error: result.error || 'Ingestion failed',
    });
    return;
  }
  // Relay the engine's live coaching (persona reads, MEDDPICC, next-best-action) to the UI.
  broadcast(MsgType.COACHING_UPDATE, { noteId: note.noteId, coaching: result.coaching, dryRun: result.dryRun });
}

// --- Message routing -------------------------------------------------------

onMessage(Target.SW, async (message) => {
  switch (message.type) {
    // from side panel
    case MsgType.START_SESSION:
      try { await startSession(message.payload || {}); }
      catch (err) { setState(SessionState.ERROR); broadcast(MsgType.SESSION_ERROR, { level: 'error', error: String(err?.message || err) }); }
      return { ok: true };
    case MsgType.STOP_SESSION:
      await stopSession();
      return { ok: true };
    case MsgType.GET_STATE:
      return { session: publicSession() };

    // from offscreen
    case MsgType.CAPTURE_STARTED:
      if (session) session.startedChannels = message.payload.channels || [];
      setState(SessionState.LISTENING);
      return { ok: true };
    case MsgType.CAPTURE_STOPPED:
      return { ok: true };
    case MsgType.CAPTURE_ERROR:
      broadcast(MsgType.SESSION_ERROR, { level: message.payload.fatal ? 'error' : 'warn', error: message.payload.error });
      if (message.payload.fatal) { setState(SessionState.ERROR); }
      return { ok: true };
    case MsgType.TRANSCRIPT_PARTIAL:
      broadcast(MsgType.TRANSCRIPT_APPEND, { final: false, partial: message.payload });
      return { ok: true };
    case MsgType.TRANSCRIPT_FINAL:
      await handleFinalUtterance(message.payload);
      return { ok: true };
    default:
      return undefined;
  }
});

// Open the side panel when the toolbar icon is clicked.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
});
