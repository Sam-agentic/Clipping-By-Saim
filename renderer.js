/**
 * renderer.js — Clipping by Saim
 *
 * One job only: a YouTube link goes in, the AI picks the strongest moments,
 * the user gives each clip its own background music and look, the clips are
 * exported to a folder of their choice and the temporary project is deleted.
 *
 * This is a flat script (no modules, no bundler), so every el(id) used here has
 * to exist in index.html — one missing id throws while loading and silently
 * kills every statement below it.
 */

const el = (id) => document.getElementById(id);

/**
 * The preload bridge.
 *
 * This must NOT be called `api`. preload.js publishes it with
 * contextBridge.exposeInMainWorld('api', …), which defines `api` as a
 * non-configurable property of window — so a top-level `const api = …` in this
 * classic script is an instant SyntaxError ("Identifier 'api' has already been
 * declared") and *nothing* in the file runs. That is exactly what made every
 * button dead while the window still looked perfectly normal.
 */
const bridge = window.api || {};

/**
 * Attach a listener without betting the whole script on one id.
 *
 * This file is a flat script, so `el('typo').addEventListener(...)` used to
 * throw and silently kill every line below it — the window looked fine and no
 * button worked. Now a missing id costs that one button and nothing else.
 */
function on(id, event, handler) {
  const node = el(id);
  if (!node) {
    console.warn(`renderer.js: #${id} is not in index.html, so "${event}" was not connected.`);
    return;
  }
  node.addEventListener(event, handler);
}

const state = {
  tool: 'saim',
  saim: {
    project: null,      // whatever clip-analyze returned
    clips: [],          // per-clip UI state, aligned with project.clips
    rendered: [],       // whatever clip-render returned
    failed: [],
    exportDir: null,
    exportName: '',
    busy: false,
    leftover: null      // a project an earlier session left behind on disk
  },
  shorts: { videoPath: null, musicPath: null }
};

// Cheap per-pixel looks — these keys must match LOOKS in python/clip_renderer.py.
const FILTERS = [
  ['none', 'Original look'],
  ['vivid', 'Vivid'],
  ['warm', 'Warm'],
  ['cool', 'Cool'],
  ['cinematic', 'Cinematic'],
  ['bright', 'Bright'],
  ['bw', 'Black & white'],
  ['sharp', 'Sharp'],
  ['soft', 'Soft glow'],
  ['moody', 'Moody'],
  ['golden', 'Golden hour'],
  ['teal_orange', 'Teal & orange'],
  ['pastel', 'Pastel'],
  ['dream', 'Dreamy'],
  ['noir', 'Noir'],
  ['vhs', 'VHS'],
  ['grain', 'Film grain'],
  ['neon', 'Neon punch'],
  ['fade', 'Faded film'],
  ['vignette', 'Vignette']
];

// Caption templates. The keys, and the look each one stands for, must stay in
// step with CAPTION_TEMPLATES in python/clip_renderer.py (that is what actually
// gets burned in) and CAPTION_TEMPLATE_KEYS in main.js (the IPC whitelist).
// The fields here only drive the preview tiles, so they are ordinary web
// colours rather than the byte-reversed BGR that ASS wants.
const FONT_IMPACT = 'Impact, "Arial Narrow Bold", sans-serif';
const FONT_BLACK = '"Arial Black", Gadget, sans-serif';

const CAPTION_TEMPLATES = [
  { key: 'bold', label: 'Bold (viral)', group: 'Classic', font: FONT_IMPACT,
    color: '#ffffff', stroke: 2.6, upper: true, size: 1.18 },
  { key: 'boxed', label: 'Boxed', group: 'Classic', font: FONT_BLACK,
    color: '#ffffff', box: 'rgba(0,0,0,0.37)', stroke: 0, upper: false, size: 1 },
  { key: 'clean', label: 'Clean', group: 'Classic', font: 'Arial, sans-serif',
    color: '#ffffff', stroke: 1.2, weight: 400, size: 0.92, words: 5 },

  { key: 'karaoke', label: 'Karaoke yellow', group: 'Word by word', font: FONT_BLACK,
    color: '#ffffff', accent: '#ffe500', stroke: 2.2, upper: true, size: 1.08 },
  { key: 'karaoke_green', label: 'Karaoke green', group: 'Word by word', font: FONT_BLACK,
    color: '#ffffff', accent: '#70e040', stroke: 2.2, upper: true, size: 1.08 },
  { key: 'hormozi', label: 'Big yellow pop', group: 'Word by word', font: FONT_IMPACT,
    color: '#ffffff', accent: '#ffd900', stroke: 3, upper: true, size: 1.22 },
  { key: 'beast', label: 'Red highlight', group: 'Word by word', font: FONT_BLACK,
    color: '#ffffff', accent: '#ff3030', stroke: 3, upper: true, size: 1.18 },
  { key: 'pop_word', label: 'One word, centre', group: 'Word by word', font: FONT_IMPACT,
    color: '#ffffff', stroke: 3, upper: true, size: 1.5, align: 'middle', words: 1 },
  { key: 'one_word', label: 'One word, fade', group: 'Word by word', font: FONT_BLACK,
    color: '#ffffff', stroke: 2.6, upper: true, size: 1.4, words: 1 },
  { key: 'neon', label: 'Neon', group: 'Colour', font: FONT_BLACK,
    color: '#00ffff', accent: '#ff40ff', outline: '#400080', stroke: 2.2,
    upper: true, size: 1.08 },
  { key: 'sunset', label: 'Sunset', group: 'Colour', font: FONT_BLACK,
    color: '#ffc040', outline: '#401020', stroke: 2.2, upper: true, size: 1.08 },
  { key: 'yellow', label: 'Classic yellow', group: 'Colour', font: FONT_BLACK,
    color: '#ffe000', stroke: 2.2, upper: true, size: 1 },
  { key: 'mint', label: 'Mint', group: 'Colour', font: 'Verdana, sans-serif',
    color: '#d0ffc0', outline: '#203020', stroke: 1.6, size: 0.98, words: 4 },
  { key: 'alert', label: 'Red bar', group: 'Colour', font: FONT_BLACK,
    color: '#ffffff', box: 'rgba(208,32,32,0.88)', stroke: 0, upper: true, size: 0.98 },
  { key: 'sticker', label: 'White sticker', group: 'Colour', font: FONT_BLACK,
    color: '#101010', box: 'rgba(240,240,240,0.94)', stroke: 0, upper: true, size: 0.94 },

  { key: 'podcast', label: 'Podcast', group: 'Quiet', font: 'Verdana, sans-serif',
    color: '#ffffff', box: 'rgba(0,0,0,0.56)', stroke: 0, weight: 400,
    size: 0.86, words: 6 },
  { key: 'tiktok', label: 'Small box, raised', group: 'Quiet', font: 'Arial, sans-serif',
    color: '#ffffff', box: 'rgba(0,0,0,0.69)', stroke: 0, size: 0.9, words: 4,
    align: 'raised' },
  { key: 'minimal', label: 'Minimal', group: 'Quiet', font: '"Segoe UI", sans-serif',
    color: '#ffffff', stroke: 0, shadow: true, weight: 400, size: 0.82, words: 5 },
  { key: 'serif', label: 'Serif italic', group: 'Quiet', font: 'Georgia, serif',
    color: '#fff8dc', stroke: 1.2, italic: true, weight: 400, size: 0.86, words: 5 },
  { key: 'mono', label: 'Terminal', group: 'Quiet', font: '"Courier New", monospace',
    color: '#60ff60', box: 'rgba(0,0,0,0.81)', stroke: 0, size: 0.82, words: 5 },
  { key: 'news', label: 'News strap', group: 'Quiet', font: '"Franklin Gothic Medium", sans-serif',
    color: '#ffffff', box: 'rgba(16,16,48,0.81)', stroke: 0, upper: true,
    size: 0.86, align: 'low' },

  { key: 'top', label: 'Bold, at the top', group: 'Placement', font: FONT_IMPACT,
    color: '#ffffff', stroke: 2.6, upper: true, size: 1.1, align: 'top' },
  { key: 'top_box', label: 'Box, at the top', group: 'Placement', font: FONT_BLACK,
    color: '#ffffff', box: 'rgba(0,0,0,0.44)', stroke: 0, size: 0.94,
    align: 'top', words: 4 },
  { key: 'middle', label: 'Centre of frame', group: 'Placement', font: FONT_BLACK,
    color: '#ffffff', accent: '#ffe500', stroke: 2.6, upper: true, size: 1.2,
    align: 'middle' }
];

