// transcript-buffer.js
// Turns a stream of STT results (partial + final) into finalized utterances ready to
// become note objects. One buffer instance per live session; it tracks each channel
// ("them"/"us") independently and assigns a monotonic sequence number across both so
// the engine can order the call's utterances.
//
// This is plumbing, not engine work: no signal matching, no interpretation. It only
// decides "this utterance is done, ingest it."

import { Channel } from '../common/messaging.js';

export class TranscriptBuffer {
  /**
   * @param {object} opts
   * @param {number} opts.maxSilenceMs - finalize a channel's pending text after this idle gap
   * @param {(utterance:object)=>void} opts.onFinal - called with a finalized utterance
   */
  constructor({ maxSilenceMs, onFinal }) {
    this.maxSilenceMs = maxSilenceMs;
    this.onFinal = onFinal;
    this._seq = 0;
    // per-channel pending state
    this._pending = {
      [Channel.THEM]: this._empty(),
      [Channel.US]: this._empty(),
    };
    this._timers = { [Channel.THEM]: null, [Channel.US]: null };
  }

  _empty() {
    return { text: '', speakerLabel: null, confidence: null, sttProvider: 'unknown' };
  }

  /**
   * Feed one STT result into the buffer.
   * @param {object} r
   * @param {string} r.channel - Channel.THEM | Channel.US
   * @param {string} r.text - transcript text for this result
   * @param {boolean} r.isFinal - provider says this segment is finalized
   * @param {string|null} [r.speakerLabel] - sub-speaker label within "them"
   * @param {number|null} [r.confidence]
   * @param {string} [r.sttProvider]
   * @returns {{partial?:object, finalized?:boolean}} for the caller to relay interim text
   */
  push({ channel, text, isFinal, speakerLabel = null, confidence = null, sttProvider = 'unknown' }) {
    if (channel !== Channel.THEM && channel !== Channel.US) return {};
    const p = this._pending[channel];

    if (isFinal) {
      // Provider finalized this segment. Merge and flush immediately.
      p.text = this._join(p.text, text);
      p.speakerLabel = speakerLabel ?? p.speakerLabel;
      p.confidence = confidence ?? p.confidence;
      p.sttProvider = sttProvider;
      this._flush(channel);
      return { finalized: true };
    }

    // Interim result: keep the latest partial for display, arm the silence fallback.
    p.speakerLabel = speakerLabel ?? p.speakerLabel;
    p.confidence = confidence ?? p.confidence;
    p.sttProvider = sttProvider;
    p._interim = text;
    this._armSilenceTimer(channel);
    return { partial: { channel, text, speakerLabel: p.speakerLabel } };
  }

  _armSilenceTimer(channel) {
    clearTimeout(this._timers[channel]);
    this._timers[channel] = setTimeout(() => {
      // Provider never sent is_final; finalize whatever we last saw so a note still flows.
      const p = this._pending[channel];
      if (p._interim) p.text = this._join(p.text, p._interim);
      this._flush(channel);
    }, this.maxSilenceMs);
  }

  _flush(channel) {
    clearTimeout(this._timers[channel]);
    this._timers[channel] = null;
    const p = this._pending[channel];
    const text = (p.text || '').trim();
    // reset channel before invoking callback (callback may re-enter)
    const finalized = {
      channel,
      text,
      speakerLabel: p.speakerLabel,
      confidence: p.confidence,
      sttProvider: p.sttProvider,
      seq: this._seq,
    };
    this._pending[channel] = this._empty();
    if (!text) return; // nothing meaningful captured; don't burn a seq or an ingest
    this._seq += 1;
    this.onFinal(finalized);
  }

  _join(a, b) {
    if (!a) return b || '';
    if (!b) return a;
    return `${a} ${b}`.replace(/\s+/g, ' ');
  }

  /** Finalize everything still pending (call on session stop). */
  drain() {
    this._flush(Channel.THEM);
    this._flush(Channel.US);
  }

  dispose() {
    clearTimeout(this._timers[Channel.THEM]);
    clearTimeout(this._timers[Channel.US]);
  }
}
