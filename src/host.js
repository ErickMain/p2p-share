// The broadcasting side. One capture stream, one RTCPeerConnection per viewer.
// Every viewer gets its own encode, which is why upload scales linearly with
// the audience -- the reason a "Server" (SFU) mode exists in the UI.

import { Signal } from './signal.js';
import {
  iceServers,
  applySenderSettings,
  setOpusBitrate,
  signalUrl,
  videoConstraints,
} from './settings.js';

export class Host extends EventTarget {
  constructor(settings) {
    super();
    this.settings = settings;
    this.stream = null;
    this.signal = null;
    /** @type {Map<string, {pc: RTCPeerConnection, name: string}>} */
    this.peers = new Map();
    this.live = false;
  }

  async capture() {
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints(this.settings),
      audio: this.settings.captureAudio,
    });

    const track = this.stream.getVideoTracks()[0];
    // Tells the encoder whether to protect sharpness or smoothness when the
    // bitrate gets tight.
    track.contentHint = this.settings.hint;
    track.addEventListener('ended', () => this.stop());

    this.dispatchEvent(new CustomEvent('stream', { detail: this.stream }));
    return this.stream;
  }

  async goLive(room, name) {
    if (!this.stream) await this.capture();

    this.signal = new Signal(signalUrl());
    await this.signal.connect({
      room,
      role: 'host',
      name,
      limit: this.settings.viewerLimit,
    });

    this.signal.addEventListener('peer-join', (e) => this.#offerTo(e.detail.id, e.detail.name));
    this.signal.addEventListener('peer-leave', (e) => this.#dropPeer(e.detail.id));
    this.signal.addEventListener('peer-gone', (e) => this.#dropPeer(e.detail.id));
    this.signal.addEventListener('signal', (e) => this.#onSignal(e.detail));
    this.signal.addEventListener('closed', () => this.stop());

    this.live = true;
    this.signal.send({ t: 'live', live: true });
    this.#emitPeers();
  }

  async #offerTo(id, name) {
    if (this.peers.has(id)) return;

    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    this.peers.set(id, { pc, name, state: 'new' });

    for (const track of this.stream.getTracks()) {
      const sender = pc.addTrack(track, this.stream);
      if (track.kind === 'video') await applySenderSettings(sender, this.settings);
    }

    pc.addEventListener('icecandidate', (ev) => {
      if (ev.candidate) this.signal.signal(id, { candidate: ev.candidate });
    });
    pc.addEventListener('connectionstatechange', () => {
      const peer = this.peers.get(id);
      if (peer) peer.state = pc.connectionState;
      if (pc.connectionState === 'failed') this.#dropPeer(id);
      this.#emitPeers();
    });

    const offer = await pc.createOffer();
    offer.sdp = setOpusBitrate(offer.sdp, this.settings.audioBitrate);
    await pc.setLocalDescription(offer);
    this.signal.signal(id, { sdp: pc.localDescription });
    this.#emitPeers();
  }

  async #onSignal({ from, data }) {
    const peer = this.peers.get(from);
    if (!peer) return;
    if (data.sdp) {
      await peer.pc.setRemoteDescription(data.sdp);
    } else if (data.candidate) {
      try {
        await peer.pc.addIceCandidate(data.candidate);
      } catch {
        /* candidate arrived after the peer went away */
      }
    }
  }

  #dropPeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.close();
    this.peers.delete(id);
    this.#emitPeers();
  }

  /** Re-applies bitrate/fps to every live sender without renegotiating. */
  async applyLiveSettings(settings) {
    this.settings = { ...this.settings, ...settings };
    const track = this.stream?.getVideoTracks()[0];
    if (track) track.contentHint = this.settings.hint;
    for (const { pc } of this.peers.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
      await applySenderSettings(sender, this.settings);
    }
  }

  #emitPeers() {
    const peers = [...this.peers.entries()].map(([id, p]) => ({
      id,
      name: p.name,
      state: p.state,
    }));
    this.dispatchEvent(new CustomEvent('peers', { detail: peers }));
  }

  stop() {
    for (const { pc } of this.peers.values()) pc.close();
    this.peers.clear();
    if (this.signal) {
      this.signal.send({ t: 'live', live: false });
      this.signal.close();
      this.signal = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.live = false;
    this.dispatchEvent(new CustomEvent('stopped'));
  }
}