// Both dropdowns are built from the table above, plus the one entry that is not
// a template at all.
const CAPTION_CHOICES = CAPTION_TEMPLATES
  .map((tpl) => [tpl.key, tpl.label])
  .concat([['off', 'No captions']]);
// What the progress bar should say for each stage main.js reports.
const STAGE_LABELS = {
  start: 'Getting ready',
  probe: 'Reading the video details',
  download: 'Downloading the video',
  audio: 'Extracting the audio',
  transcribe: 'Listening to the speech',
  highlight: 'Finding the best moments',
  clips: 'Cutting the clips',
  export: 'Exporting',
  done: 'Finished',
  cancelled: 'Cancelled',
  error: 'Something went wrong'
};

const TOOL_TITLES = { saim: 'Clipping', clips: 'Shorts' };

const TOOL_CARDS = {
  saim: [
    ['\u{1F517}', 'Paste a link', 'Any public YouTube video'],
    ['\u{1F9E0}', 'AI picks', 'Hooks, energy and pace'],
    ['\u{1F3B5}', 'Your music', 'A different track per clip'],
    ['\u{1F4E4}', 'Export', 'Then the temp files go']
  ],
  clips: [
    ['\u{1F4C2}', 'Local file', 'Cut a video you already have'],
    ['\u{1F4D0}', 'Any ratio', '9:16, 1:1 or 16:9'],
    ['⏱', 'Fixed length', 'Evenly spaced clips']
  ]
};

