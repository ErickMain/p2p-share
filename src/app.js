// UI wiring: screen switching, settings binding, and the two session flows.

import { Host } from './host.js';
import { Viewer } from './viewer.js';
import { PRESETS, loadSettings, saveSettings, toSignalUrl } from './settings.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let settings = loadSettings();
let sources = [];
let chosenSource = null;
let host = null;
let viewer = null;
let statsTimer = null;

/* ---------------------------------------------------------------- screens */

const SCREENS = ['home', 'sources', 'settings', 'live', 'watch'];

function show(name) {
  for (const s of SCREENS) $(`#screen-${s}`).classList.toggle('hidden', s !== name);
}

$$('[data-goto]').forEach((btn) =>
  btn.addEventListener('click', () => show(btn.dataset.goto))
);

/* ------------------------------------------------------------------- home */

$('#in-name').value = localStorage.getItem('name') || '';
$('#in-room').value = localStorage.getItem('room') || '';
$('#in-hostaddr').value = localStorage.getItem('hostAddr') || '';

/** Filled by the Tailscale probe below; drives the invite text. */
let tailnet = { ok: false, ip: null, hostname: null, reason: 'checking' };

async function probeTailscale() {
  tailnet = await window.net.tailscale();
  const el = $('#ts-status');
  if (tailnet.ok) {
    el.className = 'ts-status ok';
    el.textContent = `Tailscale: ${tailnet.hostname || 'this machine'} — ${tailnet.ip}`;
  } else {
    el.className = 'ts-status bad';
    el.textContent =
      tailnet.reason === 'not-installed'
        ? 'Tailscale not found. Install it and sign in — friends outside your LAN cannot reach you without it.'
        : 'Tailscale is installed but signed out. Sign in to be reachable.';
  }
}
probeTailscale();

function readHome() {
  const name = $('#in-name').value.trim() || 'anon';
  const room = $('#in-room').value.trim().toLowerCase();
  const hostAddr = $('#in-hostaddr').value.trim();
  localStorage.setItem('name', name);
  localStorage.setItem('room', room);
  localStorage.setItem('hostAddr', hostAddr);
  return { name, room, hostAddr };
}

function homeError(msg) {
  $('#home-error').textContent = msg;
}

$('#btn-host').addEventListener('click', async () => {
  const { room } = readHome();
  if (!room) return homeError('pick a room name first');

  // The host serves signaling from its own process, so it talks to localhost.
  const served = await window.net.serve();
  if (!served.ok) {
    return homeError(
      served.reason === 'port-busy'
        ? 'port 8787 is already in use — another copy of the app is probably running'
        : served.reason
    );
  }
  localStorage.setItem('signalUrl', 'ws://127.0.0.1:8787');

  homeError('');
  await loadSources();
  show('sources');
});

$('#btn-join').addEventListener('click', async () => {
  const { room, name, hostAddr } = readHome();
  if (!room) return homeError('pick a room name first');

  const url = toSignalUrl(hostAddr);
  if (!url) return homeError("enter the host's address (their tailnet IP or machine name)");
  localStorage.setItem('signalUrl', url);
  homeError('');

  viewer = new Viewer();
  viewer.addEventListener('stream', (e) => {
    $('#watch-video').srcObject = e.detail;
  });
  viewer.addEventListener('status', (e) => {
    $('#watch-status').textContent = e.detail;
  });

  try {
    await viewer.join(room, name);
    show('watch');
  } catch (err) {
    homeError(err.message);
  }
});

$('#btn-leave').addEventListener('click', () => {
  viewer?.leave();
  viewer = null;
  $('#watch-video').srcObject = null;
  show('home');
});

/* ---------------------------------------------------------- source picker */

async function loadSources() {
  sources = await window.capture.listSources();
  renderSources('screen');
}

function renderSources(kind) {
  const grid = $('#source-grid');
  grid.innerHTML = '';
  for (const src of sources.filter((s) => s.kind === kind)) {
    const btn = document.createElement('button');
    btn.className = 'source';
    btn.innerHTML = `<img src="${src.thumbnail}" alt=""><b></b>`;
    btn.querySelector('b').textContent = src.name;
    btn.addEventListener('click', () => pickSource(src));
    grid.append(btn);
  }
}

$$('.tabs .seg').forEach((tab) =>
  tab.addEventListener('click', () => {
    $$('.tabs .seg').forEach((t) => t.classList.toggle('active', t === tab));
    renderSources(tab.dataset.kind);
  })
);

async function pickSource(src) {
  chosenSource = src;
  await window.capture.selectSource(src.id);
  $('#preview-thumb').src = src.thumbnail;
  show('settings');
}

/* --------------------------------------------------------------- settings */

/** Marks the active button in a segmented group. */
function paintGroup(sel, value) {
  $$(`${sel} .seg`).forEach((b) => b.classList.toggle('active', b.dataset.v === String(value)));
}

