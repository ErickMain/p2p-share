// Standalone signaling server. The app embeds the same module, so this exists
// only for testing and for the case where you'd rather run it on a separate
// always-on machine than inside the host's app.

const { createSignalingServer } = require('./server');

const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '0.0.0.0';

createSignalingServer({ host, port });
console.log(`signaling listening on ws://${host}:${port}`);
