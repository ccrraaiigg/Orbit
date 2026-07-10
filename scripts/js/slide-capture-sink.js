#!/usr/bin/env node
//
// slide-capture-sink.js
//
// Loopback HTTP sink for saving captured images to disk. Used when
// snapshotting the Orbit presentation deck's slides: the shared
// localhost:8089 page (or the Playwright sandbox via page fetch) POSTs
// each slide's PNG bytes here and they are written to a destination
// folder.
//
// Endpoints:
//   POST /upload?name=<file.png>  -> writes the body to <DEST_DIR>/<name>.
//        <name> is sanitized to a basename ending in an image extension.
//   POST /diag                    -> logs the body to stdout (out-of-band
//        diagnostics channel).
//
// Usage:
//   node scripts/js/slide-capture-sink.js [destDir]
//
// destDir defaults to <repo>/presentation-slides.
//
const http = require('http');
const fs = require('fs');
const path = require('path');

const DEST_DIR = path.resolve(
  process.argv[2] || path.resolve(__dirname, '../../presentation-slides')
);
const PORT = 8792;
const OK_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

fs.mkdirSync(DEST_DIR, { recursive: true });

function safeName(name) {
  const base = path.basename(String(name || ''));
  if (!base || base.includes('..')) return null;
  const ext = path.extname(base).toLowerCase();
  if (!OK_EXT.has(ext)) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return null;
  return base;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'POST' && url.pathname === '/diag') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      console.log('DIAG: ' + Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/upload') {
    const name = safeName(url.searchParams.get('name'));
    if (!name) { res.writeHead(400); res.end('bad name'); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const dest = path.join(DEST_DIR, name);
      fs.writeFileSync(dest, buf);
      console.log(`wrote ${dest} (${buf.length} bytes)`);
      res.writeHead(200); res.end(String(buf.length));
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`slide-capture-sink listening on http://127.0.0.1:${PORT}`);
  console.log(`writing to ${DEST_DIR}`);
});