/* ------------------------------------------------------------------ helpers */

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins < 60) return `${mins}:${String(secs).padStart(2, '0')}`;
  const hours = Math.floor(mins / 60);
  return `${hours}:${String(mins % 60).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}
function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function setStatus(text) {
  const bar = el('statusText');
  if (bar) bar.textContent = text;
}

function saimSay(text) {
  const line = el('saimStatus');
  if (line) line.textContent = text;
  setStatus(text);
}

/** Rolling log under the controls. Kept short so it never eats the panel. */
function logLine(text) {
  const box = el('progressLog');
  if (!box) return;
  box.classList.remove('hidden');
  const row = document.createElement('div');
  row.textContent = text;
  box.appendChild(row);
  while (box.childElementCount > 60) box.removeChild(box.firstElementChild);
  box.scrollTop = box.scrollHeight;
}

function clearLog() {
  const box = el('progressLog');
  if (!box) return;
  box.textContent = '';
  box.classList.add('hidden');
}

function showProgress(percent) {
  const wrap = el('saimProgressWrap');
  const bar = el('saimProgressBar');
  if (wrap) wrap.classList.remove('hidden');
  if (bar) bar.style.width = `${clamp(Number(percent) || 0, 0, 100)}%`;
}

function hideProgress() {
  const wrap = el('saimProgressWrap');
  const bar = el('saimProgressBar');
  if (wrap) wrap.classList.add('hidden');
  if (bar) bar.style.width = '0%';
}

/* --------------------------------------------------------- protected access */

function setLicenseMessage(message) { setText('licenseMessage', message); }

function showLicenseGate(status) {
  toggleHidden('licenseGate', false);
  setLicenseMessage((status && status.reason) || 'Sign in with your approved email to continue.');
}

function unlockLicense(status) {
  toggleHidden('licenseGate', true);
  const user = el('licenseUser');
  if (user && status && status.email) {
    user.textContent = status.email;
    user.classList.remove('hidden');
    toggleHidden('licenseSignOutBtn', false);
    // This only controls visibility. The server independently checks the
    // profile role, so changing the UI can never grant owner permissions.
    if (status.email.toLowerCase() === 'saimabdullah310@gmail.com') {
      toggleHidden('ownerAccessBtn', false);
    }
  }
}

async function checkLicense() {
  if (typeof bridge.licenseStatus !== 'function') return;
  const status = await bridge.licenseStatus();
  if (status && status.allowed) unlockLicense(status);
  else if (status && status.required) showLicenseGate(status);
}

on('licenseSignInBtn', 'click', async () => {
  const email = (el('licenseEmail').value || '').trim();
  const password = el('licensePassword').value || '';
  if (!email || !password) return setLicenseMessage('Enter both your approved email and password.');
  el('licenseSignInBtn').disabled = true;
  setLicenseMessage('Verifying your secure access…');
  const result = await callMain('licenseSignIn', { email, password });
  el('licenseSignInBtn').disabled = false;
  if (result && result.allowed) {
    unlockLicense(result);
    // The trial-mode banner is computed at start-up while the user is still
    // signed out, so it would keep showing until the app restarts. Re-check it
    // now that the license is verified so the "Trial mode — 3 clips max" message
    // disappears as soon as a valid owner/customer signs in.
    await checkTrialStatus();
    return;
  }
  setLicenseMessage((result && (result.reason || result.error)) || 'Sign-in was not approved.');
});

on('licenseRequestBtn', 'click', async () => {
  const email = (el('licenseEmail').value || '').trim();
  if (!email) return setLicenseMessage('Enter your email first, then request access.');
  el('licenseRequestBtn').disabled = true;
  const result = await callMain('licenseRequestAccess', email);
  el('licenseRequestBtn').disabled = false;
  setLicenseMessage(result && result.success
    ? 'Request sent. Your administrator will approve the email, then you will receive an English invitation email.'
    : ((result && result.error) || 'Could not send the request.'));
});

on('licenseSignOutBtn', 'click', async () => {
  await callMain('licenseSignOut');
  toggleHidden('licenseUser', true);
  toggleHidden('licenseSignOutBtn', true);
  toggleHidden('ownerAccessBtn', true);
  showLicenseGate({ reason: 'You have been signed out.' });
});

on('ownerAccessBtn', 'click', () => {
  toggleHidden('ownerGate', false);
  setText('ownerMessage', 'Approve an email to send its English invitation email.');
});

on('ownerCloseBtn', 'click', () => toggleHidden('ownerGate', true));

on('ownerApproveBtn', 'click', async () => {
  const email = (el('ownerCustomerEmail').value || '').trim();
  const deviceLimit = Number(el('ownerDeviceLimit').value) || 2;
  if (!email) return setText('ownerMessage', 'Enter the customer email address first.');
  el('ownerApproveBtn').disabled = true;
  setText('ownerMessage', 'Approving secure access and sending the invitation…');
  const result = await callMain('licenseApproveCustomer', { email, deviceLimit });
  el('ownerApproveBtn').disabled = false;
  setText('ownerMessage', result && result.success
    ? 'Approved. The customer invitation email was sent in English.'
    : ((result && result.error) || 'Approval could not be completed.'));
});

/* --------------------------------------------------- owner admin dashboard  */

async function refreshOwnerRequests() {
  const result = await callMain('licenseListRequests');
  const box = el('ownerRequestsList');
  if (!box) return;
  box.textContent = '';
  if (!result || !result.success) {
    const row = document.createElement('div');
    row.className = 'owner-row';
    row.textContent = (result && result.error) || 'Could not load requests.';
    box.appendChild(row);
    return;
  }
  const requests = (result.requests || []).filter((r) => !r.approved_at);
  if (!requests.length) {
    const row = document.createElement('div');
    row.className = 'owner-row';
    row.textContent = 'No pending requests.';
    box.appendChild(row);
    return;
  }
  requests.forEach((request) => {
    const row = document.createElement('div');
    row.className = 'owner-row';
    const info = document.createElement('span');
    info.textContent = `${request.email} — ${request.app_version || 'unknown version'} (${new Date(request.requested_at).toLocaleString()})`;
    const approve = document.createElement('button');
    approve.className = 'owner-action';
    approve.textContent = 'Approve';
    approve.addEventListener('click', async () => {
      approve.disabled = true;
      const result = await callMain('licenseApproveCustomer', { email: request.email, deviceLimit: 2 });
      approve.disabled = false;
      setText('ownerMessage', result && result.success
        ? `Approved ${request.email}. Invitation email sent.`
        : ((result && result.error) || 'Approval failed.'));
      refreshOwnerRequests();
    });
    row.append(info, approve);
    box.appendChild(row);
  });
}

async function refreshOwnerCustomers() {
  const result = await callMain('licenseListCustomers');
  const box = el('ownerCustomersList');
  if (!box) return;
  box.textContent = '';
  if (!result || !result.success) {
    const row = document.createElement('div');
    row.className = 'owner-row';
    row.textContent = (result && result.error) || 'Could not load customers.';
    box.appendChild(row);
    return;
  }
  const customers = result.customers || [];
  if (!customers.length) {
    const row = document.createElement('div');
    row.className = 'owner-row';
    row.textContent = 'No customers yet.';
    box.appendChild(row);
    return;
  }
  customers.forEach((customer) => {
    const row = document.createElement('div');
    row.className = 'owner-row';
    const info = document.createElement('span');
    info.textContent = `${customer.email} — ${customer.role} — ${customer.status} — ${customer.device_limit} device(s)`;
    const revoke = document.createElement('button');
    revoke.className = 'owner-action';
    revoke.textContent = customer.status === 'revoked' ? 'Activate' : 'Revoke';
    revoke.addEventListener('click', async () => {
      revoke.disabled = true;
      const result = await callMain('licenseRevokeCustomer', {
        email: customer.email,
        status: customer.status === 'revoked' ? 'active' : 'revoked'
      });
      revoke.disabled = false;
      setText('ownerMessage', result && result.success
        ? `${customer.email} is now ${customer.status === 'revoked' ? 'active' : 'revoked'}.`
        : ((result && result.error) || 'Update failed.'));
      refreshOwnerCustomers();
    });
    row.append(info, revoke);
    box.appendChild(row);
  });
}

on('ownerRefreshBtn', 'click', () => {
  refreshOwnerRequests();
  refreshOwnerCustomers();
  setText('ownerMessage', 'Dashboard refreshed.');
});

/* ------------------------------------------------------------- main bridge  */

/**
 * Every request to the main process goes through here.
 *
 * Before this existed, a missing bridge method or a rejected ipcRenderer.invoke
 * threw *inside* an async click handler. Nobody caught that promise, so the
 * window just sat there looking dead — no message, no unlocked buttons. Now the
 * failure comes back as an ordinary { success: false, error } result, which
 * every caller below already knows how to display.
 */
async function callMain(method, payload) {
  if (typeof bridge[method] !== 'function') {
    return {
      success: false,
      error: `The app bridge is missing "${method}" — close the window and start `
        + 'it again with npm start.'
    };
  }
  try {
    const result = await bridge[method](payload);
    if (result === undefined || result === null) {
      return { success: false, error: 'The main process did not answer.' };
    }
    return result;
  } catch (err) {
    return { success: false, error: (err && err.message) ? err.message : String(err) };
  }
}

/** Same idea for the file/folder pickers, which answer with an object or null. */
async function pickWithMain(method) {
  if (typeof bridge[method] !== 'function') {
    saimSay(`The app bridge is missing "${method}" — restart the app with npm start.`);
    return null;
  }
  try {
    return await bridge[method]();
  } catch (err) {
    saimSay(`The picker could not be opened: ${(err && err.message) || err}`);
    return null;
  }
}
/* --------------------------------------------------------------- tool tabs */

/** Show/hide by id without caring whether the id is on the page. */
function toggleHidden(id, hidden) {
  const node = el(id);
  if (node) node.classList.toggle('hidden', Boolean(hidden));
}

/** Same tolerance for text: a renamed id must not stop a whole click handler. */
function setText(id, text) {
  const node = el(id);
  if (node) node.textContent = text;
}

function renderToolCards() {
  const box = el('toolLibrary');
  if (!box) return;
  box.textContent = '';
  (TOOL_CARDS[state.tool] || []).forEach(([icon, title, note]) => {
    const card = document.createElement('div');
    card.className = 'library-card';
    const iconEl = document.createElement('span');
    iconEl.className = 'library-icon';
    iconEl.textContent = icon;
    const titleEl = document.createElement('span');
    titleEl.textContent = title;
    const noteEl = document.createElement('span');
    noteEl.style.color = '#7f8798';
    noteEl.textContent = note;
    card.append(iconEl, titleEl, noteEl);
    box.appendChild(card);
  });
}

function selectTool(tool) {
  state.tool = TOOL_TITLES[tool] ? tool : 'saim';
  document.querySelectorAll('.tool-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tool === state.tool);
  });
  const heading = el('toolTitle');
  if (heading) heading.textContent = TOOL_TITLES[state.tool];
  const isSaim = state.tool === 'saim';
  toggleHidden('saimSection', !isSaim);
  toggleHidden('clipMakerSection', isSaim);
  toggleHidden('saimClipsWrap', !isSaim || !state.saim.clips.length);
  // Export, the delete button and the log sit outside #saimSection, so they have
  // to follow the tab too or they would hang around under the Shorts panel.
  toggleHidden('saimExportWrap', !isSaim || !state.saim.rendered.length);
  toggleHidden('saimDiscardBtn', !isSaim || !(state.saim.project || state.saim.leftover));
  const log = el('progressLog');
  toggleHidden('progressLog', !isSaim || !(log && log.childElementCount));
  renderToolCards();
}

document.querySelectorAll('.tool-tab').forEach((tab) => {
  tab.addEventListener('click', () => selectTool(tab.dataset.tool));
});
/* ----------------------------------------------------------------- preview */

const player = el('previewPlayer') || document.createElement('video');
let previewStopAt = 0;

function showPlayer() {
  player.style.display = 'block';
  toggleHidden('previewPlaceholder', true);
}

function loadPreview(url, startAt, stopAt) {
  if (!url) return;
  showPlayer();
  previewStopAt = Number(stopAt) || 0;
  const begin = Math.max(0, Number(startAt) || 0);
  const seek = () => {
    try { player.currentTime = begin; } catch (_) { /* not seekable yet */ }
    player.play().catch(() => { /* the user can press play */ });
  };
  if (player.dataset.src === url) {
    seek();
    return;
  }
  player.dataset.src = url;
  player.src = url;
  player.addEventListener('loadedmetadata', seek, { once: true });
}

player.addEventListener('timeupdate', () => {
  const total = Number.isFinite(player.duration) ? player.duration : 0;
  const readout = el('timeDisplay');
  if (readout) {
    readout.textContent = `${formatTime(player.currentTime)} / ${formatTime(total)}`;
  }
  if (previewStopAt && player.currentTime >= previewStopAt) {
    player.pause();
    previewStopAt = 0;
  }
});

player.addEventListener('play', () => { if (el('playBtn')) el('playBtn').textContent = '⏸'; });
player.addEventListener('pause', () => { if (el('playBtn')) el('playBtn').textContent = '▶'; });

on('playBtn', 'click', () => {
  if (!player.dataset.src) return;
  if (player.paused) player.play().catch(() => {}); else player.pause();
});

on('fitPreviewBtn', 'click', () => {
  const box = document.querySelector('.preview-box');
  if (box) box.classList.toggle('preview-fit');
});

on('fullscreenBtn', 'click', () => {
  if (player.requestFullscreen) player.requestFullscreen().catch(() => {});
});
/* ---------------------------------------------------------------- progress  */

if (bridge.onProgress) {
  bridge.onProgress((update) => {
    if (!update) return;
    const stage = String(update.stage || '');
    if (Number.isFinite(Number(update.percent))) showProgress(update.percent);

    const label = STAGE_LABELS[stage] || '';
    const message = update.message ? String(update.message) : '';
    const counter = update.total ? ` (${update.done || 0}/${update.total})` : '';
    const line = [label, message].filter(Boolean).join(' — ') + counter;
    if (line.trim()) {
      saimSay(line);
      logLine(line);
    }
  });
}

function selectedClips() {
  return state.saim.clips.filter((clip) => clip.enabled);
}

function setBusy(busy) {
  state.saim.busy = Boolean(busy);
  ['saimFindBtn', 'saimExportBtn', 'saimDiscardBtn', 'saimUrl'].forEach((id) => {
    const node = el(id);
    if (node) node.disabled = state.saim.busy;
  });
  toggleHidden('saimCancelBtn', !state.saim.busy);
  refreshRenderButton();
}

function refreshRenderButton() {
  const button = el('saimRenderBtn');
  const count = selectedClips().length;
  if (button) {
    button.disabled = state.saim.busy || !count;
    button.textContent = count
      ? `🎬 Make ${count} clip${count === 1 ? '' : 's'}`
      : '🎬 Select at least one clip';
  }
  const summary = el('clipsSummary');
  if (summary) {
    summary.textContent = state.saim.clips.length
      ? `${state.saim.clips.length} clips found · ${count} selected`
      : 'No clips yet';
  }
}
/* ------------------------------------------------------- caption templates  */

/** A chunky text outline. Chromium draws this far more reliably than a stroke. */
function captionOutline(colour, width) {
  if (!width) return '';
  const steps = [];
  for (let angle = 0; angle < 360; angle += 45) {
    const radians = (angle * Math.PI) / 180;
    const x = (Math.cos(radians) * width).toFixed(2);
    const y = (Math.sin(radians) * width).toFixed(2);
    steps.push(`${x}px ${y}px 0 ${colour}`);
  }
  return steps.join(', ');
}

/** The words a tile shows: one for the one-word templates, a phrase otherwise. */
function captionSampleWords(tpl) {
  if (tpl.words === 1) return ['Viral'];
  const phrase = ['This', 'is', 'going', 'viral'];
  return tpl.words >= 5 ? phrase.concat(['right', 'now']) : phrase;
}

function captionSample(tpl) {
  const line = document.createElement('span');
  line.className = 'cap-line';
  line.style.fontFamily = tpl.font;
  line.style.fontWeight = String(tpl.weight === undefined ? 800 : tpl.weight);
  line.style.fontStyle = tpl.italic ? 'italic' : 'normal';
  line.style.color = tpl.color;
  line.style.fontSize = `${(tpl.size === undefined ? 1 : tpl.size) * 13}px`;
  if (tpl.upper) line.style.textTransform = 'uppercase';
  if (tpl.box) line.style.background = tpl.box;
  const shadow = captionOutline(tpl.outline || '#000000', tpl.stroke === undefined ? 2 : tpl.stroke);
  if (shadow) line.style.textShadow = shadow;
  else if (tpl.shadow) line.style.textShadow = '0 2px 5px rgba(0,0,0,0.85)';

  const words = captionSampleWords(tpl);
  const hot = tpl.words === 1 ? 0 : 2;
  words.forEach((word, position) => {
    const span = document.createElement('span');
    span.textContent = word;
    if (tpl.accent && position === hot) {
      span.style.color = tpl.accent;
      span.style.fontSize = '112%';
    }
    line.appendChild(span);
    if (position < words.length - 1) line.appendChild(document.createTextNode(' '));
  });
  return line;
}

/** Highlight whichever tile matches the dropdown. */
function syncCaptionGallery() {
  const chosen = el('saimCaptionStyle') ? el('saimCaptionStyle').value : 'bold';
  const gallery = el('saimCaptionGallery');
  if (!gallery) return;
  Array.from(gallery.children).forEach((tile) => {
    tile.classList.toggle('is-picked', tile.dataset.style === chosen);
  });
}

/**
 * Fills the caption dropdown and builds the preview gallery from one table, so
 * a new template only has to be written once on this side.
 */
function buildCaptionPicker() {
  const select = el('saimCaptionStyle');
  if (select) {
    const previous = select.value || 'bold';
    select.textContent = '';
    let group = null;
    CAPTION_TEMPLATES.forEach((tpl) => {
      if (!group || group.label !== tpl.group) {
        group = document.createElement('optgroup');
        group.label = tpl.group;
        select.appendChild(group);
      }
      const option = document.createElement('option');
      option.value = tpl.key;
      option.textContent = tpl.label;
      group.appendChild(option);
    });
    const last = document.createElement('option');
    last.value = 'off';
    last.textContent = 'No captions';
    select.appendChild(last);
    select.value = CAPTION_CHOICES.some(([key]) => key === previous) ? previous : 'bold';
  }

  const gallery = el('saimCaptionGallery');
  if (gallery) {
    gallery.textContent = '';
    CAPTION_TEMPLATES.forEach((tpl) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = `cap-tile cap-at-${tpl.align || 'bottom'}`;
      tile.dataset.style = tpl.key;
      tile.title = `${tpl.label} — ${tpl.group.toLowerCase()}`;
      const stage = document.createElement('span');
      stage.className = 'cap-stage';
      stage.appendChild(captionSample(tpl));
      const name = document.createElement('span');
      name.className = 'cap-name';
      name.textContent = tpl.label;
      tile.append(stage, name);
      tile.addEventListener('click', () => {
        if (!el('saimCaptionStyle')) return;
        el('saimCaptionStyle').value = tpl.key;
        // Let the existing change handler do the work of pushing this onto
        // every clip; the gallery is only another way of moving that dropdown.
        el('saimCaptionStyle').dispatchEvent(new Event('change'));
      });
      gallery.appendChild(tile);
    });
  }
  syncCaptionGallery();
}

/* -------------------------------------------------------------- clip cards  */

function dropdown(options, value, onChange, title) {
  const select = document.createElement('select');
  if (title) select.title = title;
  options.forEach(([key, label]) => {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = label;
    if (key === value) option.selected = true;
    select.appendChild(option);
  });
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function renderedFor(clip) {
  return state.saim.rendered.find((item) => Number(item.index) === Number(clip.index)) || null;
}

/** Play a clip's window straight out of the downloaded source video. */
function previewFromSource(clip) {
  const source = state.saim.project && state.saim.project.sourcePath;
  const url = source && bridge.fileUrl ? bridge.fileUrl(source) : null;
  if (!url) return saimSay('Nothing to preview yet — find some clips first.');
  loadPreview(url, clip.start, clip.end);
  return undefined;
}

function musicRow(clip) {
  const row = document.createElement('div');
  row.className = 'saim-clip-music';

  const pickBtn = document.createElement('button');
  pickBtn.type = 'button';
  pickBtn.textContent = '🎵 Music';
  pickBtn.title = 'Choose background music for this clip — an audio file or a song video (mp4/mkv) works';
  pickBtn.addEventListener('click', async () => {
    const picked = await pickWithMain('selectMusicFile');
    if (!picked) return;
    clip.musicPath = picked.path;
    clip.musicName = picked.name;
    renderClipList();
  });
  const name = document.createElement('span');
  name.className = 'saim-music-name';
  name.textContent = clip.musicName || 'no music';

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = '✕';
  clearBtn.title = 'Remove this music';
  clearBtn.addEventListener('click', () => {
    clip.musicPath = null;
    clip.musicName = '';
    renderClipList();
  });

  const volume = document.createElement('input');
  volume.type = 'range';
  volume.min = '0';
  volume.max = '100';
  volume.value = String(Math.round(clip.musicVolume * 100));
  volume.title = 'Music volume — quiet to loud';

  const readout = document.createElement('span');
  readout.textContent = `${volume.value}%`;
  volume.addEventListener('input', () => {
    clip.musicVolume = Number(volume.value) / 100;
    readout.textContent = `${volume.value}%`;
  });

  row.append(pickBtn, name, clearBtn, volume, readout);
  return row;
}

function linksRow(made) {
  const row = document.createElement('div');
  row.className = 'saim-clip-links';
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = 'Open file';
  open.addEventListener('click', () => bridge.openFile && bridge.openFile(made.path));
  const reveal = document.createElement('button');
  reveal.type = 'button';
  reveal.textContent = 'Show in folder';
  reveal.addEventListener('click', () => bridge.revealFile && bridge.revealFile(made.path));
  row.append(open, reveal);
  return row;
}
function clipCard(clip) {
  const made = renderedFor(clip);
  const card = document.createElement('div');
  card.className = 'saim-clip';
  if (!clip.enabled) card.classList.add('is-off');
  if (made) card.classList.add('is-done');

  if (made && made.thumbnailUrl) {
    const thumb = document.createElement('img');
    thumb.className = 'saim-clip-thumb';
    thumb.src = made.thumbnailUrl;
    thumb.alt = '';
    card.appendChild(thumb);
  }

  const top = document.createElement('div');
  top.className = 'saim-clip-top';
  const pick = document.createElement('input');
  pick.type = 'checkbox';
  pick.checked = clip.enabled;
  pick.title = 'Include this clip';
  pick.addEventListener('change', () => {
    clip.enabled = pick.checked;
    card.classList.toggle('is-off', !clip.enabled);
    refreshRenderButton();
  });
  const title = document.createElement('div');
  title.className = 'saim-clip-title';
  title.textContent = `${clip.index}. ${clip.title}`;
  const score = document.createElement('span');
  score.className = 'saim-clip-score';
  score.textContent = `${Math.round(clip.score)}`;
  score.title = 'How strong this moment looks';
  top.append(pick, title, score);
  card.appendChild(top);

  const meta = document.createElement('p');
  meta.className = 'saim-clip-meta';
  const reasons = (clip.reasons || []).join(' · ');
  meta.textContent = `${formatTime(clip.start)} → ${formatTime(clip.end)}`
    + ` · ${Math.round(clip.duration)}s${reasons ? ` · ${reasons}` : ''}`;
  card.appendChild(meta);
  if (clip.text) {
    const quote = document.createElement('p');
    quote.className = 'saim-clip-meta';
    quote.style.color = '#a9b2c2';
    quote.textContent = `“${clip.text}”`;
    card.appendChild(quote);
  }

  const controls = document.createElement('div');
  controls.className = 'saim-clip-controls';
  controls.appendChild(dropdown(FILTERS, clip.filter, (value) => {
    clip.filter = value;
  }, 'Colour look for this clip'));
  controls.appendChild(dropdown(CAPTION_CHOICES, clip.captionStyle, (value) => {
    clip.captionStyle = value;
  }, 'Caption style for this clip'));

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.textContent = made ? '▶ Play result' : '▶ Preview';
  previewBtn.addEventListener('click', () => {
    if (made && made.url) loadPreview(made.url, 0, 0);
    else previewFromSource(clip);
  });
  controls.appendChild(previewBtn);
  controls.appendChild(musicRow(clip));
  card.appendChild(controls);

  const failure = state.saim.failed.find((item) => Number(item.index) === Number(clip.index));
  if (failure) {
    const warn = document.createElement('p');
    warn.className = 'saim-clip-warn';
    warn.textContent = `Could not be made: ${failure.error || 'unknown reason'}`;
    card.appendChild(warn);
  }

  if (made) card.appendChild(linksRow(made));
  return card;
}

function renderClipList() {
  const list = el('saimClipList');
  if (list) {
    list.textContent = '';
    state.saim.clips.forEach((clip) => list.appendChild(clipCard(clip)));
  }
  toggleHidden('saimClipsWrap', !state.saim.clips.length || state.tool !== 'saim');
  refreshRenderButton();
}
/* ------------------------------------------------------- step 1: find clips */

function resetClipState() {
  state.saim.project = null;
  state.saim.clips = [];
  state.saim.rendered = [];
  state.saim.failed = [];
  toggleHidden('saimExportWrap', true);
  toggleHidden('saimDiscardBtn', true);
  const title = el('saimVideoTitle');
  if (title) title.textContent = '';
  renderClipList();
}

async function findClips() {
  if (state.saim.busy) return;
  const url = el('saimUrl').value.trim();
  if (!url) { saimSay('Paste a YouTube link first.'); return; }
  if (!/^https?:\/\//i.test(url)) { saimSay('The link has to start with https://'); return; }

  const target = Number(el('saimTargetLen').value) || 30;
  clearLog();
  resetClipState();
  state.saim.leftover = null;
  setBusy(true);
  showProgress(1);
  saimSay('Checking the link…');

  const result = await callMain('clipAnalyze', {
    url,
    clipCount: Number(el('saimClipCount').value) || 10,
    targetDuration: target,
    minDuration: Math.max(5, Math.round(target * 0.5)),
    maxDuration: Math.min(180, Math.round(target * 2)),
    modelSize: el('saimModelSize').value,
    maxHeight: Number(el('saimQuality').value) || 720
  });

  setBusy(false);
  if (!result || !result.success) {
    hideProgress();
    saimSay(result && result.cancelled
      ? 'Cancelled.'
      : `Could not analyse that link: ${(result && result.error) || 'unknown error'}`);
    return;
  }
  const captionDefault = el('saimCaptionStyle').value;
  state.saim.project = result;
  state.saim.clips = (result.clips || []).map((clip, order) => ({
    index: Number(clip.index) || order + 1,
    start: Number(clip.start) || 0,
    end: Number(clip.end) || 0,
    duration: Number(clip.duration) || 0,
    score: Number(clip.score) || 0,
    title: clip.title || `Clip ${order + 1}`,
    text: clip.text || '',
    reasons: Array.isArray(clip.reasons) ? clip.reasons : [],
    enabled: true,
    filter: 'none',
    captionStyle: captionDefault,
    musicPath: null,
    musicName: '',
    // 45%, not 25%. The mix sums both tracks without normalising, so 25% under
    // loud match or podcast audio was quiet enough to sound like no music at all.
    musicVolume: 0.45
  }));

  const videoTitle = el('saimVideoTitle');
  if (videoTitle) {
    videoTitle.textContent = result.title
      ? `${result.title} · ${formatTime(result.duration)}`
      : '';
  }
  (result.warnings || []).forEach((note) => logLine(`Note: ${note}`));
  toggleHidden('saimDiscardBtn', false);
  renderClipList();
  showProgress(100);

  if (!state.saim.clips.length) {
    saimSay('No usable moments were found in that video.');
    return;
  }
  saimSay(`${state.saim.clips.length} strong moments found — choose music and a look, `
    + 'then make the clips.');
}

/* ------------------------------------------------------ step 2: make clips  */

async function makeClips() {
  if (state.saim.busy) return;
  const chosen = selectedClips();
  if (!state.saim.project) { saimSay('Analyse a link first.'); return; }
  if (!chosen.length) { saimSay('Select at least one clip.'); return; }

  const captionDefault = el('saimCaptionStyle').value;
  setBusy(true);
  showProgress(1);
  saimSay(`Making ${chosen.length} clip${chosen.length === 1 ? '' : 's'}…`);
  const result = await callMain('clipRender', {
    projectDir: state.saim.project.dir,
    aspect: el('saimAspect').value,
    quality: el('saimQuality').value,
    captionMode: captionDefault === 'off' ? 'off' : 'burn',
    captionStyle: captionDefault === 'off' ? 'bold' : captionDefault,
    musicDuck: el('saimMusicDuck').checked,
    clips: chosen.map((clip) => ({
      index: clip.index,
      start: clip.start,
      end: clip.end,
      title: clip.title,
      filter: clip.filter,
      // 'off' is expressed as captions:false — clip_renderer keys off that flag.
      captions: clip.captionStyle === 'off' ? false : captionDefault !== 'off',
      captionStyle: (clip.captionStyle && clip.captionStyle !== 'off')
        ? clip.captionStyle
        : (captionDefault === 'off' ? 'bold' : captionDefault),
      musicPath: clip.musicPath,
      musicVolume: clip.musicVolume
    }))
  });

  setBusy(false);
  if (!result || !result.success) {
    hideProgress();
    saimSay(result && result.cancelled
      ? 'Cancelled.'
      : `Could not make the clips: ${(result && result.error) || 'unknown error'}`);
    return;
  }

  state.saim.rendered = result.clips || [];
  state.saim.failed = (result.failed || []).map((item) => (typeof item === 'string'
    ? { index: 0, error: item }
    : item));
  renderClipList();
  showProgress(100);

  // The renderer used to swallow these. If FFmpeg had to drop the limiter, the
  // ducking or the caption burn on a clip, that is exactly the sort of thing
  // that makes a finished clip sound or look wrong for no visible reason.
  state.saim.rendered.forEach((clip) => {
    if (clip && clip.warning) logLine(`Clip ${clip.index}: ${clip.warning}`);
  });

  // Say out loud whether the music landed, so "did it use my track?" is never a
  // guess again.
  const requested = selectedClips().filter((clip) => clip.musicPath).length;
  const withMusic = state.saim.rendered.filter((clip) => clip && clip.musicPath).length;
  if (requested || withMusic) {
    logLine(`Background music is in ${withMusic} of ${state.saim.rendered.length} clips`
      + `${requested > withMusic ? ` — ${requested - withMusic} music file(s) could not be read` : ''}.`);
  }

  const failed = state.saim.failed.length;
  toggleHidden('saimExportWrap', !state.saim.rendered.length);
  saimSay(`${state.saim.rendered.length} clip${state.saim.rendered.length === 1 ? '' : 's'} ready`
    + `${failed ? `, ${failed} failed` : ''} — now choose a folder and export.`);
}
/* --------------------------------------------------------- step 3: export   */

/**
 * Ask where the clips should go. Returns true only if a folder is now chosen.
 */
async function chooseExportFolder() {
  const picked = await pickWithMain('selectExportFolder');
  if (!picked || !picked.path) return false;
  state.saim.exportDir = picked.path;
  state.saim.exportName = picked.name || picked.path;
  setText('saimFolderName', picked.path);
  saimSay(`Clips will be saved to ${picked.path}`);
  return true;
}

async function exportClips() {
  if (state.saim.busy) return;
  if (!state.saim.rendered.length) { saimSay('Make some clips first.'); return; }

  // Always ask before writing anything. The main process has a fallback dialog,
  // but a question the user does not notice is the same as no question — so the
  // folder is settled here, in the renderer, where the answer is also shown on
  // screen next to the export button.
  if (!state.saim.exportDir) {
    const chosen = await chooseExportFolder();
    if (!chosen) {
      saimSay('Export cancelled — no folder was chosen, nothing was saved or deleted.');
      return;
    }
  }

  setBusy(true);
  showProgress(2);
  saimSay(`Copying the clips to ${state.saim.exportDir}…`);

  const result = await callMain('clipExport', {
    projectDir: state.saim.project ? state.saim.project.dir : null,
    destDir: state.saim.exportDir,
    includeSubtitles: el('saimSubtitles') ? el('saimSubtitles').checked : false,
    deleteAfter: true
  });

  setBusy(false);
  if (!result || !result.success) {
    hideProgress();
    saimSay(result && result.cancelled
      ? 'Export cancelled.'
      : `Export failed: ${(result && result.error) || 'unknown error'}`);
    return;
  }

  const count = (result.exported || []).length;
  const freed = result.freedBytes ? ` ${formatBytes(result.freedBytes)} of temporary files were deleted.` : '';
  showProgress(100);
  logLine(`Exported to ${result.destDir}`);
  saimSay(`${count} clip${count === 1 ? '' : 's'} saved to ${result.destDir}.${freed}`);

  // Back to normal: the project is gone from disk, so the UI must forget it too.
  resetClipState();
  state.saim.exportDir = null;
  state.saim.exportName = '';
  setText('saimFolderName', 'No folder chosen yet');
  hideProgress();
  setStatus('Ready — paste a new YouTube link');
}
/* ------------------------------------------------------------ housekeeping   */

async function discardProject(dir) {
  if (state.saim.busy) return;
  const target = dir
    || (state.saim.project && state.saim.project.dir)
    || (state.saim.leftover && state.saim.leftover.dir)
    || undefined;

  setBusy(true);
  const result = await callMain('clipDiscard', { projectDir: target });
  setBusy(false);

  if (!result || !result.success) {
    saimSay(`Could not delete it: ${(result && result.error) || 'unknown error'}`);
    return;
  }
  state.saim.leftover = null;
  resetClipState();
  hideProgress();
  clearLog();
  saimSay(result.removed
    ? `Temporary project deleted — ${formatBytes(result.freedBytes)} freed.`
    : 'There was nothing left to delete.');
}

/** A crash or force-quit can leave a whole downloaded video on disk. */
async function checkLeftovers() {
  if (!bridge.clipStatus) return;
  let status;
  try {
    status = await bridge.clipStatus();
  } catch (_) {
    return;
  }
  const projects = (status && status.projects) || [];
  if (!projects.length) return;
  const newest = projects[0];
  state.saim.leftover = newest;
  toggleHidden('saimDiscardBtn', false);
  saimSay(`An earlier project is still on disk (${formatBytes(newest.bytes)}) — `
    + 'delete it, or just paste a new link and it will be replaced.');
}
/* -------------------------------------------------------------- listeners    */

on('saimFindBtn', 'click', findClips);
on('saimRenderBtn', 'click', makeClips);
on('saimFolderBtn', 'click', chooseExportFolder);
on('saimExportBtn', 'click', exportClips);
on('saimDiscardBtn', 'click', () => discardProject());

on('saimUrl', 'keydown', (event) => {
  if (event.key === 'Enter') findClips();
});

on('saimCancelBtn', 'click', async () => {
  el('saimCancelBtn').disabled = true;
  saimSay('Stopping…');
  try { await bridge.cancelGenerate(); } catch (_) { /* nothing running */ }
  el('saimCancelBtn').disabled = false;
});

on('saimAllMusicBtn', 'click', async () => {
  if (!state.saim.clips.length) { saimSay('Find some clips first.'); return; }
  const picked = await pickWithMain('selectMusicFile');
  if (!picked) return;
  state.saim.clips.forEach((clip) => {
    clip.musicPath = picked.path;
    clip.musicName = picked.name;
  });
  renderClipList();
  saimSay(`${picked.name} is now the music on every clip.`);
});

on('saimSelectAllBtn', 'click', () => {
  if (!state.saim.clips.length) return;
  const turnOn = selectedClips().length !== state.saim.clips.length;
  state.saim.clips.forEach((clip) => { clip.enabled = turnOn; });
  renderClipList();
});

on('saimCaptionStyle', 'change', () => {
  // The dropdown is the default for the whole batch, so keep untouched clips
  // in sync with it instead of making the user change ten cards by hand.
  const value = el('saimCaptionStyle').value;
  state.saim.clips.forEach((clip) => { clip.captionStyle = value; });
  syncCaptionGallery();
  renderClipList();
  const picked = CAPTION_TEMPLATES.find((tpl) => tpl.key === value);
  saimSay(picked
    ? `Caption template: ${picked.label}`
    : 'Captions are off — the clips keep whatever text is already in the video.');
});
/* --------------------------------------------------- Shorts from a local file */

on('clipVideoBtn', 'click', async () => {
  const picked = await pickWithMain('selectVideoFile');
  if (!picked) return;
  state.shorts.videoPath = picked.path;
  el('clipVideoName').textContent = picked.name;
  el('makeClipsBtn').disabled = false;
});

on('clipMusicBtn', 'click', async () => {
  const picked = await pickWithMain('selectMusicFile');
  if (!picked) return;
  state.shorts.musicPath = picked.path;
  el('clipMusicName').textContent = picked.name;
  el('clipMusicPolicy').value = 'licensed';
});

on('makeClipsBtn', 'click', async () => {
  if (!state.shorts.videoPath) return;
  const withMusic = el('clipMusicPolicy').value === 'licensed';
  el('makeClipsBtn').disabled = true;
  el('clipStatus').textContent = 'Cutting the clips…';
  el('clipResults').textContent = '';

  const result = await callMain('createShortClips', {
    inputPath: state.shorts.videoPath,
    platform: el('clipPlatform').value,
    length: Number(el('clipLength').value) || 10,
    count: Number(el('clipCount').value) || 10,
    musicPath: withMusic ? state.shorts.musicPath : null
  });

  el('makeClipsBtn').disabled = false;
  if (!result || !result.success) {
    el('clipStatus').textContent = `Failed: ${(result && result.error) || 'unknown error'}`;
    return;
  }

  const clips = result.clips || [];
  el('clipStatus').textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'} created`;
  clips.forEach((clip) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'small-btn';
    row.textContent = `▶ Clip ${clip.index} · ${formatTime(clip.start)}`;
    row.addEventListener('click', () => loadPreview(clip.url, 0, 0));
    el('clipResults').appendChild(row);
  });
});
/* ------------------------------------------------------- enhancements (v1.2) */

