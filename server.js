'use strict';

/**
 * Minimal HTTP wrapper around inspector.js for Railway (or any host).
 *   GET  /            -> mobile-friendly web UI
 *   GET  /health      -> health check
 *   POST /api/inspect -> { "url": "...", "wait": 20 }  (Authorization: Bearer <AUTH_TOKEN>)
 *
 * Env vars:
 *   AUTH_TOKEN       required, 16+ chars
 *   ALLOWED_HOSTS    optional, comma-separated domains (strongly recommended), e.g. "example.com,cdn.example.com"
 *   MAX_CONCURRENT   optional, default 1
 *   PORT             set automatically by Railway
 *
 * Use only against sites you own or are authorized to test.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns').promises;
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const PORT = Number(process.env.PORT) || 3000;
const TOKEN = process.env.AUTH_TOKEN || '';
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT) || 1);
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

if (TOKEN.length < 16) {
  console.error('Refusing to start: set the AUTH_TOKEN environment variable (at least 16 characters).');
  process.exit(1);
}

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest();

function authorized(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return !!m && crypto.timingSafeEqual(sha(m[1].trim()), sha(TOKEN));
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80')) return true;
    const m = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return m ? isPrivateIp(m[1]) : false;
  }
  return true;
}

async function validateTarget(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are allowed');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
    throw new Error('Host is not in ALLOWED_HOSTS');
  }
  if (host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('Internal hostnames are blocked');
  }
  let addrs;
  try {
    addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  } catch {
    throw new Error('Could not resolve that hostname');
  }
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('Private/internal addresses are blocked');
  return u.href;
}

let running = 0;

function runInspector(url, wait) {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `hls-${crypto.randomUUID()}.json`);
    const args = ['inspector.js', url, '--no-sandbox', '--wait', String(wait), '--timeout', '30', '--out', out];
    execFile(
      process.execPath,
      args,
      { cwd: __dirname, timeout: (wait + 60) * 1000, killSignal: 'SIGKILL', maxBuffer: 5 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let result = null;
        try {
          result = JSON.parse(fs.readFileSync(out, 'utf8'));
        } catch {}
        fs.rm(out, { force: true }, () => {});
        if (result) return resolve(result);
        const msg = String(stderr || stdout || (err && err.message) || 'Inspector failed').trim();
        reject(new Error(msg.slice(0, 500)));
      }
    );
  });
}

function readJson(req, limit = 10 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, {
      'content-type': `${type}; charset=utf-8`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };

  try {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && pathname === '/health') return send(200, { ok: true });
    if (req.method === 'GET' && pathname === '/') return send(200, INDEX_HTML, 'text/html');

    if (req.method === 'POST' && pathname === '/api/inspect') {
      if (!authorized(req)) {
        await sleep(500); // slow down token guessing
        return send(401, { error: 'Unauthorized: wrong or missing token' });
      }
      const body = await readJson(req);
      const wait = Math.min(Math.max(Number(body.wait) || 20, 5), 60);
      let url;
      try {
        url = await validateTarget(String(body.url || ''));
      } catch (err) {
        return send(400, { error: err.message });
      }
      if (running >= MAX_CONCURRENT) return send(429, { error: 'Busy: another inspection is running. Try again shortly.' });

      running++;
      try {
        const result = await runInspector(url, wait);
        return send(200, result);
      } catch (err) {
        return send(500, { error: err.message });
      } finally {
        running--;
      }
    }

    send(404, { error: 'Not found' });
  } catch (err) {
    send(400, { error: err.message || 'Bad request' });
  }
});

server.requestTimeout = 0; // inspections can take a while
server.listen(PORT, '0.0.0.0', () => {
  console.log(`HLS inspector listening on :${PORT}` + (ALLOWED_HOSTS.length ? ` (allowed hosts: ${ALLOWED_HOSTS.join(', ')})` : ' (no ALLOWED_HOSTS set)'));
});
