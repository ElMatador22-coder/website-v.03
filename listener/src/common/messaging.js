// messaging.js
// The explicit message contract between the three MV3 surfaces:
//
//   side panel  <--user intent-->  service worker  <--control-->  offscreen document
//        ^                                                              |
//        |------------------- live coaching / transcript --------------|
//
// MV3 service workers cannot hold MediaStreams, so all capture + STT lives in the
// offscreen document. The service worker is a pure message router + lifecycle owner.
// Every message is a plain object: { type, channel?, payload? }. Keep it serializable.

// Where a message is addressed. chrome.runtime.sendMessage is a broadcast, so each
// listener filters on `target` to avoid acting on messages meant for someone else.
export const Target = Object.freeze({
  SW: 'sw',
  OFFSCREEN: 'offscreen',
  SIDEPANEL: 'sidepanel',
});

// Which captured audio channel a message concerns. We do NOT attempt full diarization
// in v1 — "them" vs "us" is the speaker separation that matters, obtained for free by
// capturing two separate streams. Sub-speakers inside "them" are only distinguished if
// the STT provider hands back speaker labels (passed through untouched).
export const Channel = Object.freeze({
  THEM: 'them', // remote participants, via chrome.tabCapture
  US: 'us',     // the rep, via getUserMedia microphone
});

export const MsgType = Object.freeze({
  // --- side panel -> service worker (user intent) ---
  START_SESSION: 'session/start',
  STOP_SESSION: 'session/stop',
  GET_STATE: 'session/get-state',

  // --- service worker -> offscreen (control) ---
  OFFSCREEN_START_CAPTURE: 'offscreen/start-capture',
  OFFSCREEN_STOP_CAPTURE: 'offscreen/stop-capture',

  // --- offscreen -> service worker (data + lifecycle) ---
  CAPTURE_STARTED: 'offscreen/capture-started',
  CAPTURE_STOPPED: 'offscreen/capture-stopped',
  CAPTURE_ERROR: 'offscreen/capture-error',
  TRANSCRIPT_PARTIAL: 'offscreen/transcript-partial', // interim STT, not sent to engine
  TRANSCRIPT_FINAL: 'offscreen/transcript-final',     // finalized utterance, ingested

  // --- service worker -> side panel (broadcast state) ---
  STATE_CHANGED: 'sidepanel/state-changed',
  TRANSCRIPT_APPEND: 'sidepanel/transcript-append',
  COACHING_UPDATE: 'sidepanel/coaching-update', // engine ingestion response, rendered live
  SESSION_ERROR: 'sidepanel/session-error',
});

// Session lifecycle states surfaced to the UI.
export const SessionState = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  LISTENING: 'listening',
  STOPPING: 'stopping',
  ERROR: 'error',
});

/**
 * Build a well-formed message envelope.
 * @param {string} target - one of Target
 * @param {string} type - one of MsgType
 * @param {object} [payload]
 * @returns {{target:string,type:string,payload:object,ts:number}}
 */
export function msg(target, type, payload = {}) {
  return { target, type, payload, ts: Date.now() };
}

/**
 * Register a filtered runtime message listener. Only invokes `handler` for messages
 * addressed to `self`. Supports async handlers that resolve a response.
 * @param {string} self - one of Target (who am I)
 * @param {(message:object, sender:object)=>(any|Promise<any>)} handler
 * @returns {() => void} unsubscribe
 */
export function onMessage(self, handler) {
  const listener = (message, sender, sendResponse) => {
    if (!message || message.target !== self) return false;
    const result = handler(message, sender);
    if (result instanceof Promise) {
      result.then((r) => sendResponse(r)).catch((e) => sendResponse({ error: String(e) }));
      return true; // keep the channel open for the async response
    }
    if (result !== undefined) sendResponse(result);
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