// 1. Auto-caption AI — generate hooks/CTAs from a transcript
on('saimGenHooksBtn', 'click', async () => {
  const transcript = el('saimTranscript') ? el('saimTranscript').value : '';
  if (!transcript.trim()) {
    setStatus('Paste a transcript first, then generate hooks.');
    return;
  }
  const result = await bridge.enhanceGenerateHooks({ transcript, count: 3 });
  if (!result || !result.success) {
    setStatus(result && result.error ? result.error : 'Could not generate hooks.');
    return;
  }
  const list = el('saimHooksList');
  if (!list) return;
  list.innerHTML = '';
  result.hooks.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'hook-card';
    card.innerHTML = `
      <div class="hook-index">${index + 1}</div>
      <div class="hook-body">
        <p class="hook-text">${escapeHtml(item.hook)}</p>
        <p class="hook-cta">${escapeHtml(item.cta)}</p>
        <span class="hook-pattern">${escapeHtml(item.pattern)}</span>
      </div>
      <button class="small-btn hook-use" data-hook="${index}">Use</button>
    `;
    card.querySelector('.hook-use').addEventListener('click', () => {
      const hookInput = el('saimHook');
      if (hookInput) hookInput.value = item.hook.slice(0, 90);
      setStatus('Hook copied to the headline box.');
    });
    list.appendChild(card);
  });
  setStatus('3 hooks generated — click "Use" to put one in the headline box.');
});

