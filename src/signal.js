// Thin wrapper over the signaling WebSocket: connect, join a room, and get
// typed messages out through an EventTarget.

export class Signal extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.id = null;
  }

  connect({ room, role, name, limit }) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      const onFirstError = () =>
        reject(new Error(`cannot reach signaling server at ${this.url}`));
      ws.addEventListener('error', onFirstError, { once: true });

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ t: 'join', room, role, name, limit }));
      });

      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }

        if (msg.t === 'joined') {
          this.id = msg.id;
          ws.removeEventListener('error', onFirstError);
          resolve(msg);
        }
        if (msg.t === 'error' && !this.id) {
          ws.removeEventListener('error', onFirstError);
          reject(new Error(msg.reason));
        }
        this.dispatchEvent(new CustomEvent(msg.t, { detail: msg }));
      });

      ws.addEventListener('close', () => {
        this.dispatchEvent(new CustomEvent('closed'));
      });
    });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  signal(to, data) {
    this.send({ t: 'signal', to, data });
  }

  close() {
    if (this.ws) this.ws.close();
  }
}
