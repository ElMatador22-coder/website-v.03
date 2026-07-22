// ingest-client.js
// THE ONE SEAM. Every note object — live audio here, and (by design) the paste path in
// the main app — must flow through a single ingestion function. On the client side this
// module is that seam: it POSTs the note object to the engine's ingestion endpoint and
// returns the engine's response (persona reads, MEDDPICC deltas, next-best-action).
//
// It contains NO engine logic. It does not decide anything about the deal. It ships the
// note object and relays the answer. If the live path ever needs richer behavior, the
// behavior belongs in the shared engine behind this endpoint — never reimplemented here.
//
// Auth: the ingestion endpoint enforces entitlements + caps server-side (that boundary
// is already built). This client just attaches the caller's bearer token if present.

/**
 * @typedef {object} IngestResult
 * @property {boolean} ok
 * @property {object|null} coaching - engine response payload (whatever the paste path
 *   ingestion returns: stakeholder reads, MEDDPICC fields, next-best-action, etc.)
 * @property {string} [error]
 * @property {number} [status]
 */

/**
 * Send one note object to the shared ingestion function.
 *
 * @param {object} note - product of buildNote()
 * @param {object} opts
 * @param {string} opts.ingestUrl - the single ingestion endpoint (same as paste path)
 * @param {string} [opts.authToken] - bearer token for the user's session
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<IngestResult>}
 */
export async function ingestNote(note, { ingestUrl, authToken, signal } = {}) {
  // Dry-run mode: no endpoint wired yet. Keeps the whole capture->STT->note pipeline
  // testable standalone without a backend. The README calls this out explicitly.
  if (!ingestUrl) {
    console.info('[ingest] DRY RUN (no ingestUrl configured). Note object:', note);
    return { ok: true, coaching: null, dryRun: true };
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    const res = await fetch(ingestUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(note),
      signal,
    });

    if (!res.ok) {
      // 402/403 here is the entitlements/caps boundary talking. Surface it verbatim so
      // the side panel can show "you've hit your live-listening cap" rather than a
      // generic failure.
      let detail = '';
      try { detail = await res.text(); } catch { /* ignore */ }
      return { ok: false, coaching: null, status: res.status, error: detail || res.statusText };
    }

    const coaching = await res.json().catch(() => null);
    return { ok: true, coaching, status: res.status };
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, coaching: null, error: 'aborted' };
    return { ok: false, coaching: null, error: String(err) };
  }
}