// 2. Multi-language — CTA translation
on('saimCtaLanguage', 'change', async () => {
  const language = el('saimCtaLanguage').value;
  const result = await bridge.enhanceTranslateCta({ key: 'follow', language });
  if (result && result.success) {
    setStatus(`CTA language set to ${language.toUpperCase()} — "Follow for more" → "${result.text}"`);
  }
});

// 3. Batch processing — queue multiple YouTube links
const batchState = { items: [] };

function renderBatchList() {
  const list = el('saimBatchList');
  if (!list) return;
  list.innerHTML = '';
  batchState.items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'batch-row';
    const statusClass = item.status === 'completed' ? 'batch-done'
      : item.status === 'failed' ? 'batch-fail'
      : item.status === 'running' ? 'batch-run' : '';
    row.innerHTML = `
      <span class="batch-status ${statusClass}">${escapeHtml(item.status)}</span>
      <span class="batch-url">${escapeHtml(item.url)}</span>
      <span class="batch-progress">${item.progress || 0}%</span>
      <button class="small-btn batch-remove" data-id="${item.id}">✕</button>
    `;
    row.querySelector('.batch-remove').addEventListener('click', async () => {
      await bridge.enhanceBatchRemove(item.id);
      refreshBatchState();
    });
    list.appendChild(row);
  });
}