function paintSettings() {
  paintGroup('#seg-preset', settings.preset);
  paintGroup('#seg-privacy', settings.privacy);
  paintGroup('#seg-res', settings.height);
  paintGroup('#seg-fps', settings.fps);
  paintGroup('#seg-audio', settings.audioBitrate);
  paintGroup('#seg-mode', settings.mode);
  $('#tgl-audio').setAttribute('aria-checked', String(settings.captureAudio));
  $('#val-bitrate').textContent = settings.bitrate;
  $('#val-limit').textContent = settings.viewerLimit;
  paintUploadNote();
  saveSettings(settings);
}

// Upload is the real ceiling in P2P: every viewer gets their own encode.
function paintUploadNote() {
  const n = settings.viewerLimit || 4;
  const total = ((settings.bitrate + settings.audioBitrate) * n) / 1000;
  const label = settings.viewerLimit ? `${n} viewers` : '4 viewers (no limit set)';
  $('#upload-note').textContent =
    `P2P sends one stream per viewer: ~${total.toFixed(1)} Mbps of upload at ${label}.`;
}

function bindGroup(sel, key, cast = String) {
  $(sel).addEventListener('click', (ev) => {
    const btn = ev.target.closest('.seg');
    if (!btn || btn.disabled) return;
    settings[key] = cast(btn.dataset.v);
    if (sel !== '#seg-preset') settings.preset = null;
    paintSettings();
  });
}

$('#seg-preset').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.seg');
  if (!btn) return;
  settings = { ...settings, preset: btn.dataset.v, ...PRESETS[btn.dataset.v] };
  paintSettings();
});

bindGroup('#seg-privacy', 'privacy');
bindGroup('#seg-res', 'height', Number);
bindGroup('#seg-fps', 'fps', Number);
bindGroup('#seg-audio', 'audioBitrate', Number);
bindGroup('#seg-mode', 'mode');

$('#tgl-audio').addEventListener('click', () => {
  settings.captureAudio = !settings.captureAudio;
  paintSettings();
});

$$('.stepper').forEach((stepper) => {
  const isBitrate = stepper.contains($('#val-bitrate'));
  stepper.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.step');
    if (!btn) return;
    const delta = Number(btn.dataset.step);
    if (isBitrate) {
      settings.bitrate = Math.max(300, Math.min(50000, settings.bitrate + delta));
      settings.preset = null;
    } else {
      settings.viewerLimit = Math.max(0, settings.viewerLimit + delta);
    }
    paintSettings();
    if (host?.live && isBitrate) host.applyLiveSettings(settings);
  });
});

$('#toggle-advanced').addEventListener('click', () => {
  $('#advanced').classList.toggle('hidden');
});

/* ------------------------------------------------------------------- live */

$('#btn-golive').addEventListener('click', async () => {
  const { room, name } = readHome();
  host = new Host(settings);

  host.addEventListener('stream', (e) => {
    $('#host-video').srcObject = e.detail;
  });
  host.addEventListener('peers', (e) => renderViewers(e.detail));
  host.addEventListener('stopped', () => stopLive());

  try {
    await host.goLive(room, name);
  } catch (err) {
    // A cancelled source picker lands here too; stay on the settings screen.
    host = null;
    return alert(`could not go live: ${err.message}`);
  }

  $('#live-room').textContent = room;
  $('#invite-text').textContent = tailnet.ok
    ? `${tailnet.ip}  ·  room: ${room}`
    : `(no tailnet address — only your LAN can reach you)  ·  room: ${room}`;
  show('live');
  startStats();
});

$('#btn-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#invite-text').textContent);
  $('#btn-copy').textContent = 'Copied';
  setTimeout(() => ($('#btn-copy').textContent = 'Copy'), 1500);
});

function renderViewers(peers) {
  $('#viewer-count').textContent = peers.length;
  const list = $('#viewer-list');
  list.innerHTML = '';
  for (const p of peers) {
    const li = document.createElement('li');
    li.innerHTML = `<span></span><span class="state"></span>`;
    li.children[0].textContent = p.name;
    li.children[1].textContent = p.state || 'connecting';
    li.children[1].classList.toggle('connected', p.state === 'connected');
    list.append(li);
  }
}

// Outbound stats from the first peer: enough to tell whether the encoder is
// actually hitting the bitrate you asked for.
function startStats() {
  stopStats();
  statsTimer = setInterval(async () => {
    const peer = [...(host?.peers.values() ?? [])][0];
    if (!peer) return ($('#live-stats').textContent = '');
    const report = await peer.pc.getStats();
    for (const s of report.values()) {
      if (s.type === 'outbound-rtp' && s.kind === 'video') {
        const fps = s.framesPerSecond ? `${Math.round(s.framesPerSecond)} fps` : '';
        const size = s.frameWidth ? `${s.frameWidth}×${s.frameHeight}` : '';
        $('#live-stats').textContent = [size, fps].filter(Boolean).join(' · ');
      }
    }
  }, 1000);
}

function stopStats() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
}

$('#btn-stop').addEventListener('click', () => host?.stop());

function stopLive() {
  stopStats();
  host = null;
  $('#host-video').srcObject = null;
  window.net.stopServing();
  show('home');
}

/* ------------------------------------------------------------------ boot */

$$('.tabs .seg')[0].classList.add('active');
paintSettings();
