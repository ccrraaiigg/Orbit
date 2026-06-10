#!/usr/bin/env node
// push-extension.js — Stage the current VSIX in public/uploads/ and push it
// to live Keep sync peers via their tunnel URIs. Can be run independently of
// build-extension.js (e.g. after a manual build or to re-push the same VSIX).
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const WEBSITE = path.join(PROJECT_ROOT, 'website');

// ─── Helpers ────────────────────────────────────────────────────────────────

function getPkg() {
    const pkg = require(path.join(WEBSITE, 'package.json'));
    return {
        version: pkg.version,
        name: pkg.name
    };
}

function getGistId() {
    const gistIdFile = path.join(PROJECT_ROOT, '.keep-sync-gist-id');
    try { return fs.readFileSync(gistIdFile, 'utf8').trim(); } catch (_) {}
    return '28fc3779fbca28dd729b47214910bde1';
}

function getMachineId() {
    try {
        const idFile = path.join(PROJECT_ROOT, '.keep-sync-machine-id');
        return fs.readFileSync(idFile, 'utf8').trim();
    } catch (_) {
        return require('os').hostname();
    }
}

function loadPeerTokens() {
    const tokensFile = path.join(PROJECT_ROOT, '.keep-sync-peer-tokens.json');
    try {
        return JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
    } catch (_) {
        return {};
    }
}

function loadPeersFromGist() {
    const gistId = getGistId();
    const result = spawnSync('gh', ['api', `/gists/${gistId}`], {
        encoding: 'utf8',
        timeout: 15000
    });

    if (result.status !== 0) {
        console.log(`  Failed to fetch Gist: ${(result.stderr || '').trim()}`);
        return [];
    }

    try {
        const gist = JSON.parse(result.stdout);
        const peersJson = gist.files?.['peers.json']?.content;
        if (!peersJson) return [];
        const peers = JSON.parse(peersJson);
        const myMachineId = getMachineId();
        return Object.values(peers.peers || {}).filter(p => p.machineId !== myMachineId && p.tunnelUri);
    } catch (e) {
        console.log(`  Failed to parse Gist peers: ${e.message}`);
        return [];
    }
}

function getMyTunnelUri() {
    const myMachineId = getMachineId();
    const result = spawnSync('gh', ['api', `/gists/${getGistId()}`], {
        encoding: 'utf8',
        timeout: 15000
    });
    if (result.status !== 0) return null;

    try {
        const gist = JSON.parse(result.stdout);
        const peersJson = gist.files?.['peers.json']?.content;
        if (!peersJson) return null;
        const allPeers = JSON.parse(peersJson);
        for (const p of Object.values(allPeers.peers || {})) {
            if (p.machineId === myMachineId && p.tunnelUri) {
                return p.tunnelUri;
            }
        }
    } catch (_) {}
    return null;
}

function getOurConnectToken() {
    const result = spawnSync('devtunnel', ['list', '--json'], {
        encoding: 'utf8',
        timeout: 10000
    });
    if (result.status !== 0) return null;
    try {
        const data = JSON.parse(result.stdout);
        const tunnels = data.tunnels || data;
        const hostname = require('os').hostname().split('.')[0].toLowerCase();
        const orbitTunnel = tunnels.find(t =>
            (t.labels || []).includes('orbit') && (t.labels || []).includes(hostname)
        );
        if (!orbitTunnel) return null;
        const tunnelId = (orbitTunnel.tunnelId || '').replace(/\.\w+$/, '');
        const tokenResult = spawnSync('devtunnel', ['token', tunnelId, '--scope', 'connect', '--json'], {
            encoding: 'utf8', timeout: 10000
        });
        if (tokenResult.status !== 0) {
            console.log(`  Token generation failed: ${(tokenResult.stderr || '').trim()}`);
            return null;
        }
        const parsed = JSON.parse(tokenResult.stdout);
        return parsed.token;
    } catch (e) {
        console.log(`  Token generation error: ${e.message}`);
        return null;
    }
}

// ─── Stage and push ─────────────────────────────────────────────────────────