async function refreshBatchState() {
  const result = await bridge.enhanceBatchState();
  if (!result || !result.success) return;
  batchState.items = result.state.queue;
  renderBatchList();
}

on('saimBatchAddBtn', 'click', async () => {
  const textarea = el('saimBatchUrls');
  if (!textarea) return;
  const urls = textarea.value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!urls.length) {
    setStatus('Paste at least one YouTube link first.');
    return;
  }
  for (const url of urls) {
    await bridge.enhanceBatchAdd({ url, settings: {
      clipCount: Number(el('saimClipCount')?.value || 10),
      targetDuration: Number(el('saimTargetLen')?.value || 30),
      language: el('saimLanguage')?.value || 'auto',
      translate: el('saimTranslate')?.checked || false
    } });
  }
  textarea.value = '';
  await refreshBatchState();
  setStatus(`${urls.length} link(s) added to the batch queue.`);
});

on('saimBatchRunBtn', 'click', async () => {
  const result = await bridge.enhanceBatchRun();
  if (!result || !result.success) {
    setStatus(result && result.error ? result.error : 'Batch run failed.');
    return;
  }
  await refreshBatchState();
  const done = result.results.filter((r) => r.success).length;
  const failed = result.results.length - done;
  setStatus(`Batch finished: ${done} succeeded, ${failed} failed.`);
});

