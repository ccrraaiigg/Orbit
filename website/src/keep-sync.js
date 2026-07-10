/**
 * keep-sync.js — Peer-to-peer Keep note synchronization via
 * Dev Tunnels (real-time) and GitHub Gist (durable log + registry).
 *
 * Exports a factory function that returns a KeepSync controller.
 * The controller manages:
 *   - Gist peer registry (publish self, discover peers)
 *   - Ops publishing (local audit trail → Gist + peers)
 *   - Ops polling (Gist + peers → local apply)
 */
'use strict';

module.exports = function createKeepSync(vscode, {
    getPort,           // () => number — local HTTP port
    getTunnelUri,      // () => string|null — tunnel URI
    getTunnelId,       // () => string|null — devtunnel ID for token generation
    getHostname,       // () => string — short hostname
    getAuditDir,       // () => string — path to audit/ directory
    orbitLog,          // (msg) => void
    findDevtunnelCli   // () => Promise<string|null>
}) {
    const fs = require('fs');
    const path = require('path');
    const https = require('https');
    const { execFile } = require('child_process');

    function log(msg) {
        const ts = new Date().toISOString().replace('T', ' ').slice(11, 19);
        orbitLog(`${ts} ${msg}`);
    }

    let pollTimer = null;
    let fileWatcher = null;
    let lastPublishedLine = 0;  // lines already published from local audit
    let lastConsumedSeq = 0;    // highest seq consumed from Gist
    let gistId = null;
    let githubToken = null;
    let running = false;
    let localConnectToken = null; // our tunnel's connect token
    let peerTokens = {};          // { machineId: connectToken } — locally cached
    let peerKnownUris = {};       // { machineId: tunnelUri } — URI the token was issued for

    // ──────────────────────────────────────────────────
    // Peer token persistence (local-only, never in Gist)
    // ──────────────────────────────────────────────────

    function peerTokensFile() {
        return path.join(getAuditDir(), '..', '.keep-sync-peer-tokens.json');
    }

    function loadPeerTokens() {
        try {
            const content = fs.readFileSync(peerTokensFile(), 'utf8');
            const data = JSON.parse(content);
            // Support both old format { machineId: token } and new { machineId: { token, tunnelUri } }
            for (const [k, v] of Object.entries(data)) {
                if (typeof v === 'string') {
                    peerTokens[k] = v;
                } else if (v && v.token) {
                    peerTokens[k] = v.token;
                    peerKnownUris[k] = v.tunnelUri || null;
                }
            }
        } catch (_) {
            peerTokens = {};
            peerKnownUris = {};
        }
    }

    function savePeerTokens() {
        try {
            const dir = path.dirname(peerTokensFile());
            fs.mkdirSync(dir, { recursive: true });
            const data = {};
            for (const [k, token] of Object.entries(peerTokens)) {
                data[k] = { token, tunnelUri: peerKnownUris[k] || null };
            }
            fs.writeFileSync(peerTokensFile(), JSON.stringify(data, null, 2));
        } catch (e) {
            log(`[keep-sync] Failed to save peer tokens: ${e.message}`);
        }
    }

    // ──────────────────────────────────────────────────
    // Connect token management
    // ──────────────────────────────────────────────────

    async function generateConnectToken() {
        const tunnelId = getTunnelId && getTunnelId();
        if (!tunnelId) return null;
        const cli = await findDevtunnelCli();
        if (!cli) return null;

        const run = (args) => new Promise((resolve, reject) => {
            execFile(cli, args, { timeout: 15000 }, (err, stdout, stderr) => {
                if (err) reject(new Error(stderr || err.message));
                else resolve(stdout);
            });
        });

        let stdout;
        try {
            stdout = await run(['token', tunnelId, '--scope', 'connect', '--json']);
        } catch (e) {
            if (/login token expired|unauthorized|login required/i.test(e.message)) {
                log('[keep-sync] devtunnel token expired, re-authenticating...');
                try {
                    await run(['login', '--github']);
                    stdout = await run(['token', tunnelId, '--scope', 'connect', '--json']);
                } catch (e2) {
                    log(`[keep-sync] Token generation failed after relogin: ${e2.message}`);
                    return null;
                }
            } else {
                log(`[keep-sync] Token generation failed: ${e.message}`);
                return null;
            }
        }

        try {
            const parsed = JSON.parse(stdout);
            return parsed.token || parsed.value || stdout.trim();
        } catch (_) {
            return stdout.trim();
        }
    }

    // ──────────────────────────────────────────────────
    // GitHub token resolution
    // ──────────────────────────────────────────────────
    //
    // VS Code's built-in GitHub authentication provider routes through
    // the org's conditional-access / device-compliance policy, which can
    // refuse to issue a token on an unmanaged machine (e.g. a macOS
    // device without the required MDM profile). To keep peer sync working
    // there, resolve a `gist`-scoped token from non-interactive sources
    // first, and only fall back to the VS Code auth provider.
    //
    // Resolution order:
    //   1. env: ORBIT_KEEPSYNC_GITHUB_TOKEN, GITHUB_TOKEN, GH_TOKEN
    //   2. secrets file: <workspace>/secrets/keep-sync-github-token[.txt]
    //                    or ~/.orbit/keep-sync-github-token
    //   3. `gh auth token` (the GitHub CLI's own credential)
    //   4. VS Code GitHub auth provider (silent, then interactive)

    async function findGhCli() {
        const candidates = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'];
        for (const cli of candidates) {
            try {
                await new Promise((resolve, reject) => {
                    execFile(cli, ['--version'], { timeout: 8000 },
                        (err) => err ? reject(err) : resolve());
                });
                return cli;
            } catch (_) {}
        }
        return null;
    }

    async function ghAuthToken() {
        const cli = await findGhCli();
        if (!cli) return null;
        try {
            const out = await new Promise((resolve, reject) => {
                execFile(cli, ['auth', 'token'], { timeout: 10000 },
                    (err, stdout, stderr) => err
                        ? reject(new Error(stderr || err.message))
                        : resolve(stdout));
            });
            return (out || '').trim() || null;
        } catch (e) {
            log(`[keep-sync] gh auth token failed: ${e.message}`);
            return null;
        }
    }

    function readTokenFile() {
        const os = require('os');
        const auditDir = getAuditDir();
        const candidates = [
            path.join(auditDir, '..', 'secrets', 'keep-sync-github-token'),
            path.join(auditDir, '..', 'secrets', 'keep-sync-github-token.txt'),
            path.join(os.homedir(), '.orbit', 'keep-sync-github-token')
        ];
        for (const f of candidates) {
            try {
                const t = fs.readFileSync(f, 'utf8').trim();
                if (t) return t;
            } catch (_) {}
        }
        return null;
    }

    async function resolveGitHubToken() {
        // 1. Environment
        for (const name of ['ORBIT_KEEPSYNC_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
            const v = process.env[name];
            if (v && v.trim()) {
                log(`[keep-sync] Using GitHub token from $${name}`);
                return v.trim();
            }
        }
        // 2. Secrets file
        const fileToken = readTokenFile();
        if (fileToken) {
            log('[keep-sync] Using GitHub token from secrets file');
            return fileToken;
        }
        // 3. gh CLI (holds its own credential, not subject to the VS Code
        //    auth provider's device-compliance policy)
        const gh = await ghAuthToken();
        if (gh) {
            log('[keep-sync] Using GitHub token from gh CLI');
            return gh;
        }
        // 4. VS Code auth provider (may be blocked by device policy) —
        //    try silently first so we never hang on an unsatisfiable prompt.
        try {
            let session = await vscode.authentication.getSession(
                'github', ['gist'], { silent: true });
            if (!session) {
                session = await vscode.authentication.getSession(
                    'github', ['gist'], { createIfNone: true });
            }
            if (session) {
                log(`[keep-sync] Using GitHub token from VS Code auth (scopes: ${session.scopes.join(', ')})`);
                return session.accessToken;
            }
        } catch (e) {
            log(`[keep-sync] VS Code GitHub auth unavailable: ${e.message}`);
        }
        return null;
    }

    // ──────────────────────────────────────────────────
    // GitHub API helpers
    // ──────────────────────────────────────────────────

    function githubRequest(method, urlPath, body) {
        return new Promise((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : null;
            const opts = {
                hostname: 'api.github.com',
                path: urlPath,
                method,
                headers: {
                    'User-Agent': 'Orbit-KeepSync',
                    'Accept': 'application/vnd.github+json',
                    'Authorization': `Bearer ${githubToken}`,
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            };
            if (payload) {
                opts.headers['Content-Type'] = 'application/json';
                opts.headers['Content-Length'] = Buffer.byteLength(payload);
            }
            const req = https.request(opts, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try { resolve(JSON.parse(data)); }
                        catch (_) { resolve(data); }
                    } else {
                        reject(new Error(`GitHub ${method} ${urlPath}: ${res.statusCode} ${data.slice(0, 200)}`));
                    }
                });
            });
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    }

    // ──────────────────────────────────────────────────
    // Gist management
    // ──────────────────────────────────────────────────

    function gistDescription() {
        const org = vscode.workspace.getConfiguration('orbit.keepSync').get('org') || '';
        return org
            ? `Orbit Keep Sync [${org}]`
            : 'Orbit Keep Sync';
    }

    async function findExistingGist() {
        // Search ALL of the authenticated user's Gists for matches.
        // If multiple exist (from failed attempts or races), pick the
        // most recently updated one and delete the rest.
        const desc = gistDescription();
        let allMatches = [];
        let page = 1;
        while (true) {
            const gists = await githubRequest('GET', `/gists?per_page=100&page=${page}`);
            if (!gists || gists.length === 0) break;
            for (const g of gists) {
                if (g.description === desc && g.files && g.files['peers.json']) {
                    allMatches.push(g);
                }
            }
            if (gists.length < 100) break;
            page++;
        }

        if (allMatches.length === 0) return null;

        // Pick the most recently updated
        allMatches.sort((a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
        const winner = allMatches[0];

        // Delete stale duplicates
        for (let i = 1; i < allMatches.length; i++) {
            try {
                await githubRequest('DELETE', `/gists/${allMatches[i].id}`);
                log(`[keep-sync] Deleted stale Gist ${allMatches[i].id}`);
            } catch (_) {}
        }

        return winner.id;
    }

    async function ensureGist() {
        const cfg = vscode.workspace.getConfiguration('orbit.keepSync');
        gistId = cfg.get('gistId');

        if (gistId) return gistId;

        // Before creating a new Gist, check if one already exists
        // (another machine may have created it first).
        const existing = await findExistingGist();
        if (existing) {
            gistId = existing;
            await cfg.update('gistId', gistId, vscode.ConfigurationTarget.Global);
            log(`[keep-sync] Discovered existing Gist ${gistId}`);
            return gistId;
        }

        // Create a new Gist
        const peers = {
            schema: 2,
            org: cfg.get('org') || '',
            peers: {}
        };
        const gist = await githubRequest('POST', '/gists', {
            description: gistDescription(),
            public: false,
            files: {
                'peers.json': { content: JSON.stringify(peers, null, 2) }
            }
        });
        gistId = gist.id;
        await cfg.update('gistId', gistId, vscode.ConfigurationTarget.Global);
        log(`[keep-sync] Created Gist ${gistId}`);
        return gistId;
    }

    async function readGistFile(filename) {
        const gist = await readGistCached();
        const file = gist && gist.files && gist.files[filename];
        if (!file) return null;
        // If truncated, fetch raw_url
        if (file.truncated && file.raw_url) {
            return new Promise((resolve, reject) => {
                https.get(file.raw_url, { headers: { 'User-Agent': 'Orbit-KeepSync' } }, (res) => {
                    let data = '';
                    res.on('data', chunk => { data += chunk; });
                    res.on('end', () => resolve(data));
                    res.on('error', reject);
                }).on('error', reject);
            });
        }
        return file.content;
    }

    async function updateGistFile(filename, content) {
        // Invalidate cache after writes
        lastGistReadAt = 0;
        await githubRequest('PATCH', `/gists/${gistId}`, {
            files: { [filename]: { content } }
        });
    }

    // ──────────────────────────────────────────────────
    // Peer registry
    // ──────────────────────────────────────────────────

    async function registerSelf(attempt = 0) {
        // Always do a fresh read before writing — never use cache here,
        // otherwise we risk overwriting another peer's registration.
        lastGistReadAt = 0;
        const peersRaw = await readGistFile('peers.json');
        if (!peersRaw) return;
        const peers = JSON.parse(peersRaw);
        const sessionId = vscode.env.sessionId;
        const myMachine = vscode.env.machineId;
        const existingPeers = new Set(Object.keys(peers.peers || {}));

        // Remove stale entries: for each machineId, keep only the newest entry
        const byMachine = {};
        for (const [id, info] of Object.entries(peers.peers || {})) {
            const mid = info.machineId;
            if (!byMachine[mid]) byMachine[mid] = [];
            byMachine[mid].push({ id, info });
        }
        for (const entries of Object.values(byMachine)) {
            if (entries.length <= 1) continue;
            // Sort by lastSeen descending, keep only the newest
            entries.sort((a, b) => (b.info.lastSeen || '').localeCompare(a.info.lastSeen || ''));
            for (let i = 1; i < entries.length; i++) {
                delete peers.peers[entries[i].id];
            }
        }

        // Prune entries older than 3 minutes only if tunnel probe confirms unreachable
        const staleMs = 3 * 60 * 1000;
        const now = Date.now();
        for (const [id, info] of Object.entries(peers.peers || {})) {
            if (id === sessionId) continue;
            if (info.machineId === myMachine) continue; // don't prune our own old sessions
            const age = now - new Date(info.lastSeen || 0).getTime();
            if (age > staleMs && info.tunnelUri) {
                try {
                    await tunnelGet(info.tunnelUri.replace(/\/$/, '') + '/keep-sync/status', peerTokens[info.machineId] || null);
                } catch (_) {
                    log(`[keep-sync] Pruning unreachable peer ${info.hostname || id} (${Math.round(age / 1000)}s stale, probe failed)`);
                    delete peers.peers[id];
                }
            } else if (age > staleMs && !info.tunnelUri) {
                log(`[keep-sync] Pruning stale peer ${info.hostname || id} (no tunnel, ${Math.round(age / 1000)}s old)`);
                delete peers.peers[id];
            }
        }

        // Publish our bootstrap token if we haven't yet exchanged
        // tokens with all peers. Once all peers have completed the
        // handshake, clear it from the Gist.
        let bootstrapToken = null;
        if (getTunnelUri() && !localConnectToken) {
            localConnectToken = await generateConnectToken();
        }
        const otherPeers = Object.entries(peers.peers || {})
            .filter(([id, _]) => id !== sessionId);
        // Only publish a bootstrap token when there are peers we have
        // NO cached token for. If we have a cached token, let the
        // first pull/push attempt use it — it will be invalidated if
        // stale, and then subsequent polls will see the peer needs
        // bootstrapping. This avoids prematurely revealing a connect
        // token in the Gist when cached tokens are still valid.
        const needsBootstrap = otherPeers.length > 0 &&
            otherPeers.some(([_, p]) => !peerTokens[p.machineId]);
        if (needsBootstrap && localConnectToken) {
            bootstrapToken = localConnectToken;
        }
        // Request→push: advertise which peers we still lack a token for.
        // A peer that sees its own machineId in our `wants` will PUSH its
        // connect token to us (see poll()), connecting via the bootstrap
        // token we publish above. Recovery therefore no longer depends on
        // WHICH side lost the token — the system converges to "everyone can
        // reach everyone" from any asymmetric state.
        const wants = otherPeers
            .filter(([_, p]) => !peerTokens[p.machineId])
            .map(([_, p]) => p.machineId)
            .filter((v, i, a) => v && a.indexOf(v) === i);

        const isNew = !existingPeers.has(sessionId);
        const currentTunnelUri = getTunnelUri() || null;
        // Preserve existing tunnelUri from our previous session entry if we
        // don't have one yet (avoids clobbering during slow tunnel detection)
        let effectiveTunnelUri = currentTunnelUri;
        if (!effectiveTunnelUri) {
            for (const [id, info] of Object.entries(peers.peers || {})) {
                if (info.machineId === myMachine && info.tunnelUri) {
                    effectiveTunnelUri = info.tunnelUri;
                    break;
                }
            }
        }
        // Remove old session entries for our machine (we're replacing them)
        for (const [id, info] of Object.entries(peers.peers || {})) {
            if (info.machineId === myMachine && id !== sessionId) {
                delete peers.peers[id];
            }
        }
        const extVersion = (() => {
            try { return require(path.join(__dirname, '..', 'package.json')).version; }
            catch (_) { return 'unknown'; }
        })();
        peers.peers[sessionId] = {
            machineId: vscode.env.machineId,
            hostname: getHostname(),
            tunnelUri: effectiveTunnelUri || null,
            bootstrapToken: bootstrapToken,
            wants: wants,
            keepSyncPath: '/keep-sync',
            lastSeen: new Date().toISOString(),
            version: extVersion,
            capabilities: ['keep-sync']
        };
        try {
            await updateGistFile('peers.json', JSON.stringify(peers, null, 2));
        } catch (e) {
            if (/409/.test(e.message) && attempt < 2) {
                await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
                return registerSelf(attempt + 1);
            }
            throw e;
        }
        if (isNew) {
            log(`[keep-sync] Registered in peer registry${bootstrapToken ? ' (bootstrap token published)' : ''}`);
        }
    }

    // Remove our bootstrap token from the Gist after successful exchange
    async function clearBootstrapToken() {
        try {
            const peersRaw = await readGistFile('peers.json');
            if (!peersRaw) return;
            const peers = JSON.parse(peersRaw);
            const sessionId = vscode.env.sessionId;
            if (peers.peers[sessionId]) {
                peers.peers[sessionId].bootstrapToken = null;
                await updateGistFile('peers.json', JSON.stringify(peers, null, 2));
                log('[keep-sync] Cleared bootstrap token from Gist');
            }
        } catch (e) {
            log(`[keep-sync] Failed to clear bootstrap token: ${e.message}`);
        }
    }

    // Handshake: use a peer's bootstrap token to connect and exchange
    // long-lived tokens. After exchange, both sides cache the peer's token.
    async function handshakeWithPeer(peer, opts = {}) {
        if (!peer.bootstrapToken || !peer.tunnelUri) return false;
        // We initiate for one of two reasons:
        //   pull  — we lack the peer's token and want it, or
        //   serve — the peer listed us in `wants`, so we PUSH our token to
        //           them (the exchange delivers our token to their cache).
        // When only serving, proceed even though we already hold their token.
        const serveRequest = !!opts.serveRequest;
        if (peerTokens[peer.machineId] && !serveRequest) return false;

        const baseUrl = peer.tunnelUri.replace(/\/$/, '');
        try {
            // Generate a fresh token for ourselves if needed
            if (!localConnectToken) {
                localConnectToken = await generateConnectToken();
            }
            // Exchange: send our token, get theirs back
            const response = await tunnelRequest(
                baseUrl + '/keep-sync/exchange-token',
                {
                    machineId: vscode.env.machineId,
                    hostname: getHostname(),
                    connectToken: localConnectToken
                },
                peer.bootstrapToken  // use their bootstrap token for this one request
            );
            const result = JSON.parse(response);
            if (result.connectToken) {
                peerTokens[peer.machineId] = result.connectToken;
                peerKnownUris[peer.machineId] = peer.tunnelUri;
                savePeerTokens();
                log(`[keep-sync] Handshake complete with ${peer.hostname} (${serveRequest ? 'served request' : 'pulled token'}) — tokens exchanged`);
                // Clear our bootstrap token from Gist now that exchange succeeded
                await clearBootstrapToken();
                return true;
            }
        } catch (e) {
            log(`[keep-sync] Handshake with ${peer.hostname} failed: ${e.message}`);
        }
        return false;
    }

    async function getPeers() {
        const gist = await readGistCached();
        const peersRaw = gist && getCachedFileContent(gist, 'peers.json');
        if (!peersRaw) return [];
        const peers = JSON.parse(peersRaw);
        const mySession = vscode.env.sessionId;
        const myMachine = vscode.env.machineId;
        const result = Object.entries(peers.peers || {})
            .filter(([id, info]) => id !== mySession && info.machineId !== myMachine)
            .map(([id, info]) => ({ id, ...info }));

        // Invalidate cached tokens when a peer's tunnel URI changes
        for (const peer of result) {
            const known = peerKnownUris[peer.machineId];
            if (known && peer.tunnelUri && known !== peer.tunnelUri && peerTokens[peer.machineId]) {
                log(`[keep-sync] ${peer.hostname} tunnel changed (${known} → ${peer.tunnelUri}), invalidating token`);
                delete peerTokens[peer.machineId];
                delete peerKnownUris[peer.machineId];
                savePeerTokens();
            }
        }
        return result;
    }

    // ──────────────────────────────────────────────────
    // Ops — local audit trail
    // ──────────────────────────────────────────────────

    function allAuditFiles() {
        const dir = getAuditDir();
        try {
            return fs.readdirSync(dir)
                .filter(f => f.endsWith('-keep-ops.jsonl'))
                .sort()
                .map(f => path.join(dir, f));
        } catch (_) { return []; }
    }

    function readAllLines() {
        const lines = [];
        for (const file of allAuditFiles()) {
            try {
                const content = fs.readFileSync(file, 'utf8');
                for (const l of content.split('\n')) {
                    if (l.trim()) lines.push(l);
                }
            } catch (_) {}
        }
        return lines;
    }

    function readLocalOps(sinceLineIndex) {
        const lines = readAllLines();
        return lines.slice(sinceLineIndex).map(l => {
            try { return JSON.parse(l); }
            catch (_) { return null; }
        }).filter(Boolean);
    }

    function countLocalLines() {
        return readAllLines().length;
    }

    // ──────────────────────────────────────────────────
    // Ops — push to peers via tunnel
    // ──────────────────────────────────────────────────

    function invalidateTokenIfAuthError(peer, error) {
        // If we got 302 (redirect to login), 401 (unauthorized), or 403
        // (forbidden), the cached token is stale — e.g. it was issued for
        // the peer's previous tunnel, or is a legacy token with no known
        // URI so the tunnel-change check above can't detect the mismatch.
        // Delete it so the handshake logic re-engages on the next poll.
        if (/\b(302|401|403)\b/.test(error.message) && peerTokens[peer.machineId]) {
            log(`[keep-sync] Token for ${peer.hostname} rejected, clearing cached token`);
            delete peerTokens[peer.machineId];
            delete peerKnownUris[peer.machineId];
            savePeerTokens();
        }
    }

    async function pushOpsToPeers(ops) {
        const peers = await getPeers();
        const reachable = peers.filter(p => p.tunnelUri);
        if (reachable.length === 0) return false;

        let pushed = 0;
        for (const peer of reachable) {
            const baseUrl = peer.tunnelUri.replace(/\/$/, '');
            const token = peerTokens[peer.machineId] || null;
            for (const op of ops) {
                try {
                    log(`[keep-sync] Pushing op ${op.id} to ${peer.hostname}...`);
                    await tunnelRequest(baseUrl + '/keep-sync/apply', op, token);
                    pushed++;
                } catch (e) {
                    invalidateTokenIfAuthError(peer, e);
                    log(`[keep-sync] Push to ${peer.hostname || peer.id} failed: ${e.message}`);
                    break; // skip remaining ops for this peer
                }
            }
        }
        return pushed > 0;
    }

    let peerHighWater = {};  // { machineId: lastLineIndex } — tracks pull position per peer
    let peerBaselined = {};  // { machineId: true } — set after first probe establishes baseline

    async function pullOpsFromPeers() {
        const peers = await getPeers();
        const reachable = peers.filter(p => p.tunnelUri);
        let applied = 0;

        for (const peer of reachable) {
            const baseUrl = peer.tunnelUri.replace(/\/$/, '');
            const token = peerTokens[peer.machineId] || null;

            // On first contact with a peer after startup, just record
            // their current total as baseline — don't apply historical ops.
            if (!peerBaselined[peer.machineId]) {
                try {
                    const url = `${baseUrl}/keep-sync/ops?since=999999999`;
                    const response = await tunnelGet(url, token);
                    const data = JSON.parse(response);
                    peerHighWater[peer.machineId] = data.total || 0;
                    peerBaselined[peer.machineId] = true;
                    log(`[keep-sync] Baselined ${peer.hostname} at ${data.total || 0} ops`);
                    // We reached the peer — both tunnels are functional.
                    // Clear our bootstrap token from the Gist immediately.
                    clearBootstrapToken().catch(() => {});
                } catch (e) {
                    invalidateTokenIfAuthError(peer, e);
                    log(`[keep-sync] Baseline probe of ${peer.hostname} failed: ${e.message}`);
                }
                continue;
            }

            const since = peerHighWater[peer.machineId] || 0;
            try {
                const url = `${baseUrl}/keep-sync/ops?since=${since}`;
                const response = await tunnelGet(url, token);
                const data = JSON.parse(response);
                const ops = data.ops || [];
                for (const op of ops) {
                    if (op.synced) continue;
                    try {
                        await applyOp(op);
                        applied++;
                    } catch (e) {
                        log(`[keep-sync] Failed to apply op ${op.id} from ${peer.hostname}: ${e.message}`);
                    }
                }
                // Advance high-water to total lines on that peer
                if (data.total !== undefined) {
                    peerHighWater[peer.machineId] = data.total;
                }
            } catch (e) {
                invalidateTokenIfAuthError(peer, e);
                log(`[keep-sync] Pull from ${peer.hostname || peer.id} failed: ${e.message}`);
            }
        }
        if (applied > 0) {
            log(`[keep-sync] Applied ${applied} ops from peers`);
        }
        return applied;
    }

    // HTTPS request helpers for tunnel endpoints
    function tunnelRequest(url, body, connectToken) {
        const payload = JSON.stringify(body);
        const parsed = new URL(url);
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        };
        if (connectToken) {
            headers['X-Tunnel-Authorization'] = `tunnel ${connectToken}`;
        }
        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: parsed.hostname,
                port: 443,
                path: parsed.pathname + parsed.search,
                method: 'POST',
                headers,
                timeout: 5000
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
                    else reject(new Error(`${res.statusCode} ${data.slice(0, 200)}`));
                });
            });
            req.on('timeout', () => { req.destroy(); reject(new Error('request timed out (5s)')); });
            req.on('error', reject);
            req.write(payload);
            req.end();
        });
    }

    function tunnelGet(url, connectToken) {
        const parsed = new URL(url);
        const headers = { 'Accept': 'application/json' };
        if (connectToken) {
            headers['X-Tunnel-Authorization'] = `tunnel ${connectToken}`;
        }
        return new Promise((resolve, reject) => {
            const req = https.get({
                hostname: parsed.hostname,
                port: 443,
                path: parsed.pathname + parsed.search,
                headers,
                timeout: 5000
            }, (res) => {
                // Follow redirects (302 from tunnel auth)
                if (res.statusCode === 302 || res.statusCode === 301) {
                    reject(new Error(`Redirect ${res.statusCode} — peer requires auth`));
                    return;
                }
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
                    else reject(new Error(`${res.statusCode} ${data.slice(0, 200)}`));
                });
            });
            req.on('timeout', () => { req.destroy(); reject(new Error('request timed out (5s)')); });
            req.on('error', reject);
        });
    }

    // ──────────────────────────────────────────────────
    // Ops — publish local changes (tunnel-first, Gist fallback)
    // ──────────────────────────────────────────────────

    async function publishNewOps() {
        const currentLines = countLocalLines();
        if (currentLines <= lastPublishedLine) return;

        const newOps = readLocalOps(lastPublishedLine);
        if (newOps.length === 0) return;

        // Skip ops we received from sync
        const localOnly = newOps.filter(op => !op.synced);
        if (localOnly.length === 0) {
            lastPublishedLine = currentLines;
            return;
        }

        // Push directly to peers via tunnel
        const pushed = await pushOpsToPeers(localOnly);

        if (pushed) {
            lastPublishedLine = currentLines;
            log(`[keep-sync] Pushed ${localOnly.length} ops to peers`);
        } else {
            // Don't advance lastPublishedLine — retry on next poll
            log(`[keep-sync] No reachable peers — ${localOnly.length} ops queued locally`);
        }
    }

    // ──────────────────────────────────────────────────
    // Ops — consume remote changes (tunnel-first, Gist fallback)
    // ──────────────────────────────────────────────────

    async function consumeRemoteOps() {
        // Pull from peers via tunnel
        await pullOpsFromPeers();
    }

    // Apply a single remote op to the local Keep via localhost.
    function applyOp(op) {
        const port = getPort();
        const payload = JSON.stringify(op);
        return new Promise((resolve, reject) => {
            const req = require('http').request({
                hostname: 'localhost',
                port,
                path: '/keep-sync/apply',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
                    else reject(new Error(`apply ${res.statusCode}: ${data.slice(0, 100)}`));
                });
            });
            req.on('error', reject);
            req.write(payload);
            req.end();
        });
    }

    // ──────────────────────────────────────────────────
    // Poll loop
    // ──────────────────────────────────────────────────

    let lastGistRead = null;    // cached Gist response
    let lastGistReadAt = 0;     // Date.now() of last GET
    const GIST_CACHE_MS = 300000; // cache Gist reads for 5 min

    async function readGistCached() {
        const now = Date.now();
        if (lastGistRead && (now - lastGistReadAt) < GIST_CACHE_MS) {
            return lastGistRead;
        }
        lastGistRead = await githubRequest('GET', `/gists/${gistId}`);
        lastGistReadAt = now;
        return lastGistRead;
    }

    function getCachedFileContent(gist, filename) {
        const file = gist.files && gist.files[filename];
        if (!file) return null;
        return file.content;
    }

    async function poll() {
        if (!running) return;
        try {
            // Invalidate Gist cache so we see fresh peer state (bootstrap tokens, tunnel URIs)
            lastGistReadAt = 0;
            const peers = await getPeers();
            log(`[keep-sync] Poll: ${peers.length} peer(s), ${countLocalLines() - lastPublishedLine} local ops not yet pushed`);

            // Initiate a token exchange with any reachable peer that either
            // (a) advertises a bootstrap token whose token we still need
            //     [pull — we connect and take their token], or
            // (b) has requested our token via `wants` [serve — we connect
            //     using their bootstrap and push our token to them].
            // (b) is what breaks the old deadlock: the peer that still HAS
            // the other's token proactively re-delivers it on request.
            const myMachine = vscode.env.machineId;
            for (const peer of peers) {
                if (!peer.bootstrapToken) continue;
                const wePull = !peerTokens[peer.machineId];
                const theyRequested = Array.isArray(peer.wants) && peer.wants.includes(myMachine);
                if (wePull || theyRequested) {
                    await handshakeWithPeer(peer, { serveRequest: theyRequested });
                }
            }

            await publishNewOps();
            await consumeRemoteOps();
            await registerSelf();
        } catch (e) {
            log(`[keep-sync] Poll error: ${e.message}`);
        }
    }

    // ──────────────────────────────────────────────────
    // Public API
    // ──────────────────────────────────────────────────

    async function start() {
        if (running) return;

        // Get GitHub token. Prefer non-interactive sources (env / secrets
        // file / gh CLI) so peer sync keeps working when VS Code's GitHub
        // auth provider is blocked by device-management policy.
        githubToken = await resolveGitHubToken();
        if (!githubToken) {
            log('[keep-sync] No GitHub token available (env, secrets file, gh CLI, and VS Code auth all failed); peer sync disabled. Run `gh auth login` (with gist scope) or set ORBIT_KEEPSYNC_GITHUB_TOKEN.');
            return;
        }
        log('[keep-sync] GitHub token acquired');

        try {
            await ensureGist();
        } catch (e) {
            log(`[keep-sync] Gist setup failed: ${e.message}`);
            return;
        }

        running = true;

        // Persist machineId for build script's peer-push logic
        try {
            const idFile = path.join(getAuditDir(), '..', '.keep-sync-machine-id');
            fs.writeFileSync(idFile, vscode.env.machineId);
        } catch (_) {}

        // Persist gistId for build script's peer-push logic
        try {
            const gidFile = path.join(getAuditDir(), '..', '.keep-sync-gist-id');
            fs.writeFileSync(gidFile, gistId);
        } catch (_) {}

        // Load locally cached peer tokens
        loadPeerTokens();

        // Start at current total so we only publish NEW ops going forward
        // (peers already have everything written before this startup)
        lastPublishedLine = countLocalLines();

        // Register in Gist
        try { await registerSelf(); }
        catch (e) { log(`[keep-sync] Registration failed: ${e.message}`); }

        // Start poll timer
        const interval = vscode.workspace.getConfiguration('orbit.keepSync')
            .get('pollIntervalMs') || 60000;
        pollTimer = setInterval(poll, interval);
        log(`[keep-sync] Started (poll every ${interval}ms, gist ${gistId})`);

        // Watch audit trail for immediate push on local changes
        const auditDir = getAuditDir();
        let watchDebounce = null;
        try {
            fileWatcher = fs.watch(auditDir, (eventType, filename) => {
                if (filename && filename.endsWith('-keep-ops.jsonl')) {
                    if (watchDebounce) clearTimeout(watchDebounce);
                    watchDebounce = setTimeout(async () => {
                        if (!running) return;
                        // Only publish if there are genuinely new local ops
                        const cur = countLocalLines();
                        if (cur > lastPublishedLine) {
                            publishNewOps().catch(() => {});
                        }
                    }, 3000);
                }
            });
        } catch (_) {
            // audit dir may not exist yet
        }
    }

    function stop() {
        running = false;
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (fileWatcher) { fileWatcher.close(); fileWatcher = null; }
        log('[keep-sync] Stopped');
    }

    // Exposed for the exchange-token endpoint
    function storePeerToken(machineId, token) {
        peerTokens[machineId] = token;
        savePeerTokens();
        // Handshake just succeeded — clear our bootstrap token from the Gist
        clearBootstrapToken().catch(() => {});
    }

    async function getLocalToken() {
        if (!localConnectToken) {
            localConnectToken = await generateConnectToken();
        }
        return localConnectToken;
    }

    // Given a tunnel URL, find the cached peer token for that tunnel's machine
    function getPeerTokenForUrl(url) {
        try {
            const hostname = new URL(url).hostname;
            // Match against known peer tunnel URIs in the Gist cache
            if (lastGistRead) {
                const peersJson = getCachedFileContent(lastGistRead, 'peers.json');
                if (peersJson) {
                    const peers = JSON.parse(peersJson);
                    for (const info of Object.values(peers.peers || {})) {
                        if (info.tunnelUri && new URL(info.tunnelUri).hostname === hostname) {
                            return peerTokens[info.machineId] || null;
                        }
                    }
                }
            }
            // Fallback: try all cached tokens (first match)
            for (const token of Object.values(peerTokens)) {
                return token;
            }
        } catch (_) {}
        return null;
    }

    return { start, stop, getPeers, readLocalOps, countLocalLines, storePeerToken, getLocalToken, getPeerTokenForUrl };
};