function stageVsix(vsixPath) {
    const vsixName = path.basename(vsixPath);
    const uploadsDir = path.join(WEBSITE, 'public', 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });

    // Remove old staged VSIXes
    for (const f of fs.readdirSync(uploadsDir)) {
        if (f.startsWith('orbit-') && f.endsWith('.vsix') && f !== vsixName) {
            fs.unlinkSync(path.join(uploadsDir, f));
            console.log(`  Removed old ${f}`);
        }
    }

    fs.copyFileSync(vsixPath, path.join(uploadsDir, vsixName));
    console.log(`  Staged ${vsixName} in public/uploads/`);
    return vsixName;
}

function pushToPeers(vsixPath) {
    console.log('=== Pushing VSIX to tunnel peers ===');

    const vsixSize = fs.statSync(vsixPath).size;
    console.log(`  VSIX size: ${(vsixSize / 1024).toFixed(0)} KB`);

    const vsixName = stageVsix(vsixPath);
    const peerTokens = loadPeerTokens();
    const peers = loadPeersFromGist();

    if (peers.length === 0) {
        console.log('  No reachable peers to notify');
        return;
    }

    const myTunnelUri = getMyTunnelUri();
    if (!myTunnelUri) {
        console.log('  Cannot determine own tunnel URI, skipping peer push');
        return;
    }

    const downloadUrl = `${myTunnelUri.replace(/\/$/, '')}/uploads/${vsixName}`;

    for (const peer of peers) {
        const token = peerTokens[peer.machineId] || null;

        // Liveness check — quick probe with 5s timeout
        const statusUrl = `${peer.tunnelUri.replace(/\/$/, '')}/keep-sync/status`;
        const probe = spawnSync('node', ['-e', `
            const https = require('https');
            const url = new URL(${JSON.stringify(statusUrl)});
            const headers = {};
            ${token ? `headers['X-Tunnel-Authorization'] = 'tunnel ' + ${JSON.stringify(token)};` : ''}
            const req = https.get({
                hostname: url.hostname, port: 443, path: url.pathname,
                headers,
                timeout: 5000
            }, res => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => { process.stdout.write(d); process.exit(res.statusCode === 200 ? 0 : 1); });
            });
            req.on('timeout', () => { req.destroy(); process.exit(1); });
            req.on('error', () => process.exit(1));
        `], { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] });

        if (probe.status !== 0) {
            console.log(`  Skipping ${peer.hostname || peer.machineId}: unreachable`);
            continue;
        }

        const url = `${peer.tunnelUri.replace(/\/$/, '')}/extension/install-vsix`;
        console.log(`  Notifying ${peer.hostname} to fetch from ${downloadUrl}...`);

        const body = JSON.stringify({ url: downloadUrl, token: getOurConnectToken() });
        const notifyResult = spawnSync('node', ['-e', `
            const https = require('https');
            const url = new URL(${JSON.stringify(url)});
            const body = ${JSON.stringify(body)};
            const headers = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            };
            ${token ? `headers['X-Tunnel-Authorization'] = 'tunnel ' + ${JSON.stringify(token)};` : ''}
            const req = https.request({
                hostname: url.hostname,
                port: 443,
                path: url.pathname,
                method: 'POST',
                headers
            }, res => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => {
                    console.log(res.statusCode + ' ' + d);
                    process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
                });
            });
            req.on('error', e => { console.error(e.message); process.exit(1); });
            req.write(body);
            req.end();
        `], { encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });

        if (notifyResult.status === 0) {
            console.log(`  ✓ ${peer.hostname}: ${notifyResult.stdout.trim()}`);
        } else {
            console.log(`  ✗ ${peer.hostname}: ${(notifyResult.stdout || notifyResult.stderr || '').trim()}`);
        }
    }
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
    // Accept an explicit VSIX path as argument, otherwise find the current one
    let vsixPath = process.argv[2];
    if (!vsixPath) {
        const pkg = getPkg();
        vsixPath = path.join(PROJECT_ROOT, `${pkg.name}-${pkg.version}.vsix`);
    }

    if (!fs.existsSync(vsixPath)) {
        console.error(`VSIX not found: ${vsixPath}`);
        console.error('Run build-extension.js first, or pass an explicit VSIX path.');
        process.exit(1);
    }

    pushToPeers(vsixPath);
    console.log('\nDone.');
}

main();
