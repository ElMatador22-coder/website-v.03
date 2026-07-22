// note-object.js
// ============================================================================
// THE SHARED CONTRACT. This is the whole point of the listener.
//
// The listener is NOT a new engine. It is a new INPUT ADAPTER. The paste-notes path
// produces a "note object" that flows into the engine (sentence split -> signal
// matching -> stance reads -> persona suggestion -> contact-hub stance log -> deal
// recalibration -> MEDDPICC -> no-decision checks). Audio must normalize into the SAME
// note object and hit the SAME ingestion entry point.
//
// This module is the single definition of that object on the client side. It does NO
// engine work — no sentence splitting, no signal matching, no stance reads. It only
// packages captured transcript text into the shape the engine already consumes.
//
// >>> WIRING NOTE <<<
// The field set below MUST be reconciled with the note object the paste path sends to
// the engine's ingestion function. `text` + `dealId` + `source` are assumed to be the
// primary inputs the engine reads (same as paste). Everything else is additive metadata
// the engine MAY use (speaker attribution for the contact-hub stance log, sessionId for
// threading a live call's utterances). If the real paste note uses different field
// names, change them HERE ONLY — every producer in this extension goes through
// buildNote(), so there is exactly one place to keep the contract honest.
// ============================================================================

import { Channel } from '../common/messaging.js';

export const NOTE_SCHEMA_VERSION = 'note.v1';

// Source discriminator. The paste path uses 'paste'; audio uses 'live_audio'. Same
// engine, same ingestion function, two tempos.
export const NoteSource = Object.freeze({
  PASTE: 'paste',
  LIVE_AUDIO: 'live_audio',
});

/**
 * Map a captured channel to the buyer/rep role the engine's stance logic expects.
 * "them" (tabCapture) = the buying committee; "us" (mic) = the rep.
 * @param {string} channel - one of Channel
 * @returns {'buyer'|'rep'}
 */
export function channelToRole(channel) {
  return channel === Channel.US ? 'rep' : 'buyer';
}

/**
 * Build a note object from a finalized transcript utterance. This is the ONLY function
 * that constructs the ingestion payload for the live path.
 *
 * @param {object} args
 * @param {string} args.text            - finalized utterance text (what the engine splits/matches)
 * @param {string} args.channel         - Channel.THEM | Channel.US
 * @param {string|null} args.dealId     - deal this call belongs to (engine recalibration target)
 * @param {string} args.sessionId       - groups all utterances of one live call
 * @param {number} args.seq             - monotonically increasing index within the session
 * @param {string|null} [args.speakerLabel] - STT-provided sub-speaker label within "them", else null
 * @param {number|null} [args.confidence]   - STT confidence 0..1, if provided
 * @param {string} [args.sttProvider]   - provider id that produced this text
 * @param {string} [args.capturedAt]    - ISO timestamp; defaults to now
 * @returns {object} note object
 */
export function buildNote({
  text,
  channel,
  dealId,
  sessionId,
  seq,
  speakerLabel = null,
  confidence = null,
  sttProvider = 'unknown',
  capturedAt = new Date().toISOString(),
}) {
  return {
    schemaVersion: NOTE_SCHEMA_VERSION,
    // Client-generated idempotency key. Lets the ingestion function dedupe retries
    // without double-recalibrating the deal.
    noteId: `${sessionId}:${seq}`,

    // --- Primary inputs (parity with the paste path) ---
    dealId: dealId ?? null,
    source: NoteSource.LIVE_AUDIO,
    tempo: 'live', // paste path is 'batch'
    text: (text || '').trim(),

    // --- Additive metadata the engine MAY use ---
    speaker: {
      channel,                       // 'them' | 'us'
      role: channelToRole(channel),  // 'buyer' | 'rep'
      label: speakerLabel,           // sub-speaker within "them", if STT gave one
    },
    session: {
      sessionId,
      seq,
    },
    capture: {
      capturedAt,
      sttProvider,
      confidence,
    },
  };
}

/**
 * Minimal client-side validation before we spend a network call. The engine remains the
 * source of truth for validity; this only catches empty/garbage utterances so we don't
 * ingest silence.
 * @param {object} note
 * @returns {{ok:boolean, reason?:string}}
 */
export function validateNote(note) {
  if (!note || typeof note !== 'object') return { ok: false, reason: 'not-an-object' };
  if (!note.text || note.text.length === 0) return { ok: false, reason: 'empty-text' };
  if (!note.session?.sessionId) return { ok: false, reason: 'missing-session' };
  if (!note.speaker?.channel) return { ok: false, reason: 'missing-channel' };
  return { ok: true };
}