on('saimBatchClearBtn', 'click', async () => {
  await bridge.enhanceBatchClear();
  await refreshBatchState();
  setStatus('Batch queue cleared.');
});

// 4. Analytics dashboard — owner usage stats
async function showAnalytics() {
  const result = await bridge.enhanceAnalytics({ days: 30 });
  if (!result || !result.success) return;
  const a = result.analytics;
  const totals = a.totals || {};
  const byDay = a.byDay || [];
  const lines = [
    `Clips created: ${totals.clipsCreated || 0}`,
    `Videos generated: ${totals.videosGenerated || 0}`,
    `Exports: ${totals.exports || 0}`,
    `Last 30 days: ${byDay.length} active day(s)`
  ];
  setStatus(lines.join(' · '));
}

// 5. Auto-posting — platform presets
on('saimPlatformPreset', 'change', async () => {
  const key = el('saimPlatformPreset').value;
  const result = await bridge.enhancePlatformPreset(key);
  if (!result || !result.success) return;
  const preset = result.preset;
  const desc = el('saimPlatformDesc');
  if (desc) {
    desc.textContent = `${preset.label} · ${preset.resolution} · max ${preset.maxDuration}s · ${preset.description}`;
  }
  // Apply the preset's aspect ratio to the clip aspect selector
  const aspect = el('saimAspect');
  if (aspect) {
    aspect.value = preset.aspect === 'vertical' ? 'vertical' : preset.aspect === 'square' ? 'square' : 'wide';
  }
});

