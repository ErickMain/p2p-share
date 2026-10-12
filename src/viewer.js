// The watching side. Answers the host's offer and hands back a MediaStream.

import { Signal } from './signal.js';
import { iceServers, signalUrl } from './settings.js';

export class Viewer extends EventTarget {
  constructor() {
    super();
    this.signal = null;
    this.pc = null;
    this.hostId = null;
  }

  async join(room, name) {
    this.signal = new Signal(signalUrl());
    const joined = await this.signal.connect({ room, role: 'viewer', name });

    this.signal.addEventListener('signal', (e) => this.#onSignal(e.detail));
    this.signal.addEventListener('host-gone', () => {
      this.#teardownPc();
      this.dispatchEvent(new CustomEvent('status', { detail: 'host left' }));
    });
    this.signal.addEventListener('live', (e) => {
      this.dispatchEvent(
        new CustomEvent('status', { detail: e.detail.live ? 'host is live' : 'host stopped' })
      );
    });
    this.signal.addEventListener('closed', () =>
      this.dispatchEvent(new CustomEvent('status', { detail: 'disconnected' }))
    );

    this.dispatchEvent(
      new CustomEvent('status', {
        detail: joined.hostPresent ? 'waiting for the host to go live' : 'no host in this room yet',
      })
    );
    return joined;
  }

  async #onSignal({ from, data }) {
    if (data.sdp) {
      this.hostId = from;
      if (!this.pc) this.#createPc();
      await this.pc.setRemoteDescription(data.sdp);
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.signal.signal(from, { sdp: this.pc.localDescription });
    } else if (data.candidate && this.pc) {
      try {
        await this.pc.addIceCandidate(data.candidate);
      } catch {
        /* stale candidate */
      }
    }
  }

  #createPc() {
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    this.pc = pc;

    pc.addEventListener('track', (ev) => {
      this.dispatchEvent(new CustomEvent('stream', { detail: ev.streams[0] }));
    });
    pc.addEventListener('icecandidate', (ev) => {
      if (ev.candidate && this.hostId) this.signal.signal(this.hostId, { candidate: ev.candidate });
    });
    pc.addEventListener('connectionstatechange', () => {
      this.dispatchEvent(new CustomEvent('status', { detail: pc.connectionState }));
    });
  }

  #teardownPc() {
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
  }

  leave() {
    this.#teardownPc();
    if (this.signal) {
      this.signal.close();
      this.signal = null;
    }
  }
}
