// config.js
// Runtime configuration for the listener. Everything an operator might need to change
// without touching logic lives here (or in chrome.storage, which overrides these
// defaults at load time). Nothing here is secret-by-design: the ingestion endpoint is
// authenticated with the user's session token, and the STT key is fetched at runtime
// (see stt-adapter). Do not commit real keys.

export const DEFAULTS = Object.freeze({
  // --- Ingestion: THE single seam into the existing engine -------------------
  // This is the ONE entry point audio shares with the paste-notes path. It must point
  // at the same Cloud Function that the paste path calls. See ingest-client.js and the
  // README "Wiring to the engine" section. When empty, the client runs in dry-run mode
  // (logs the note object instead of POSTing) so the capture pipeline is testable
  // standalone.
  ingestUrl: '',

  // --- STT provider selection ------------------------------------------------
  // Swappable. 'mock' needs no network and is the default so the extension loads and
  // runs end-to-end offline. Switch to a real provider id here or via chrome.storage.
  sttProvider: 'mock', // 'mock' | 'deepgram' | ...

  // Audio framing sent to the STT provider.
  audio: {
    sampleRate: 16000,
    // ms of audio per chunk pushed to the streaming STT socket
    chunkMs: 250,
  },

  // How long a "them" or "us" utterance can pause before we finalize it and ingest.
  // Finalization is normally driven by the STT provider's is_final flag; this is a
  // fallback so a note object still flows if the provider never flushes.
  utteranceMaxSilenceMs: 1200,

  // --- Session context -------------------------------------------------------
  // The deal/contact this call belongs to. Set by the side panel before START.
  // Carried on every note object so the engine recalibrates the right deal.
  dealId: null,
});

const STORAGE_KEY = 'salesogre.listener.config';

/**
 * Load config: DEFAULTS overlaid with any operator overrides in chrome.storage.local.
 * @returns {Promise<typeof DEFAULTS>}
 */
export async function loadConfig() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return { ...DEFAULTS, ...(stored[STORAGE_KEY] || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Persist a partial config override.
 * @param {Partial<typeof DEFAULTS>} partial
 */
export async function saveConfig(partial) {
  const current = await loadConfig();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}
