// Finds this machine's address on the tailnet.
//
// Every node in a tailnet gets a stable address that other nodes can reach
// directly, which is what lets the host act as its own signaling server from
// behind CGNAT. We ask the CLI first because it also tells us whether the node
// is actually logged in; the interface scan is a fallback for odd installs.
//
// Note the IPv4 range is 100.64.0.0/10 -- the same CGNAT range a carrier uses,
// deliberately. So an address in that range proves nothing on its own; it only
// counts when it came from the CLI or from the Tailscale adapter.

const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const CLI_CANDIDATES = {
  win32: [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Tailscale', 'tailscale.exe'),
  ],
  darwin: [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
  ],
  linux: ['/usr/bin/tailscale', '/usr/local/bin/tailscale'],
};

function findCli() {
  for (const candidate of CLI_CANDIDATES[process.platform] || []) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function run(cli, args) {
  return new Promise((resolve) => {
    execFile(cli, args, { timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

/** Last resort: look for the virtual adapter Tailscale installs. */
function fromInterfaces() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (!/tailscale/i.test(name)) continue;
    const v4 = addrs.find((a) => a.family === 'IPv4' && !a.internal);
    if (v4) return v4.address;
  }
  return null;
}

/**
 * @returns {Promise<{ok: boolean, ip: string|null, hostname: string|null, reason: string|null}>}
 */
async function detect() {
  const cli = findCli();

  if (cli) {
    const out = await run(cli, ['ip', '-4']);
    const ip = out && out.split('\n')[0].trim();
    if (ip) {
      const status = await run(cli, ['status', '--self', '--peers=false']);
      const hostname = status ? (status.split(/\s+/)[1] || null) : null;
      return { ok: true, ip, hostname, reason: null };
    }
    // CLI is installed but gave us nothing: almost always a logged-out node.
    const fallback = fromInterfaces();
    if (fallback) return { ok: true, ip: fallback, hostname: null, reason: null };
    return { ok: false, ip: null, hostname: null, reason: 'logged-out' };
  }

  const ip = fromInterfaces();
  if (ip) return { ok: true, ip, hostname: null, reason: null };
  return { ok: false, ip: null, hostname: null, reason: 'not-installed' };
}

module.exports = { detect };
