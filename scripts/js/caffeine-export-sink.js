#!/usr/bin/env node
//
// caffeine-export-sink.js
//
// SUPERSEDED (v1.268.0): the Orbit webserver now has this sink built
// in as POST /export-memory?name=… (see website/app-impl.js). Keep
// this standalone script only as a fallback for installed extensions
// that predate that route.
//
// Loopback HTTP sink used when refreshing the Caffeine memory before a
// build (see the "always refresh the Caffeine memory before building"
// section of .github/copilot-instructions.md). Start it, then have the
// shared localhost:8089 page read the caffeine.image / caffeine.changes
// ArrayBuffers out of its IndexedDB and POST them here, where they're
// written to ./website/public/memories/ for the build to repack.
//
// Endpoints:
//   POST /upload?name=caffeine.image|caffeine.changes  -> writes the
//        body to website/public/memories/<name> (allowlisted only).
//   POST /diag                                          -> logs the body
//        to stdout; an out-of-band diagnostics channel, since the page
//        snapshot / read_page does not surface console output reliably.
//
// Usage:
//   node scripts/js/caffeine-export-sink.js
//
const http = require('http');
const fs = require('fs');
const path = require('path');

const DEST_DIR = path.resolve(__dirname, '../../website/public/memories');
const ALLOW = new Set(['caffeine.image', 'caffeine.changes']);
const PORT = 8791;

fs.mkdirSync(DEST_DIR, { recursive: true });

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
    const name = url.searchParams.get('name');
    if (!ALLOW.has(name)) { res.writeHead(400); res.end('bad name'); return; }
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
  console.log(`caffeine-export-sink listening on http://127.0.0.1:${PORT}`);
});
