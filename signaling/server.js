// Signaling: relays SDP offers/answers and ICE candidates between peers.
// Media never touches this process -- it only introduces peers to each other.
//
// It runs inside the host's own Electron process and binds to the host's
// Tailscale address, so there is no server to deploy anywhere. Exported as a
// factory so signaling/cli.js can also run it standalone for testing.

const { WebSocketServer } = require('ws');
const crypto = require('crypto');

/**
 * @param {{host?: string, port?: number}} opts
 * @returns {{port: number, close: () => void}}
 */
function createSignalingServer({ host = '0.0.0.0', port = 8787 } = {}) {
  /** @type {Map<string, {host: any, viewers: Map<string, any>, limit: number}>} */
  const rooms = new Map();
  const wss = new WebSocketServer({ host, port });

  const send = (ws, msg) => {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  function getRoom(name) {
    let room = rooms.get(name);
    if (!room) {
      room = { host: null, viewers: new Map(), limit: 0 };
      rooms.set(name, room);
    }
    return room;
  }

  function dropRoomIfEmpty(name) {
    const room = rooms.get(name);
    if (room && !room.host && room.viewers.size === 0) rooms.delete(name);
  }

  function onJoin(ws, msg) {
    const roomName = String(msg.room || '').trim().toLowerCase();
    if (!roomName) return send(ws, { t: 'error', reason: 'no-room' });

    const room = getRoom(roomName);
    ws.room = roomName;
    ws.name = String(msg.name || 'anon').slice(0, 32);
    ws.role = msg.role === 'host' ? 'host' : 'viewer';

    if (ws.role === 'host') {
      if (room.host) return send(ws, { t: 'error', reason: 'room-taken' });
      room.host = ws;
      room.limit = Number(msg.limit) || 0;
      send(ws, {
        t: 'joined',
        id: ws.id,
        role: 'host',
        // Viewers that arrived before the host went live are waiting for an offer.
        peers: [...room.viewers.values()].map((v) => ({ id: v.id, name: v.name })),
      });
      for (const v of room.viewers.values()) send(v, { t: 'host-here', id: ws.id });
      return;
    }

    if (room.limit > 0 && room.viewers.size >= room.limit) {
      send(ws, { t: 'error', reason: 'room-full' });
      return ws.close();
    }

    room.viewers.set(ws.id, ws);
    send(ws, { t: 'joined', id: ws.id, role: 'viewer', hostPresent: !!room.host });
    // The host is the offerer: tell it a viewer showed up.
    if (room.host) send(room.host, { t: 'peer-join', id: ws.id, name: ws.name });
  }

  function onSignal(ws, msg) {
    const room = rooms.get(ws.room);
    if (!room) return;
    const target =
      room.host && room.host.id === msg.to ? room.host : room.viewers.get(msg.to);
    if (!target) return send(ws, { t: 'peer-gone', id: msg.to });
    send(target, { t: 'signal', from: ws.id, data: msg.data });
  }

  // Host flipped between live and stopped; viewers use this to show a placeholder.
  function onLive(ws, msg) {
    const room = rooms.get(ws.room);
    if (!room || room.host !== ws) return;
    for (const v of room.viewers.values()) send(v, { t: 'live', live: !!msg.live });
  }

  function onLeave(ws) {
    const room = rooms.get(ws.room);
    if (!room) return;

    if (room.host === ws) {
      room.host = null;
      for (const v of room.viewers.values()) send(v, { t: 'host-gone' });
    } else {
      room.viewers.delete(ws.id);
      if (room.host) send(room.host, { t: 'peer-leave', id: ws.id });
    }
    dropRoomIfEmpty(ws.room);
  }

  wss.on('connection', (ws) => {
    ws.id = crypto.randomUUID();
    ws.alive = true;
    ws.on('pong', () => {
      ws.alive = true;
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return send(ws, { t: 'error', reason: 'bad-json' });
      }

      switch (msg.t) {
        case 'join':
          return onJoin(ws, msg);
        case 'signal':
          return onSignal(ws, msg);
        case 'live':
          return onLive(ws, msg);
        case 'bye':
          return ws.close();
        default:
          return send(ws, { t: 'error', reason: 'unknown-type' });
      }
    });

    ws.on('close', () => onLeave(ws));
  });

  // Drop half-open sockets so a crashed host doesn't hold the room name forever.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  return {
    port,
    close: () => {
      clearInterval(heartbeat);
      wss.close();
    },
  };
}

module.exports = { createSignalingServer };
