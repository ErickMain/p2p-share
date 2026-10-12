# P2P Share

Screen sharing for a handful of friends. Electron app, WebRTC, one host
broadcasting to N viewers.

**No server to deploy, no account to create, no third party in the media path.**
The host's own machine is the server; Tailscale is what makes it reachable.

## Running it

```bash
npm start
```

That is the whole thing — there is no second process. The signaling server runs
inside the host's app and only starts when you click *Share my screen*.

- **Host:** type a room name, click *Share my screen*, pick a window, go live.
  The live screen shows an invite line — send it to your friends.
- **Viewers:** type the same room name, put the host's tailnet address in
  *Host address*, click *Join a stream*.

The address can be the tailnet IP (`100.101.102.103`) or the machine name
(`your-machine`) — MagicDNS resolves the latter.

## Why Tailscale

This machine is behind **CGNAT** (`tracert` shows a `100.64.x.x` hop) and the
ISP hands out no IPv6. That combination means there is no port to forward and
no address to publish: the public IP is not yours. Nothing in the app can work
around that — the packet has to reach a machine with a real address.

Tailscale gives every node a stable address that other nodes reach directly, so
the host becomes publishable again without renting anything. Within the tailnet:

```
HOST                                      VIEWER
├─ signaling (ws://100.x.x.x:8787) ←──────┤   who to call
└─ media (WebRTC, host candidates) ═══════┤   the actual video
```

`iceServers` is **empty by default**. On a tailnet every node is directly
routable, so ICE connects on host candidates alone — no STUN, no TURN, nobody
else in the path. That is the point.

Two things make this work and are easy to break:

- `main.js` disables `WebRtcHideLocalIpsWithMdns`. Chromium normally replaces
  local IPs with generated `.local` names that a peer cannot resolve across the
  tailnet. With the flag off, the real tailnet address is offered as a host
  candidate.
- The signaling server binds `0.0.0.0`, not just the tailnet address, so a plain
  LAN session still works. Reaching it from outside still requires the tailnet.

### What each friend has to do, once

Install Tailscale, sign in, and accept your invite to the tailnet. That is the
cost of this design. In exchange there is no VPS, no monthly bill, and no
service that can see your traffic.

### Running without Tailscale

On a LAN it works as-is — put the host's LAN IP in *Host address*. Over the open
internet without a tailnet you need STUN, and probably TURN:

```js
localStorage.setItem('iceServers', JSON.stringify([
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:your.vps:3478', username: 'u', credential: 'p' },
]));
```

`npm run signal` starts the same signaling module standalone, for the case where
you'd rather host it on an always-on machine than inside the host's app.

## Upload is the ceiling, and it multiplies

In P2P each viewer gets their own encode:

| Quality | Per viewer | 2 viewers | 4 viewers | 8 viewers |
|---|---|---|---|---|
| 720p60 @ 3000 kbps | 3 Mbps | 6 | 12 | 24 |
| 1080p60 @ 6000 kbps | 6 Mbps | 12 | 24 | 48 |
| 1440p60 @ 9000 kbps | 9 Mbps | 18 | 36 | 72 |

Check your plan's **upload**, not the download number they advertise. The panel
shows this running total under Advanced Settings. When you outgrow it, the fix
is a Server (SFU) mode — you upload once and something fans it out — which is
the greyed-out button in the UI, and which would need a machine with real
bandwidth.

## Settings

A **preset** is a bundle of the advanced knobs; picking one overwrites them, and
touching a knob afterwards clears the preset label.

- **Presentation** is the odd one: 1440p at 5 fps with `maintain-resolution`.
  For slides and code, where sharp text matters and motion does not.
- **Bitrate** and **FPS** are applied to the encoder, not the capture, so they
  can be changed mid-stream without reconnecting.
- **Audio Bitrate** is Opus; 128 and above switches to stereo. Opus defaults to
  ~32 kbps, fine for voice and poor for game audio — the app rewrites the SDP to
  raise it.
- **Capture Audio** uses Electron's loopback capture, so viewers hear what your
  machine is playing. Windows only; on macOS and Linux it silently captures no
  system audio.

## Giving it to your friends

```bash
npm run dist
```

Produces `dist/P2PShare-<version>-portable.exe` (~69 MB) — no installer, no
admin rights, double-click and it runs. `npm run dist:installer` builds an NSIS
setup instead if you'd rather have a Start Menu entry.

To publish it, build and upload in one step:

```bash
$env:GH_TOKEN = gh auth token   # PowerShell; export GH_TOKEN=$(gh auth token) elsewhere
npm run release
```

That pushes the `.exe` to [GitHub Releases](https://github.com/ErickMain/p2p-share/releases),
where your friends just click a link. The binary is never committed to the repo
itself — 69 MB in the history would stay there forever; releases are a separate
asset store meant for exactly this.

The "no outside service" rule this app is built around is about the **running
app**: signaling and media never touch a third party. Downloading the installer
once is not part of that, and routing it through Taildrop would mean a friend
has to already be on the tailnet to receive the thing that gets them onto the
tailnet. If you do want machine-to-machine delivery anyway:

```bash
tailscale file cp dist/P2PShare-0.1.0-portable.exe their-machine:
```

The order that works:

1. Friend downloads the `.exe` from Releases
2. Friend installs Tailscale and signs in
3. You invite them to your tailnet and they accept
4. They run the app, enter the room name and your tailnet address

Windows SmartScreen will warn on first run, because the binary is unsigned —
"More info" then "Run anyway". Signing it needs a code-signing certificate,
which costs money and is not worth it for four friends.

## Layout work without Electron

```bash
node tools/static-server.js
```

Serves `src/` at :5173 for CSS work. `window.capture` and `window.net` do not
exist there, so the picker and Go Live will not run.

## Status

Working: Tailscale detection, embedded signaling, screen and window capture,
system audio on Windows, host → N viewers, live bitrate/fps changes, viewer list
with connection state, invite copy.

Not built: Server (SFU) mode, microphone, voice chat, text chat, the Privacy
setting (the buttons are there; the server does not enforce them yet).

Untested: an actual viewer on another machine. The signaling path is verified
over the tailnet address, but nobody has joined a real stream yet.
