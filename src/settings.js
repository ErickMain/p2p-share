export const SIGNAL_PORT = 8787;

// Where to reach the signaling server. The host talks to the one running
// inside its own process; a viewer talks to the host's tailnet address.
export const signalUrl = () => localStorage.getItem('signalUrl') || `ws://127.0.0.1:${SIGNAL_PORT}`;

/** Accepts "100.76.142.97", "pc-erick", or a full ws:// URL. */
export function toSignalUrl(input) {
  const value = String(input || '').trim();
  if (!value) return null;
  if (/^wss?:\/\//.test(value)) return value;
  return `ws://${value}:${SIGNAL_PORT}`;
}

/**
 * Empty on purpose. On a tailnet every node is directly routable, so ICE
 * connects on host candidates alone -- no STUN, no TURN, nobody else in the
 * path. This is what makes the app depend on no outside service.
 *
 * Set `iceServers` in localStorage to add STUN/TURN when running somewhere
 * without a tailnet:
 *   localStorage.setItem('iceServers', JSON.stringify([
 *     { urls: 'stun:stun.l.google.com:19302' },
 *   ]));
 */
export function iceServers() {
  const raw = localStorage.getItem('iceServers');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// A preset is just a bundle of the advanced knobs below it. Picking one
// overwrites them; touching a knob afterwards leaves the preset label behind.
export const PRESETS = {
  '360': { height: 360, fps: 30, bitrate: 800, audioBitrate: 128, hint: 'motion' },
  '480': { height: 480, fps: 30, bitrate: 1500, audioBitrate: 128, hint: 'motion' },
  '720': { height: 720, fps: 60, bitrate: 3000, audioBitrate: 160, hint: 'motion' },
  '1080': { height: 1080, fps: 60, bitrate: 6000, audioBitrate: 192, hint: 'motion' },
  '1440': { height: 1440, fps: 60, bitrate: 9000, audioBitrate: 256, hint: 'motion' },
  source: { height: 0, fps: 60, bitrate: 12000, audioBitrate: 320, hint: 'motion' },
  // Slides and code: almost no movement, so spend the budget on sharp text.
  presentation: { height: 1440, fps: 5, bitrate: 2500, audioBitrate: 128, hint: 'detail' },
};

export const DEFAULTS = {
  preset: '1080',
  captureAudio: true,
  privacy: 'public',
  ...PRESETS['1080'],
  viewerLimit: 0,
  mode: 'p2p',
};

/** Capture constraints for getDisplayMedia. height 0 means "native". */
export function videoConstraints(settings) {
  const video = { frameRate: { ideal: settings.fps, max: settings.fps } };
  if (settings.height > 0) {
    video.height = { ideal: settings.height };
    video.width = { ideal: Math.round((settings.height * 16) / 9) };
  }
  return video;
}

/**
 * Bitrate and framerate caps live on the sender, not the capture: capturing at
 * 60fps and asking the encoder for 30 is how you keep resolution while cutting
 * bandwidth.
 */
export async function applySenderSettings(sender, settings) {
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
  params.encodings[0].maxBitrate = settings.bitrate * 1000;
  params.encodings[0].maxFramerate = settings.fps;
  params.degradationPreference =
    settings.hint === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
  await sender.setParameters(params);
}

/**
 * Opus defaults to ~32 kbps, which is fine for voice and awful for game audio.
 * The only way to raise it is to edit the fmtp line before setting the SDP.
 */
export function setOpusBitrate(sdp, kbps) {
  const lines = sdp.split('\r\n');
  const rtpmap = lines.find((l) => /^a=rtpmap:\d+ opus\/48000/.test(l));
  if (!rtpmap) return sdp;
  const pt = rtpmap.match(/^a=rtpmap:(\d+)/)[1];

  const stereo = kbps >= 128 ? 1 : 0;
  const params = [
    `maxaveragebitrate=${kbps * 1000}`,
    `maxplaybackrate=48000`,
    `stereo=${stereo}`,
    `sprop-stereo=${stereo}`,
    `useinbandfec=1`,
  ].join(';');

  const fmtpIdx = lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
  if (fmtpIdx >= 0) {
    lines[fmtpIdx] = `${lines[fmtpIdx]};${params}`;
  } else {
    lines.splice(lines.indexOf(rtpmap) + 1, 0, `a=fmtp:${pt} ${params}`);
  }
  return lines.join('\r\n');
}

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('settings') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem('settings', JSON.stringify(settings));
}
