// sidepanel.js
// The rep-facing surface. It sends user intent to the service worker and renders what
// comes back: live transcript + the engine's coaching. It contains NO capture, NO STT,
// NO engine logic — it's a thin view over messages.

import { Target, MsgType, SessionState, msg, onMessage } from '../common/messaging.js';

const el = {
  status: document.getElementById('status'),
  statusText: document.getElementById('statusText'),
  dealId: document.getElementById('dealId'),
  toggle: document.getElementById('toggleBtn'),
  channels: document.getElementById('channels'),
  hint: document.getElementById('hint'),
  coaching: document.getElementById('coaching'),
  transcript: document.getElementById('transcript'),
};

let state = SessionState.IDLE;
let partialEls = { them: null, us: null }; // live interim line per channel

function sw(type, payload) {
  return chrome.runtime.sendMessage(msg(Target.SW, type, payload)).catch(() => ({}));
}

// --- Rendering -------------------------------------------------------------

const STATE_LABEL = {
  idle: 'Idle', starting: 'Starting…', listening: 'Listening', stopping: 'Stopping…', error: 'Error',
};

function renderState(next, session) {
  state = next;
  el.status.dataset.state = next;
  el.statusText.textContent = STATE_LABEL[next] || next;
  const on = next === SessionState.LISTENING || next === SessionState.STARTING;
  el.toggle.textContent = on ? 'Stop listening' : 'Start listening';
  el.toggle.dataset.on = String(on);
  el.dealId.disabled = on;
  if (session?.startedChannels) {
    el.channels.innerHTML = session.startedChannels
      .map((c) => `<span class="chip ${c}">${c === 'them' ? '● them (tab)' : '● us (mic)'}</span>`)
      .join('');
  }
  if (next === SessionState.IDLE) el.channels.innerHTML = '';
}

function appendTranscript({ final, note, partial }) {
  if (!final && partial) {
    // update-or-create the interim line for this channel
    const ch = partial.channel;
    let node = partialEls[ch];
    if (!node) {
      node = document.createElement('div');
      node.className = `line ${ch} partial`;
      node.innerHTML = `<span class="who"></span><span class="txt"></span>`;
      el.transcript.appendChild(node);
      partialEls[ch] = node;
    }
    node.querySelector('.who').textContent = who(ch, partial.speakerLabel);
    node.querySelector('.txt').textContent = partial.text;
    scroll();
    return;
  }
  // finalized line: clear the matching partial and commit a solid line
  const ch = note.speaker.channel;
  if (partialEls[ch]) { partialEls[ch].remove(); partialEls[ch] = null; }
  const node = document.createElement('div');
  node.className = `line ${ch}`;
  node.innerHTML = `<span class="who"></span><span class="txt"></span>`;
  node.querySelector('.who').textContent = who(ch, note.speaker.label);
  node.querySelector('.txt').textContent = note.text;
  el.transcript.appendChild(node);
  scroll();
}

function who(channel, label) {
  const base = channel === 'us' ? 'You' : 'Them';
  return label ? `${base} · ${label}` : base;
}

function scroll() { el.transcript.scrollTop = el.transcript.scrollHeight; }

// Render the engine's coaching response. The exact shape is owned by the engine; we
// render the fields we expect and fall back to raw JSON for anything else, so new engine
// output never silently disappears.
function renderCoaching({ coaching, dryRun }) {
  if (dryRun) {
    el.coaching.innerHTML = `<div class="dry">Dry-run: no ingestUrl configured. The note object was logged to the service-worker console instead of being sent to the engine. Set <code>ingestUrl</code> to see live coaching.</div>`;
    return;
  }
  if (!coaching) return;
  const parts = [];

  if (coaching.nextBestAction) {
    const nba = coaching.nextBestAction;
    parts.push(`<div class="nba"><span class="k">Next best action</span><p>${esc(nba.say || nba.text || nba.action || String(nba))}</p></div>`);
  }
  if (Array.isArray(coaching.stakeholderReads) && coaching.stakeholderReads.length) {
    const reads = coaching.stakeholderReads.map((r) => {
      const stance = (r.stance || r.persona || '').toLowerCase();
      return `<div class="read ${stance}"><span class="who">${esc(r.stance || r.persona || 'read')}</span><span class="name">${esc(r.name || r.contact || 'Unknown')}</span></div>`;
    }).join('');
    parts.push(`<div class="reads">${reads}</div>`);
  }
  if (coaching.meddpicc && typeof coaching.meddpicc === 'object') {
    const rows = Object.entries(coaching.meddpicc)
      .map(([k, v]) => `<span class="lbl">${esc(k)}</span><span>${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</span>`)
      .join('');
    parts.push(`<div class="meddpicc">${rows}</div>`);
  }

  if (parts.length === 0) {
    parts.push(`<pre class="dry">${esc(JSON.stringify(coaching, null, 2))}</pre>`);
  }
  el.coaching.innerHTML = parts.join('');
}

function showError({ level, error, status }) {
  el.hint.textContent = `${status ? `[${status}] ` : ''}${error}`;
  if (level === 'error') el.hint.style.color = 'var(--red)';
  else el.hint.style.color = 'var(--amber)';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Intent ----------------------------------------------------------------

el.toggle.addEventListener('click', async () => {
  el.hint.textContent = '';
  if (state === SessionState.LISTENING || state === SessionState.STARTING) {
    await sw(MsgType.STOP_SESSION, {});
  } else {
    el.transcript.innerHTML = '';
    el.coaching.innerHTML = '<p class="empty">Listening… coaching will appear as the call unfolds.</p>';
    await sw(MsgType.START_SESSION, { dealId: el.dealId.value.trim() || null });
  }
});

// --- Inbound messages ------------------------------------------------------

onMessage(Target.SIDEPANEL, (message) => {
  switch (message.type) {
    case MsgType.STATE_CHANGED:
      renderState(message.payload.state, message.payload.session);
      break;
    case MsgType.TRANSCRIPT_APPEND:
      appendTranscript(message.payload);
      break;
    case MsgType.COACHING_UPDATE:
      renderCoaching(message.payload);
      break;
    case MsgType.SESSION_ERROR:
      showError(message.payload);
      break;
    default:
      return undefined;
  }
  return undefined;
});

// Re-sync on open (the SW may have been running before the panel opened).
sw(MsgType.GET_STATE, {}).then((res) => {
  if (res?.session) renderState(res.session.state, res.session);
});