// 6. Trial/demo mode — watermark + clip limit
async function checkTrialStatus() {
  const result = await bridge.enhanceTrialStatus();
  if (!result || !result.success) return;
  if (result.trial) {
    const config = result.config || {};
    setStatus(`Trial mode — ${config.maxClips} clips max, watermark will be added. Get a license to remove it.`);
  } else {
    // A verified license means the user is no longer on trial. Clear any
    // lingering trial banner left over from start-up / a previous sign-in,
    // otherwise it would keep claiming a 3-clip limit that no longer applies.
    setStatus('Ready — license verified.');
  }
}

// Track analytics events
async function trackClipRender(count, url) {
  try { await bridge.enhanceTrackClipRender({ count, url }); } catch (_) {}
}

async function trackExport(count, platform) {
  try { await bridge.enhanceTrackExport({ count, platform }); } catch (_) {}
}

// Escape HTML for safe injection into innerHTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text || '');
  return div.innerHTML;
}

/* -------------------------------------------------------------------- start  */

// Soft glow that follows the cursor — purely cosmetic.
document.addEventListener('mousemove', (event) => {
  const glow = el('cursorGlow');
  if (!glow) return;
  glow.style.left = `${event.clientX}px`;
  glow.style.top = `${event.clientY}px`;
});

async function showSystemInfo() {
  if (!bridge.getSystemInfo) return;
  try {
    const info = await bridge.getSystemInfo();
    // Careful: Number(null) is 0, which passes isFinite. The disk figure is null
    // when it could not be read, and "0 GB free" would be a lie.
    const freeDisk = typeof info.freeDiskGb === 'number' && Number.isFinite(info.freeDiskGb)
      ? info.freeDiskGb
      : null;
    const disk = freeDisk === null ? '' : ` · ${freeDisk} GB free on disk`;
    setText('systemInfo', `${info.cores} cores · ${info.totalGb} GB RAM${disk}`);
    if (info.totalGb && info.totalGb <= 4.5) {
      logLine('This machine has limited memory — 720p and the fast transcription '
        + 'model are the safe choices.');
    }
    // The download needs room for the source video, the clips and the brief
    // moment yt-dlp holds both halves of the merge, so say so before he starts.
    if (freeDisk !== null && freeDisk < 2) {
      logLine(`Only ${freeDisk} GB is free where the tool works — a download `
        + 'will be refused until there is at least 2 GB.');
    }
  } catch (_) { /* diagnostics are optional */ }
}

// Listen for in-app update events (available / downloading / ready to restart)
// and surface them through the status bar. Everything is optional — if the
// build was never published there is simply no update and nothing is shown.
function setupUpdateListener() {
  if (!window.api || typeof window.api.onUpdate !== 'function') return;
  window.api.onUpdate((event) => {
    if (!event) return;
    switch (event.type) {
      case 'available':
        setStatus(`Update ${event.version} is available.`);
        // Auto-download in the background so the user only has to confirm a
        // restart once it is ready.
        if (typeof window.api.downloadUpdate === 'function') {
          window.api.downloadUpdate().catch(() => {});
        }
        break;
      case 'downloaded':
        setStatus(`Update ${event.version} is ready — restart to install it.`);
        if (typeof window.api.installUpdate === 'function') {
          window.api.installUpdate().catch(() => {});
        }
        break;
      case 'error':
        // A missing feed is normal for unpublished builds — stay quiet.
        if (event.message && !/no update|not published|404/i.test(event.message)) {
          setStatus(`Update failed: ${event.message}`);
        }
        break;
      default:
        // checking / progress / not-available — nothing to show
        break;
    }
  });
}

// The start-up steps run inside a try so that one bad step cannot stop the rest
// of the file: the listeners above are already attached by this point, and a
// failure here is reported on screen instead of killing the window quietly.
try {
  buildCaptionPicker();
  selectTool('saim');
  renderClipList();
  hideProgress();
  showSystemInfo();
  checkLeftovers();
  checkLicense();
  checkTrialStatus();
  setupUpdateListener();
} catch (err) {
  const detail = (err && err.message) ? err.message : String(err);
  setStatus(`Start-up step failed: ${detail}`);
  if (window.__showBootError) {
    window.__showBootError(
      'The app opened but one start-up step failed: ' + detail
      + '\nThe buttons are still connected — try your action again, and if it '
      + 'fails, open View → Toggle Developer Tools for the exact line.'
    );
  }
}

if (!window.api) {
  // Without the preload bridge nothing can reach FFmpeg or yt-dlp, so say it
  // plainly instead of letting every button fail quietly.
  setStatus('The app bridge did not load — close this window and run npm start again.');
  if (window.__showBootError) {
    window.__showBootError(
      'preload.js did not load, so no button can reach the video tools. '
      + 'Close the window and start the app again with npm start.'
    );
  }
} else {
  setStatus('Ready — paste a YouTube link to start');
}

// Read by the check at the bottom of index.html: if this never becomes true,
// something above threw and the buttons are not connected.
window.__rendererReady = true;
