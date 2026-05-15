// Exported as a factory so that the installed extension's
// <ext>/src/extension.js shim can call require('vscode') from within the
// extension directory (where VS Code can identify the calling extension)
// and pass the vscode API in. When this file lives outside the extension
// directory (as it does in the workspace via symlinked install), a direct
// require('vscode') here would log a warning:
//   "Could not identify extension for 'vscode' require call from ..."
module.exports = function (vscode) {
    const http = require('http');
    const path = require('path');
    const fs = require('fs');
    const os = require('os');

    // Dedicated output channel. All [orbit]-tagged log calls go
    // through orbitLog/orbitError, which write to both this channel
    // and console. The channel is created lazily on first log so
    // helpers used before activate() (e.g. during module init) don't
    // crash; activate() makes it visible by default.
    let outputChannel = null;
    function ensureOutputChannel() {
        if (!outputChannel) {
            try { outputChannel = vscode.window.createOutputChannel('Orbit'); }
            catch (_) { /* test/headless environments */ }
        }
        return outputChannel;
    }
    function fmtArg(a) {
        if (a === null || a === undefined) return String(a);
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message || String(a);
        try { return JSON.stringify(a); }
        catch (_) { return String(a); }
    }
    function orbitLog(...args) {
        try { console.log(...args); } catch (_) {}
        const ch = ensureOutputChannel();
        if (ch) ch.appendLine(args.map(fmtArg).join(' '));
    }
    function orbitError(...args) {
        try { console.error(...args); } catch (_) {}
        const ch = ensureOutputChannel();
        if (ch) ch.appendLine('[error] ' + args.map(fmtArg).join(' '));
    }

    const devHosts = new Set(['melody', 'rhythm']);
    const shortHostname = os.hostname().split('.')[0].toLowerCase();
    const isDevHost = devHosts.has(shortHostname);
    const mcpHost = isDevHost ? '192.168.1.140' : 'localhost';
    const backendHost = isDevHost ? '192.168.1.140' : '127.0.0.1';

    // The Lam 2300 system is provided by a collaborating set of
    // Smalltalk object memories ("backends"), each of which exposes
    // its own MCP and WebDAV servers on distinct ports. We probe each
    // one at activation time and only register the reachable ones.
    const BACKENDS = [
        { name: '2300-backend', mcpPort: 15072, webdavPort: 19072 },
        { name: '2300-ui',      mcpPort: 15070, webdavPort: 19070 }
    ];

    function backendByName(name) {
        return BACKENDS.find(b => b.name === name);
    }

    function mcpUrlFor(backend) {
        return `http://${mcpHost}:${backend.mcpPort}/mcpservice/v1/mcp`;
    }

    function webdavUrlFor(backend) {
        return `http://${backendHost}:${backend.webdavPort}/webdav`;
    }

    // Quick TCP-connect probe. Resolves true if the port accepts a
    // connection within `timeoutMs`, false otherwise. We use this
    // instead of an HTTP probe because the WebDAV root requires
    // authentication and the MCP endpoint requires a session
    // handshake; a bare TCP accept is enough to know whether the
    // backend is up.
    function probeTcp(host, port, timeoutMs) {
        return new Promise((resolve) => {
            const net = require('net');
            const sock = new net.Socket();
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                try { sock.destroy(); } catch (_) {}
                resolve(ok);
            };
            sock.setTimeout(timeoutMs || 800);
            sock.once('connect', () => finish(true));
            sock.once('timeout', () => finish(false));
            sock.once('error', () => finish(false));
            try { sock.connect(port, host); }
            catch (_) { finish(false); }
        });
    }

    // Probe all backends in parallel for either 'mcp' or 'webdav'
    // service. Returns an array of {backend, reachable}.
    async function probeBackends(kind) {
        const probes = BACKENDS.map(async (b) => {
            const port = kind === 'mcp' ? b.mcpPort : b.webdavPort;
            const host = kind === 'mcp' ? mcpHost : backendHost;
            const reachable = await probeTcp(host, port, 800);
            return { backend: b, reachable };
        });
        return Promise.all(probes);
    }

    async function reachableBackends(kind) {
        const results = await probeBackends(kind);
        return results.filter(r => r.reachable).map(r => r.backend);
    }

    function orbitUrl(port) {
        const base = `http://localhost:${port}/orbit.html`;
        return isDevHost ? `${base}?backend=192.168.1.140` : base;
    }

    let server = null;
    // Reference to the WebDAV FileSystemProvider, set when activate()
    // registers it. Module-scoped so the orbit web server's
    // /fs-changed route (registered in startServer) can call back into
    // it to fire onDidChangeFile events.
    let webdavProvider = null;

    // True if there is currently a VS Code editor tab showing the
    // Orbit page (Simple Browser or Integrated Browser). Uses the
    // same heuristic as orbit.stop's tab-closing logic.
    function findOrbitTabs() {
        const found = [];
        try {
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    const label = (tab.label || '').toLowerCase();
                    const input = tab.input;
                    const viewType = input && input.viewType;
                    const editorId = input && (input.id || input.editorId);
                    const ctorName = input && input.constructor && input.constructor.name;
                    const matches =
                        (viewType && /simpleBrowser|browser/i.test(viewType)) ||
                        (editorId && /browser/i.test(editorId)) ||
                        (ctorName && /browser/i.test(ctorName)) ||
                        label.includes('orbit');
                    if (matches) found.push(tab);
                }
            }
        } catch (_) {}
        return found;
    }
    function hasOrbitTab() {
        return findOrbitTabs().length > 0;
    }
    async function closeOrbitTabs() {
        const tabs = findOrbitTabs();
        if (!tabs.length) return 0;
        try { await vscode.window.tabGroups.close(tabs, true); } catch (_) {}
        return tabs.length;
    }

    // workspaceState key: timestamp (ms since epoch) of the user's
    // most recent explicit orbit.stop. We use it to suppress
    // auto-start across the *immediately following* window reload
    // (e.g. one triggered by removing the last workspace folder,
    // which happens within ~1s of the stop), but not across full
    // VS Code restarts seconds or hours later. Anything older than
    // EXPLICIT_STOP_TTL_MS is ignored.
    const EXPLICIT_STOP_KEY = 'orbit.explicitlyStoppedAt';
    const EXPLICIT_STOP_TTL_MS = 2 * 1000;

    // MCP server visibility/availability. The MCP definition provider
    // returns the orbit backend definitions only while `mcpEnabled` is
    // true; orbit.stop flips it to false and fires the change emitter
    // so VS Code drops the definitions from its server list.
    let mcpEnabled = true;
    let mcpDefinitionsChanged = null;
    const ORBIT_MCP_EXT_KEY =
        'blackpagedigital.orbit-agentic-pair-programming-for-smalltalk';
    function mcpServerIdFor(name) {
        return `${ORBIT_MCP_EXT_KEY}/${name}`;
    }
    // Per-backend reachability cache, populated by the MCP definition
    // provider's probe. The provider never returns definitions for
    // unreachable backends, so VS Code never tries to start them.
    const mcpReachable = new Set();

    // Registry of MCP servers whose state is reflected in the
    // Orbit activity bar view. One entry per backend in BACKENDS;
    // setRunning() asks VS Code to start/stop that specific server.
    // The view checkbox state mirrors getRunning(); toggling a
    // checkbox invokes setRunning() and then notifies subscribers.
    // Per-server running state tracked here so the checkbox reflects
    // the user's intent immediately. The MCP definition stays
    // registered with VS Code whether or not the server is running;
    // only orbit.stop fully unregisters the definition.
    const mcpRunning = {};
    for (const b of BACKENDS) mcpRunning[b.name] = false;

    const mcpServers = BACKENDS.map((b) => ({
        name: b.name,
        getRunning: () => !!mcpRunning[b.name],
        setRunning: async (running) => {
            const id = mcpServerIdFor(b.name);
            if (running) {
                try {
                    await vscode.commands.executeCommand(
                        'workbench.mcp.startServer',
                        id,
                        { autoTrustChanges: true }
                    );
                } catch (e) {
                    orbitError(`[orbit] MCP startServer ${b.name} failed:`, e && e.message);
                    return;
                }
                // Confirm via an actual echoMessage tool invocation
                // that VS Code is connected to the server before
                // flipping the UI flag. workbench.mcp.startServer
                // resolves before any tools have been negotiated,
                // and vscode.lm.tools can hold stale entries from a
                // previous session, so we round-trip a real call.
                // If verification fails, leave the flag false so
                // the periodic retry tick re-issues the start.
                let verified = false;
                for (let i = 0; i < 24; i++) {
                    if (await isMcpServerConnected(b.name)) { verified = true; break; }
                    await new Promise(r => setTimeout(r, 250));
                }
                mcpRunning[b.name] = verified;
                if (!verified) {
                    orbitError(`[orbit] MCP startServer ${b.name}: resolved but no tools appeared`);
                }
            } else {
                try {
                    await vscode.commands.executeCommand(
                        'workbench.mcp.stopServer',
                        id
                    );
                    mcpRunning[b.name] = false;
                } catch (e) {
                    orbitError(`[orbit] MCP stopServer ${b.name} failed:`, e && e.message);
                }
            }
        }
    }));

    // Subscribers (page SSE clients + view refresher) listening for
    // MCP server state changes. Each subscriber is a function taking
    // { name, running }.
    const mcpStateSubscribers = new Set();
    function notifyMcpState(name, running) {
        const payload = { name, running };
        for (const fn of mcpStateSubscribers) {
            try { fn(payload); } catch (e) { orbitError('[orbit] mcp subscriber failed:', e && e.message); }
        }
    }

    // ---- Clipboard bridge ------------------------------------------------
    // The VS Code Integrated Browser swallows Cmd+V and refuses
    // navigator.clipboard.readText. The Orbit webapp therefore GETs/POSTs
    // /clipboard against the public Orbit origin; app-impl.js proxies
    // those calls to a private localhost HTTP server we start here, which
    // bridges to vscode.env.clipboard. The chosen port is written to
    // <tmpdir>/orbit-clipboard.port for the proxy to discover.
    const CLIPBOARD_PORT_FILE = path.join(os.tmpdir(), 'orbit-clipboard.port');
    let clipboardServer = null;

    function startClipboardBridge() {
        if (clipboardServer) return;
        const srv = http.createServer((req, res) => {
            // Only accept loopback connections.
            const remote = req.socket && req.socket.remoteAddress;
            if (remote && remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
                res.statusCode = 403;
                res.end();
                return;
            }
            if (req.url !== '/clipboard') {
                res.statusCode = 404;
                res.end();
                return;
            }
            if (req.method === 'GET') {
                Promise.resolve(vscode.env.clipboard.readText()).then((text) => {
                    res.statusCode = 200;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({ text: typeof text === 'string' ? text : '' }));
                }, (err) => {
                    res.statusCode = 500;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({ error: String(err && err.message || err) }));
                });
                return;
            }
            if (req.method === 'POST') {
                let chunks = '';
                req.setEncoding('utf8');
                req.on('data', (c) => { chunks += c; if (chunks.length > 16 * 1024 * 1024) req.destroy(); });
                req.on('end', () => {
                    let text = '';
                    try {
                        const parsed = chunks ? JSON.parse(chunks) : {};
                        if (parsed && typeof parsed.text === 'string') text = parsed.text;
                    } catch (_) {}
                    Promise.resolve(vscode.env.clipboard.writeText(text)).then(() => {
                        res.statusCode = 200;
                        res.setHeader('content-type', 'application/json');
                        res.end(JSON.stringify({ ok: true }));
                    }, (err) => {
                        res.statusCode = 500;
                        res.setHeader('content-type', 'application/json');
                        res.end(JSON.stringify({ error: String(err && err.message || err) }));
                    });
                });
                return;
            }
            res.statusCode = 405;
            res.end();
        });
        srv.on('error', (err) => {
            orbitError('[orbit] clipboard bridge error:', err && err.message);
        });
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            try {
                fs.writeFileSync(CLIPBOARD_PORT_FILE, String(port), { mode: 0o600 });
            } catch (e) {
                orbitError('[orbit] failed to write clipboard port file:', e && e.message);
            }
            orbitLog('[orbit] clipboard bridge listening on 127.0.0.1:' + port);
        });
        clipboardServer = srv;
    }

    function stopClipboardBridge() {
        if (clipboardServer) {
            try { clipboardServer.close(); } catch (_) {}
            clipboardServer = null;
        }
        try {
            if (fs.existsSync(CLIPBOARD_PORT_FILE)) fs.unlinkSync(CLIPBOARD_PORT_FILE);
        } catch (_) {}
    }

    // ---- Workspace FS bridge ---------------------------------------------
    // Expose vscode.workspace.fs (and thus every registered
    // FileSystemProvider, including untitled:, in-memory, and our own
    // orbit-webdav:// scheme) to the Orbit page over HTTP. Same pattern
    // as the clipboard bridge: a private loopback server, port written
    // to a tmp file, proxied by app-impl.js. For safety, only URIs whose
    // scheme matches one of the current workspace folders (or known
    // safe schemes) are accepted.
    const WORKSPACE_FS_PORT_FILE = path.join(os.tmpdir(), 'orbit-workspace-fs.port');
    const WORKSPACE_FS_SAFE_SCHEMES = new Set([
        'file', 'untitled', 'vscode-userdata', 'orbit-webdav'
    ]);
    let workspaceFsServer = null;

    function workspaceFsAllowedSchemes() {
        const set = new Set(WORKSPACE_FS_SAFE_SCHEMES);
        try {
            for (const f of vscode.workspace.workspaceFolders || []) {
                if (f && f.uri && f.uri.scheme) set.add(f.uri.scheme);
            }
        } catch (_) {}
        return set;
    }

    function parseWorkspaceFsUri(raw) {
        if (!raw || typeof raw !== 'string') {
            const e = new Error('missing uri'); e.status = 400; throw e;
        }
        let uri;
        try { uri = vscode.Uri.parse(raw, true); }
        catch (e2) {
            const e = new Error('invalid uri: ' + (e2 && e2.message)); e.status = 400; throw e;
        }
        const allowed = workspaceFsAllowedSchemes();
        if (!allowed.has(uri.scheme)) {
            const e = new Error('scheme not allowed: ' + uri.scheme); e.status = 403; throw e;
        }
        return uri;
    }

    function fsTypeName(t) {
        // vscode.FileType is a bitmask: Unknown=0, File=1, Directory=2,
        // SymbolicLink=64. Encode raw value plus convenience flags.
        const Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64;
        return {
            value: t,
            file: (t & File) === File,
            directory: (t & Directory) === Directory,
            symlink: (t & SymbolicLink) === SymbolicLink,
            unknown: t === Unknown
        };
    }

    function sendJson(res, status, obj) {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(obj));
    }

    function startWorkspaceFsBridge() {
        if (workspaceFsServer) return;
        const url = require('url');
        const srv = http.createServer(async (req, res) => {
            const remote = req.socket && req.socket.remoteAddress;
            if (remote && remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
                res.statusCode = 403; res.end(); return;
            }
            if (req.method !== 'GET') {
                res.statusCode = 405; res.end(); return;
            }
            const parsed = url.parse(req.url, true);
            const pathname = parsed.pathname || '';
            const q = parsed.query || {};
            try {
                if (pathname === '/workspace-fs/folders') {
                    const folders = (vscode.workspace.workspaceFolders || []).map((f, i) => ({
                        index: i, name: f.name, uri: f.uri.toString()
                    }));
                    return sendJson(res, 200, { folders });
                }
                if (pathname === '/workspace-fs/stat') {
                    const uri = parseWorkspaceFsUri(q.uri);
                    const st = await vscode.workspace.fs.stat(uri);
                    return sendJson(res, 200, {
                        uri: uri.toString(),
                        type: fsTypeName(st.type),
                        ctime: st.ctime, mtime: st.mtime, size: st.size,
                        permissions: st.permissions || 0
                    });
                }
                if (pathname === '/workspace-fs/readDirectory') {
                    const uri = parseWorkspaceFsUri(q.uri);
                    const entries = await vscode.workspace.fs.readDirectory(uri);
                    return sendJson(res, 200, {
                        uri: uri.toString(),
                        entries: entries.map(([name, t]) => ({ name, type: fsTypeName(t) }))
                    });
                }
                if (pathname === '/workspace-fs/read') {
                    const uri = parseWorkspaceFsUri(q.uri);
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    res.statusCode = 200;
                    res.setHeader('content-type', 'application/octet-stream');
                    res.setHeader('content-length', String(bytes.byteLength));
                    res.end(Buffer.from(bytes));
                    return;
                }
                res.statusCode = 404; res.end();
            } catch (err) {
                const status = (err && err.status) || 500;
                // FileSystemError carries a `code` property (e.g.
                // 'FileNotFound'); surface it so the page can
                // distinguish 404-equivalents.
                sendJson(res, status, {
                    error: String(err && err.message || err),
                    code: err && err.code || undefined,
                    name: err && err.name || undefined
                });
            }
        });
        srv.on('error', (err) => {
            orbitError('[orbit] workspace-fs bridge error:', err && err.message);
        });
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            try {
                fs.writeFileSync(WORKSPACE_FS_PORT_FILE, String(port), { mode: 0o600 });
            } catch (e) {
                orbitError('[orbit] failed to write workspace-fs port file:', e && e.message);
            }
            orbitLog('[orbit] workspace-fs bridge listening on 127.0.0.1:' + port);
        });
        workspaceFsServer = srv;
    }

    function stopWorkspaceFsBridge() {
        if (workspaceFsServer) {
            try { workspaceFsServer.close(); } catch (_) {}
            workspaceFsServer = null;
        }
        try {
            if (fs.existsSync(WORKSPACE_FS_PORT_FILE)) fs.unlinkSync(WORKSPACE_FS_PORT_FILE);
        } catch (_) {}
    }

    // ---- WebDAV server endpoint ------------------------------------------
    // Each Smalltalk backend exposes a WebDAV server on its own port
    // (see BACKENDS). The Orbit extension talks to those servers
    // directly via the in-process FileSystemProvider (see
    // src/webdav-fs.js); no host-OS WebDAV client is involved.
    function webdavMountEnabled() {
        try {
            return vscode.workspace
                .getConfiguration('orbit')
                .get('mountWebdav', true);
        } catch (_) { return true; }
    }

    // ---- WebDAV workspace folder management ------------------------------
    // The Orbit extension registers an in-process FileSystemProvider for
    // the orbit-webdav:// scheme (see src/webdav-fs.js). The provider
    // is authority-aware: orbit-webdav://<backend-name>/ resolves to
    // that backend's WebDAV root. These helpers add one workspace
    // folder per reachable backend (named "Smalltalk-<backend-name>"),
    // and remove all orbit-webdav folders on shutdown.
    function webdavWorkspaceFolderUriFor(name) {
        return vscode.Uri.parse(`orbit-webdav://${name}/`);
    }

    function webdavFolderLabelFor(name) {
        return `Smalltalk-${name}`;
    }

    function findWebdavFolderIndices() {
        const folders = vscode.workspace.workspaceFolders || [];
        const out = [];
        for (let i = 0; i < folders.length; i++) {
            if (folders[i].uri.scheme === 'orbit-webdav') {
                out.push({ index: i, folder: folders[i] });
            }
        }
        return out;
    }

    async function addWebdavWorkspaceFolders() {
        // Probe all backends and add a folder per reachable one.
        // Folders for unreachable backends are skipped, and any stale
        // orbit-webdav folder (e.g. left behind by an earlier mount
        // whose backend is no longer reachable, or with an unknown
        // authority) is removed first.
        const reachable = await reachableBackends('webdav');
        const reachableNames = new Set(reachable.map(b => b.name));
        orbitLog('[orbit] addWebdavWorkspaceFolders: reachable=' +
            JSON.stringify(Array.from(reachableNames)));

        // Drop stale folders. Iterate from the end so indices stay
        // valid as we remove.
        const existing = findWebdavFolderIndices();
        for (let k = existing.length - 1; k >= 0; k--) {
            const f = existing[k].folder;
            const auth = f.uri.authority;
            if (!reachableNames.has(auth)) {
                const ok = vscode.workspace.updateWorkspaceFolders(
                    existing[k].index, 1
                );
                orbitLog('[orbit] addWebdavWorkspaceFolders: removed stale ' +
                    f.uri.toString() + ' ok=' + ok);
            }
        }

        // Compute which reachable backends still need a folder.
        const present = new Set(
            findWebdavFolderIndices().map(e => e.folder.uri.authority)
        );
        const toAdd = reachable.filter(b => !present.has(b.name));
        if (toAdd.length === 0) {
            orbitLog('[orbit] addWebdavWorkspaceFolders: nothing to add');
            return true;
        }
        const folders = vscode.workspace.workspaceFolders || [];
        const specs = toAdd.map(b => ({
            uri: webdavWorkspaceFolderUriFor(b.name),
            name: webdavFolderLabelFor(b.name)
        }));
        const ok = vscode.workspace.updateWorkspaceFolders(
            folders.length, 0, ...specs
        );
        orbitLog('[orbit] addWebdavWorkspaceFolders: added ' +
            JSON.stringify(specs.map(s => s.uri.toString())) +
            ' ok=' + ok);
        return ok;
    }

    function removeWebdavWorkspaceFolders() {
        const existing = findWebdavFolderIndices();
        if (existing.length === 0) return false;
        // Note: if these are the only workspace folders, VS Code will
        // force a window reload. The `orbit.explicitlyStopped`
        // workspaceState flag set by orbit.stop prevents auto-start
        // from running after that reload.
        let ok = true;
        // Remove from the end so earlier indices don't shift.
        for (let k = existing.length - 1; k >= 0; k--) {
            const r = vscode.workspace.updateWorkspaceFolders(existing[k].index, 1);
            ok = ok && r;
        }
        orbitLog('[orbit] removeWebdavWorkspaceFolders: removed ' +
            existing.length + ' folders ok=' + ok);
        return ok;
    }

    // Output channel reused by the isolated-subagent feature so that
    // ad-hoc command runs have somewhere visible to stream stdout/stderr.
    let subagentChannel = null;
    function getSubagentChannel() {
        if (!subagentChannel) {
            subagentChannel = vscode.window.createOutputChannel('Orbit Subagent');
        }
        return subagentChannel;
    }

    // Spawn a `copilot` CLI subprocess in non-interactive mode with the
    // Orbit MCP backend injected, and resolve with its captured stdout
    // when it exits cleanly. Tool calls performed by the spawned process
    // are dispatched by that process and never reach VS Code's chat
    // activity UI; only the final text response (this function's return
    // value) does.
    function spawnIsolatedSubagent({ prompt, model, cwd, token, onStderr, extensionPath }) {
        const { spawn } = require('child_process');

        // The Copilot CLI's HTTP MCP client has no OAuth flow support;
        // it can only attach static `headers`. The Orbit backend
        // requires a Bearer token, so we read one from a gitignored
        // file and inject it. Sources, in order of precedence:
        //   1. ORBIT_MCP_BEARER environment variable
        //   2. <extensionPath>/secrets/mcp-bearer.txt
        //   3. ~/.orbit/mcp-bearer
        let bearer = (process.env.ORBIT_MCP_BEARER || '').trim();
        if (!bearer && extensionPath) {
            try {
                const p = path.join(extensionPath, 'secrets', 'mcp-bearer.txt');
                if (fs.existsSync(p)) bearer = fs.readFileSync(p, 'utf8').trim();
            } catch (_) {}
        }
        if (!bearer) {
            try {
                const p = path.join(os.homedir(), '.orbit', 'mcp-bearer');
                if (fs.existsSync(p)) bearer = fs.readFileSync(p, 'utf8').trim();
            } catch (_) {}
        }

        const orbitServer = {
            type: 'http',
            url: mcpUrlFor(backendByName('2300-backend'))
        };
        if (bearer) {
            orbitServer.headers = { Authorization: `Bearer ${bearer}` };
        }

        // Stdio MCP server that exposes a `spawnNestedSubagent` tool.
        // The script reads ORBIT_MCP_CONFIG from the env to discover
        // which MCP servers to re-attach in the grandchild, and
        // ORBIT_SUBAGENT_DEPTH for depth-limit enforcement.
        const nestedScript = extensionPath
            ? path.join(extensionPath, 'bin', 'orbit-nested-subagent-mcp.js')
            : null;
        const mcpServers = { 'orbit-backend': orbitServer };
        if (nestedScript && fs.existsSync(nestedScript)) {
            mcpServers['orbit-nested-subagent'] = {
                type: 'stdio',
                command: process.execPath,
                args: [nestedScript],
                tools: ['*']
            };
        }

        // Write the MCP config to a temp file. We pass it as @file so
        // children can re-attach the same servers transitively.
        const crypto = require('crypto');
        const cfgPath = path.join(
            os.tmpdir(),
            `orbit-mcp-${crypto.randomBytes(6).toString('hex')}.json`
        );
        fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers }), { mode: 0o600 });

        const args = [
            '-p', prompt,
            '-s',
            '--allow-all-tools',
            '--no-remote',
            '--no-color',
            '--additional-mcp-config', '@' + cfgPath
        ];
        if (model) {
            args.push('--model', model);
        }

        return new Promise((resolve, reject) => {
            const env = Object.assign({}, process.env, {
                ORBIT_MCP_CONFIG: cfgPath,
                ORBIT_SUBAGENT_DEPTH: process.env.ORBIT_SUBAGENT_DEPTH || '0',
                ORBIT_SUBAGENT_MAX_DEPTH: process.env.ORBIT_SUBAGENT_MAX_DEPTH || '3'
            });

            let child;
            try {
                child = spawn('copilot', args, {
                    cwd: cwd || os.homedir(),
                    env: env
                });
            } catch (e) {
                try { fs.unlinkSync(cfgPath); } catch (_) {}
                return reject(e);
            }

            let stdout = '';
            let stderr = '';
            const cancelSub = token && token.onCancellationRequested(() => {
                try { child.kill('SIGTERM'); } catch (_) {}
            });

            child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
            child.stderr.on('data', (d) => {
                const s = d.toString('utf8');
                stderr += s;
                if (onStderr) onStderr(s);
            });
            child.on('error', (e) => {
                if (cancelSub) cancelSub.dispose();
                try { fs.unlinkSync(cfgPath); } catch (_) {}
                reject(e);
            });
            child.on('close', (code) => {
                if (cancelSub) cancelSub.dispose();
                try { fs.unlinkSync(cfgPath); } catch (_) {}
                resolve({ code, stdout, stderr, hadBearer: !!bearer });
            });
        });
    }

    // Start the Orbit web server. If `openBrowser` is true, also reveal
    // the integrated browser at the orbit.html URL. Returns a promise that
    // resolves once the server is listening (or immediately if already up).
    // Fired when the orbit tree view should refresh (e.g. the Orbit
    // web server's running state has changed). Set by the activity-bar
    // view registration; safe to call before then.
    let orbitTreeChangeFire = null;
    function setRunningContext(running) {
        try {
            vscode.commands.executeCommand('setContext', 'orbit.running', !!running);
        } catch (_) {}
        if (orbitTreeChangeFire) {
            try { orbitTreeChangeFire(); } catch (_) {}
        }
    }

    // Open or refocus the Orbit page in the Integrated Browser, falling
    // back to the legacy Simple Browser. The new
    // `workbench.action.browser.open` command honors `reuseUrlFilter`,
    // which navigates an existing matching browser tab to the new URL
    // instead of spawning a duplicate. This is what lets a "dead" tab
    // restored from the previous window get re-pointed at the freshly
    // started server, rather than left to rot beside a new tab.
    async function showOrbitBrowser(url) {
        try {
            await vscode.commands.executeCommand(
                'workbench.action.browser.open',
                { url, reuseUrlFilter: url }
            );
            return;
        } catch (e) {
            orbitError('[orbit] workbench.action.browser.open failed; falling back to simpleBrowser.show:',
                e && e.message);
        }
        try {
            await vscode.commands.executeCommand('simpleBrowser.show', url);
        } catch (e) {
            orbitError('[orbit] simpleBrowser.show failed:', e && e.message);
        }
    }

    function startServer(context, openBrowser) {
        return new Promise((resolve) => {
            if (server) {
                if (openBrowser) {
                    const addr = server.address();
                    showOrbitBrowser(orbitUrl(addr.port));
                }
                resolve();
                return;
            }

            const app = require(path.join(context.extensionPath, 'app'));
            // Server-Sent Events endpoint that streams MCP server
            // state changes to the Orbit webapp. The page subscribes
            // via EventSource and dispatches each event to
            // window.mcpServerNotification(payload).
            // Register on app.extensionRoutes so the route is matched
            // before app-impl.js's 404 catchall.
            (app.extensionRoutes || app).get('/mcp-events', (req, res) => {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache, no-transform',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no'
                });
                // Initial snapshot so newly-connected clients can
                // sync without waiting for the next change.
                for (const s of mcpServers) {
                    res.write(`data: ${JSON.stringify({ name: s.name, running: !!s.getRunning() })}\n\n`);
                }
                const subscriber = (payload) => {
                    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); }
                    catch (_) { /* will be cleaned up on close */ }
                };
                mcpStateSubscribers.add(subscriber);
                const keepAlive = setInterval(() => {
                    try { res.write(': ping\n\n'); } catch (_) {}
                }, 25000);
                req.on('close', () => {
                    clearInterval(keepAlive);
                    mcpStateSubscribers.delete(subscriber);
                });
            });

            // POST /fs-changed
            //
            // Server-side change notification from the Smalltalk image,
            // forwarded through SqueakJS in the Orbit page. Body:
            //   { port: 19070,
            //     paths?: ['/search/results', ...],
            //     readOnlyPaths?: ['/classes/Object/methods/yourself', ...],
            //     writablePaths?: ['/search/query', ...] }
            // `port` is the backend's WebDAV port (the Smalltalk image
            // knows its own listen port; the Orbit-side backend name
            // is an internal label it shouldn't need to know). When
            // `paths` is omitted (or empty), every directory the
            // FileSystemProvider has ever served under that backend
            // is invalidated. Each entry in `paths` is invalidated
            // individually. `readOnlyPaths` asserts those URIs as
            // read-only (surfaced as FilePermissions.Readonly in
            // stat); `writablePaths` clears the assertion. Both lists
            // are also invalidated so VS Code re-stats and picks up
            // the new permissions. VS Code re-calls readDirectory/
            // stat on any cached URI we fire a Changed event for.
            (app.extensionRoutes || app).post('/fs-changed', (req, res) => {
                // `app.use(express.json())` runs upstream of this
                // handler, so by the time we get the request the JSON
                // body has already been parsed onto req.body. We do
                // NOT re-read req via 'data' events here — those
                // would never fire and the response would hang.
                const body = (req && req.body) || {};
                if (!webdavProvider) {
                    res.statusCode = 503;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({ error: 'webdav provider not registered' }));
                    return;
                }
                const port = Number(body.port);
                const backend = Number.isFinite(port)
                    ? BACKENDS.find(b => b.webdavPort === port)
                    : null;
                if (!backend) {
                    res.statusCode = 400;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({
                        error: 'unknown webdav port: ' + body.port
                    }));
                    return;
                }
                let extras = [];
                if (Array.isArray(body.paths) && body.paths.length) {
                    extras = body.paths.map((p) => {
                        const pp = ('/' + String(p)).replace(/\/+/g, '/');
                        return vscode.Uri.parse(`orbit-webdav://${backend.name}${pp}`);
                    });
                }
                // Apply read-only assertions. The named URIs are also
                // invalidated so VS Code re-stats them and observes
                // the updated FilePermissions.
                const toUri = (p) => {
                    const pp = ('/' + String(p)).replace(/\/+/g, '/');
                    return vscode.Uri.parse(`orbit-webdav://${backend.name}${pp}`);
                };
                let roChanged = 0, rwChanged = 0;
                if (Array.isArray(body.readOnlyPaths)) {
                    for (const p of body.readOnlyPaths) {
                        const uri = toUri(p);
                        if (webdavProvider.setReadOnly(uri, true)) roChanged++;
                        extras.push(uri);
                    }
                }
                if (Array.isArray(body.writablePaths)) {
                    for (const p of body.writablePaths) {
                        const uri = toUri(p);
                        if (webdavProvider.setReadOnly(uri, false)) rwChanged++;
                        extras.push(uri);
                    }
                }
                // If no specific paths given, refresh every URI we've
                // ever served for this backend.
                if (!extras.length) {
                    try {
                        for (const uri of webdavProvider._readDirs.values()) {
                            if (uri.authority === backend.name) extras.push(uri);
                        }
                    } catch (_) {}
                }
                let fired = 0;
                try { fired = webdavProvider.refresh(extras); }
                catch (e) {
                    orbitError('[orbit] /fs-changed refresh failed:', e && e.message);
                    res.statusCode = 500;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({ error: e && e.message || String(e) }));
                    return;
                }
                // onDidChangeFile events alone aren't reliably picked
                // up by the Files Explorer tree model for our
                // in-process FileSystemProvider — possibly because
                // our watch() is a no-op so the file service doesn't
                // consider any URI "watched". Force a tree refresh
                // so stale children disappear immediately.
                vscode.commands.executeCommand(
                    'workbench.files.action.refreshFilesExplorer'
                ).then(undefined, (e) => {
                    orbitError('[orbit] /fs-changed: explorer refresh failed:',
                        e && e.message);
                });
                const pathSummary = Array.isArray(body.paths) && body.paths.length
                    ? (body.paths.length <= 5
                        ? body.paths.join(', ')
                        : body.paths.slice(0, 5).join(', ') +
                          ` (+${body.paths.length - 5} more)`)
                    : '<all>';
                orbitLog(
                    `[orbit] /fs-changed: backend=${backend.name}` +
                    ` port=${port} paths=${pathSummary}` +
                    ` ro+=${roChanged} rw+=${rwChanged}` +
                    ` fired=${fired}`
                );
                res.statusCode = 200;
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ ok: true, fired }));
            });

            server = http.createServer(app);

            server.listen(8089, () => {
                const addr = server.address();
                setRunningContext(true);
                vscode.window.showInformationMessage(`Orbit running on port ${addr.port}`);
                if (openBrowser) {
                    showOrbitBrowser(orbitUrl(addr.port));
                }
                resolve();
            });

            server.on('error', (err) => {
                vscode.window.showErrorMessage(`Orbit server error: ${err.message}`);
                server = null;
                setRunningContext(false);
                resolve();
            });
        });
    }

    // Read the MCP/WebDAV bearer token from env or known files.
    function readBearer(extensionPath) {
        let bearer = (process.env.ORBIT_MCP_BEARER || '').trim();
        if (!bearer && extensionPath) {
            try {
                const p = path.join(extensionPath, 'secrets', 'mcp-bearer.txt');
                if (fs.existsSync(p)) bearer = fs.readFileSync(p, 'utf8').trim();
            } catch (_) {}
        }
        if (!bearer) {
            try {
                const p = path.join(os.homedir(), '.orbit', 'mcp-bearer');
                if (fs.existsSync(p)) bearer = fs.readFileSync(p, 'utf8').trim();
            } catch (_) {}
        }
        return bearer;
    }

    // True iff VS Code is currently connected to the MCP server for
    // the named backend. We detect this by looking for any
    // LanguageModelTool whose name starts with `mcp_<backend>_`,
    // which is the naming convention VS Code uses for MCP-provided
    // tools. This is more reliable than trusting the
    // `workbench.mcp.startServer` command's resolved promise: that
    // command resolves before VS Code has actually negotiated tools
    // with the server, and it resolves successfully even when the
    // connection later drops.
    //
    // CAVEAT: vscode.lm.tools is not always invalidated when the
    // MCP client disconnects (the MCP servers panel can show
    // "stopped" while tool entries linger), so this is an
    // optimistic check. Use isMcpServerConnected() for an
    // authoritative answer.
    function isMcpServerActuallyRunning(name) {
        try {
            const tools = (vscode.lm && vscode.lm.tools) || [];
            const prefix = `mcp_${name}_`;
            for (const t of tools) {
                const n = (t && t.name) || '';
                if (n.startsWith(prefix)) return true;
            }
            return false;
        } catch (_) { return false; }
    }

    // Authoritative connectivity check: actually invoke the
    // backend's echoMessage tool (which every Orbit backend exposes).
    // If the invocation resolves, VS Code's MCP client is connected
    // to the server. If it rejects or times out, it isn't. We do
    // this rather than trust vscode.lm.tools alone because lm.tools
    // can retain stale entries after a disconnect.
    async function isMcpServerConnected(name) {
        try {
            const toolName = `mcp_${name}_echoMessage`;
            const tools = (vscode.lm && vscode.lm.tools) || [];
            const tool = tools.find(t => t && t.name === toolName);
            if (!tool) return false;
            const cts = new vscode.CancellationTokenSource();
            const timer = setTimeout(() => cts.cancel(), 1500);
            try {
                await vscode.lm.invokeTool(toolName, {
                    input: { message: 'orbit-heartbeat' },
                    toolInvocationToken: undefined
                }, cts.token);
                return true;
            } finally {
                clearTimeout(timer);
                cts.dispose();
            }
        } catch (_) {
            return false;
        }
    }

    // Probe every backend and, for those that respond, ensure that
    //   (a) its MCP definition is visible to VS Code, and
    //   (b) its MCP server has been asked to start.
    // WebDAV mounts are added separately (once per activation, plus
    // when orbit.start runs); Smalltalk-side updates are then pushed
    // to the extension via POST /fs-changed and do not require
    // polling. Safe to call repeatedly: we only issue startServer for
    // backends whose MCP tools aren't yet visible to vscode.lm.tools.
    // Returns true iff every backend in BACKENDS has its MCP server
    // confirmed running (tools visible).
    async function activateReachableBackends() {
        // Reconcile cached running flags with reality, but only
        // for backends we don't already believe to be running.
        // Once we've successfully connected an MCP server, we treat
        // it as sticky: heartbeating a connected server can trigger
        // VS Code's OAuth flow to re-prompt the user if the token
        // has expired or the MCP client has dropped, which violates
        // the contract that an MCP server stays connected until the
        // user clicks Stop Orbit or quits VS Code. So we only probe
        // backends whose state is currently "not running"; ones
        // already marked running stay that way until an explicit
        // stop (setRunning(false) or orbit.stop) clears the flag.
        for (const b of BACKENDS) {
            if (mcpRunning[b.name]) continue;
            const actual = await isMcpServerConnected(b.name);
            if (actual) {
                mcpRunning[b.name] = true;
                notifyMcpState(b.name, true);
                orbitLog(`[orbit] activateReachableBackends: ${b.name} running=true (reconciled)`);
            }
        }
        const probes = await Promise.all(BACKENDS.map(async (b) => {
            const mcp = mcpRunning[b.name]
                ? true
                : await probeTcp(mcpHost, b.mcpPort, 800);
            return { b, mcp };
        }));
        let definitionsChanged = false;
        for (const { b, mcp } of probes) {
            if (mcp && !mcpReachable.has(b.name)) {
                mcpReachable.add(b.name);
                definitionsChanged = true;
            }
        }
        if (definitionsChanged && mcpDefinitionsChanged) {
            mcpDefinitionsChanged.fire();
        }
        for (const { b, mcp } of probes) {
            if (!mcp || mcpRunning[b.name]) continue;
            try {
                await vscode.commands.executeCommand(
                    'workbench.mcp.startServer',
                    mcpServerIdFor(b.name),
                    { autoTrustChanges: true }
                );
                orbitLog(`[orbit] activateReachableBackends: MCP startServer ${b.name} resolved`);
            } catch (e) {
                orbitError(`[orbit] activateReachableBackends: MCP start ${b.name} failed:`,
                    e && e.message);
                continue;
            }
            // The startServer command resolves before tools are
            // negotiated. Round-trip a real echoMessage invocation
            // to confirm VS Code is connected to the server before
            // flipping the UI flag. If verification times out,
            // leave the flag false so the next retry tick re-issues
            // the start.
            let verified = false;
            for (let i = 0; i < 24; i++) {
                if (await isMcpServerConnected(b.name)) { verified = true; break; }
                await new Promise(r => setTimeout(r, 250));
            }
            if (verified) {
                mcpRunning[b.name] = true;
                notifyMcpState(b.name, true);
                orbitLog(`[orbit] activateReachableBackends: MCP ${b.name} confirmed running`);
            } else {
                orbitError(`[orbit] activateReachableBackends: MCP ${b.name} startServer resolved but no tools appeared; will retry`);
            }
        }
        if (orbitTreeChangeFire) {
            try { orbitTreeChangeFire(); } catch (_) {}
        }
        return BACKENDS.every(b => mcpRunning[b.name]);
    }

    // Periodically retry activateReachableBackends so a backend that
    // wasn't ready at activate() (slow Smalltalk image, restarting
    // backend, etc.) still gets its MCP server started and WebDAV
    // folder mounted once it comes up. Backs off to a slow poll once
    // every backend is activated.
    let activateBackendsTimer = null;
    function scheduleBackendActivationRetries() {
        if (activateBackendsTimer) return;
        let attempt = 0;
        const tick = async () => {
            attempt++;
            let allUp = false;
            try { allUp = await activateReachableBackends(); }
            catch (e) { orbitError('[orbit] activation retry failed:', e && e.message); }
            if (allUp) {
                // All MCP backends are connected. Stop polling: any
                // further activateReachableBackends call risks
                // re-issuing workbench.mcp.startServer (which can
                // trigger VS Code's OAuth re-prompt) if a heartbeat
                // ever flaked. The user explicitly stops via the
                // Stop Orbit button or by quitting VS Code.
                activateBackendsTimer = null;
                orbitLog('[orbit] activation retry: all backends up; stopping retry loop');
                return;
            }
            const delay = Math.min(1000 * Math.pow(1.5, attempt), 10000);
            activateBackendsTimer = setTimeout(tick, delay);
        };
        activateBackendsTimer = setTimeout(tick, 1000);
    }
    function stopBackendActivationRetries() {
        if (activateBackendsTimer) {
            clearTimeout(activateBackendsTimer);
            activateBackendsTimer = null;
        }
    }

    function activate(context) {
        const ch = ensureOutputChannel();
        if (ch) context.subscriptions.push(ch);
        orbitLog('[orbit] activate: extension v' +
            (vscode.extensions.getExtension('BlackPageDigital.orbit-agentic-pair-programming-for-smalltalk')
                && vscode.extensions.getExtension('BlackPageDigital.orbit-agentic-pair-programming-for-smalltalk').packageJSON.version
                || '?') +
            ' workspaceFolders=' +
            JSON.stringify((vscode.workspace.workspaceFolders || []).map(f => f.uri.toString())));
        startClipboardBridge();
        startWorkspaceFsBridge();
        setRunningContext(false);

        // Register the in-process WebDAV FileSystemProvider under the
        // orbit-webdav:// scheme. This lets us add Smalltalk-served
        // folders to the workspace without any host-OS WebDAV client.
        try {
            const createWebdavFs = require('./webdav-fs');
            const { provider, scheme } = createWebdavFs(vscode, {
                getBaseUrl: (authority) => {
                    const b = backendByName(authority);
                    return b ? webdavUrlFor(b) : null;
                },
                getAuthHeader: () => {
                    const b = readBearer(context.extensionPath);
                    return b ? 'Bearer ' + b : null;
                }
            });
            webdavProvider = provider;
            const reg = vscode.workspace.registerFileSystemProvider(scheme, provider, {
                isCaseSensitive: true,
                isReadonly: false
            });
            context.subscriptions.push(reg);
            orbitLog('[orbit] webdav FileSystemProvider registered for ' + scheme + '://');
        } catch (e) {
            orbitError('[orbit] webdav FS provider registration failed:', e && e.message);
        }

        // Command: force-refresh every mounted orbit-webdav folder.
        // VS Code caches readDirectory/stat results until the FS
        // provider fires an onDidChangeFile event; this command fires
        // Changed events for the roots of every orbit-webdav workspace
        // folder (and every URI VS Code is currently watching), and
        // then invokes the built-in Explorer refresh. Bound to F5 in
        // the keybindings contribution so users can press F5 to
        // re-fetch after Smalltalk-side changes.
        const refreshWebdavCmd = vscode.commands.registerCommand(
            'orbit.refreshWebdav', async () => {
                let fired = 0;
                if (webdavProvider) {
                    const roots = (vscode.workspace.workspaceFolders || [])
                        .filter(f => f.uri.scheme === 'orbit-webdav')
                        .map(f => f.uri);
                    try { fired = webdavProvider.refresh(roots); }
                    catch (e) {
                        orbitError('[orbit] refreshWebdav: provider.refresh failed:',
                            e && e.message);
                    }
                }
                try {
                    await vscode.commands.executeCommand(
                        'workbench.files.action.refreshFilesExplorer'
                    );
                } catch (e) {
                    orbitError('[orbit] refreshWebdav: explorer refresh failed:',
                        e && e.message);
                }
                orbitLog('[orbit] refreshWebdav: invalidated ' + fired + ' URI(s)');
            }
        );
        context.subscriptions.push(refreshWebdavCmd);

        const startCmd = vscode.commands.registerCommand('orbit.start', async () => {
            orbitLog('[orbit] orbit.start: invoked');
            try { context.workspaceState.update(EXPLICIT_STOP_KEY, 0); } catch (_) {}
            // If the user already has an Orbit browser tab open
            // (e.g. localhost:8089 from a prior session), keep it
            // rather than closing and reopening. The existing tab
            // will reconnect to the freshly started server on its
            // own, and we don't want to spawn a duplicate.
            const keepExistingTab = hasOrbitTab();
            orbitLog('[orbit] orbit.start: keepExistingTab=' + keepExistingTab);
            try {
                await vscode.commands.executeCommand('orbit.stop', { keepTabs: keepExistingTab });
            } catch (e) {
                orbitError('[orbit.start] orbit.stop failed:', e && e.message);
            }
            await startServer(context, !keepExistingTab);
            orbitLog('[orbit] orbit.start: startServer done; webdavMountEnabled=' + webdavMountEnabled());
            // Re-publish the Orbit MCP definitions (orbit.stop withdrew
            // them) before asking VS Code to start the servers.
            if (!mcpEnabled) {
                mcpEnabled = true;
                if (mcpDefinitionsChanged) mcpDefinitionsChanged.fire();
            }
            // Best-effort: start every reachable Orbit MCP backend so
            // the user doesn't have to do it by hand. The retry
            // scheduler picks up any backend that wasn't yet reachable
            // at this moment.
            try { await activateReachableBackends(); }
            catch (e) {
                orbitError('[orbit] orbit.start: activateReachableBackends failed:',
                    e && e.message);
            }
            // Mount the WebDAV folders once. Smalltalk-side changes
            // are pushed via POST /fs-changed, so no polling.
            if (webdavMountEnabled()) {
                try { await addWebdavWorkspaceFolders(); }
                catch (e) {
                    orbitError('[orbit] orbit.start: addWebdavWorkspaceFolders failed:',
                        e && e.message);
                }
            }
            scheduleBackendActivationRetries();
        });

        const stopCmd = vscode.commands.registerCommand('orbit.stop', async (opts) => {
            const keepTabs = !!(opts && opts.keepTabs);
            const silent = !!(opts && opts.silent);
            orbitLog('[orbit] orbit.stop: invoked; keepTabs=' + keepTabs + ' silent=' + silent);
            // Only treat this as an explicit user stop when invoked
            // standalone (not as part of orbit.start's restart cycle,
            // which signals itself via opts.keepTabs; nor from the
            // activate-time auto-close, which uses opts.silent).
            if (!keepTabs && !silent) {
                try { context.workspaceState.update(EXPLICIT_STOP_KEY, Date.now()); } catch (_) {}
            }
            if (server) {
                server.close();
                server = null;
                setRunningContext(false);
                // Drop cached app.js and route modules so the next start
                // picks up edits to those files. The workspace app.js and
                // routes/*.js are reached via symlinks from the installed
                // extension dir, but Node's require cache is keyed by the
                // resolved real path, so a fresh require alone is not
                // enough — we must invalidate first.
                try {
                    Object.keys(require.cache).forEach((k) => {
                        if (k.endsWith('/app.js') || k.includes('/routes/')) {
                            delete require.cache[k];
                        }
                    });
                } catch (_) {}
                if (!silent) vscode.window.showInformationMessage('Orbit stopped.');
            } else {
                if (!silent) vscode.window.showInformationMessage('Orbit is not running.');
            }
            // Close any browser tabs showing the Orbit page (Simple
            // Browser viewType `mainThreadWebview-simpleBrowser.view`,
            // or the new Integrated Browser editor with typeId
            // `workbench.editor.browser`). Skipped when invoked from
            // orbit.start with an existing tab to preserve.
            if (!keepTabs) try {
                const tabsToClose = [];
                for (const group of vscode.window.tabGroups.all) {
                    for (const tab of group.tabs) {
                        const input = tab.input;
                        const viewType = input && input.viewType;
                        const editorId = input && (input.id || input.editorId);
                        const ctorName = input && input.constructor && input.constructor.name;
                        const label = (tab.label || '').toLowerCase();
                        const matches =
                            (viewType && /simpleBrowser|browser/i.test(viewType)) ||
                            (editorId && /browser/i.test(editorId)) ||
                            (ctorName && /browser/i.test(ctorName)) ||
                            label.includes('orbit');
                        orbitLog('[orbit.stop] tab', JSON.stringify({
                            label: tab.label,
                            viewType,
                            editorId,
                            ctorName,
                            inputKeys: input ? Object.keys(input) : null,
                            matches
                        }));
                        if (matches) tabsToClose.push(tab);
                    }
                }
                if (tabsToClose.length) {
                    await vscode.window.tabGroups.close(tabsToClose, true);
                }
            } catch (e) {
                orbitError('[orbit] closing browser tab failed:', e && e.message);
            }
            // Always remove WebDAV workspace folders when Orbit is
            // stopped (except during orbit.start's internal restart
            // cycle, signalled by keepTabs=true: the remove + re-add
            // races against VS Code's async folder mutation pipeline
            // and the re-add silently fails on the first attempt).
            // This runs regardless of the mountWebdav setting or the
            // current workspace, so a stopped Orbit never leaves
            // Smalltalk filesystems mounted. The FS provider stays
            // registered for the lifetime of the extension, so the
            // folder can be re-added later without re-registering.
            if (!keepTabs) removeWebdavWorkspaceFolders();
            // Stop the Orbit MCP backend connections and withdraw the
            // definitions so they disappear from the MCP servers list.
            for (const b of BACKENDS) {
                try {
                    await vscode.commands.executeCommand(
                        'workbench.mcp.stopServer',
                        mcpServerIdFor(b.name)
                    );
                } catch (e) {
                    orbitError(`[orbit.stop] MCP stopServer ${b.name} failed:`, e && e.message);
                }
                mcpRunning[b.name] = false;
                notifyMcpState(b.name, false);
            }
            if (mcpEnabled) {
                mcpEnabled = false;
                if (mcpDefinitionsChanged) mcpDefinitionsChanged.fire();
            }
        });

        context.subscriptions.push(startCmd, stopCmd);

        // Command to open steering file from extension details page
        const openSteeringCmd = vscode.commands.registerCommand('orbit.openSteering', () => {
            const steeringPath = vscode.Uri.file(path.join(context.extensionPath, 'agents', 'orbit.agent.md'));
            vscode.commands.executeCommand('vscode.open', steeringPath);
        });
        context.subscriptions.push(openSteeringCmd);

        // Command to add a folder served via the in-process WebDAV
        // FileSystemProvider to the current workspace. Uses the
        // orbit-webdav:// scheme registered above; no host-OS WebDAV
        // client is required.
        const addWebdavFolderCmd = vscode.commands.registerCommand('orbit.addWebdavFolder', async () => {
            // Ask which backend's WebDAV root to mount under, then
            // which subpath. Only show backends that pass a quick TCP
            // probe so the user can't pick an unreachable one.
            const reachable = await reachableBackends('webdav');
            if (reachable.length === 0) {
                vscode.window.showErrorMessage(
                    'Orbit: no Smalltalk WebDAV servers are reachable.'
                );
                return;
            }
            let backend;
            if (reachable.length === 1) {
                backend = reachable[0];
            } else {
                const pick = await vscode.window.showQuickPick(
                    reachable.map(b => ({ label: b.name, backend: b })),
                    { title: 'Orbit: choose a Smalltalk backend', ignoreFocusOut: true }
                );
                if (!pick) return;
                backend = pick.backend;
            }
            const subpath = await vscode.window.showInputBox({
                title: `Orbit: Add WebDAV Folder to Workspace (${backend.name})`,
                prompt: 'Subpath under the WebDAV root. Leave blank to add the root.',
                placeHolder: 'classes/Object',
                ignoreFocusOut: true,
                value: ''
            });
            if (subpath === undefined) return; // user cancelled
            const cleaned = subpath.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
            const uriPath = '/' + cleaned;
            const uri = vscode.Uri.parse(`orbit-webdav://${backend.name}${uriPath}`);

            // Probe the path so we fail fast with a useful message
            // instead of silently adding a broken folder.
            try {
                await vscode.workspace.fs.stat(uri);
            } catch (e) {
                vscode.window.showErrorMessage(
                    `Orbit: cannot access ${uri.toString()}: ${e && e.message || e}`
                );
                return;
            }

            const existing = vscode.workspace.workspaceFolders || [];
            const already = existing.find(f => f.uri.toString() === uri.toString());
            if (already) {
                vscode.window.showInformationMessage(
                    `Orbit: ${uri.toString()} is already in the workspace.`
                );
                return;
            }
            const baseName = webdavFolderLabelFor(backend.name);
            const name = cleaned ? `${baseName}:${cleaned}` : baseName;
            const ok = vscode.workspace.updateWorkspaceFolders(
                existing.length, 0, { uri, name }
            );
            if (!ok) {
                vscode.window.showErrorMessage(
                    `Orbit: failed to add ${uri.toString()} to the workspace.`
                );
            }
        });
        context.subscriptions.push(addWebdavFolderCmd);

        // Tab dedup watcher: VS Code restores browser tabs from the
        // previous session asynchronously, often *after* this
        // extension's auto-start has already opened its own Orbit
        // tab. The result is two tabs: a "dead" one from before the
        // reload (pointing at a server that wasn't running yet) and
        // the fresh one we just opened. Whenever the tab set changes,
        // if there is more than one Orbit tab, close all but the
        // most recently active one. We never run while server is null
        // (no fresh tab of our own to keep).
        try {
            let dedupRunning = false;
            const dedupOrbitTabs = async () => {
                if (dedupRunning) return;
                if (!server) return;
                const tabs = findOrbitTabs();
                if (tabs.length < 2) return;
                // Prefer the active tab; otherwise keep the last in
                // iteration order (most recently created).
                let keep = tabs.find(t => t.isActive);
                if (!keep) keep = tabs[tabs.length - 1];
                const drop = tabs.filter(t => t !== keep);
                if (!drop.length) return;
                dedupRunning = true;
                try {
                    orbitLog('[orbit] dedup: closing ' + drop.length +
                        ' duplicate Orbit tab(s); keeping ' +
                        JSON.stringify(keep.label));
                    await vscode.window.tabGroups.close(drop, true);
                } catch (e) {
                    orbitError('[orbit] dedup close failed:', e && e.message);
                } finally {
                    dedupRunning = false;
                }
            };
            const tabSub = vscode.window.tabGroups.onDidChangeTabs(() => {
                dedupOrbitTabs();
            });
            context.subscriptions.push(tabSub);
        } catch (e) {
            orbitError('[orbit] tab dedup watcher registration failed:', e && e.message);
        }

        // Activity Bar view: register a minimal TreeDataProvider for
        // `orbit.status`. Welcome content (declared in package.json)
        // shows a single Start/Stop button driven by the
        // `orbit.running` context key, which we maintain below.
        // The view is passive: opening it (clicking the Orbit icon
        // in the activity bar) does not auto-start Orbit. The user
        // explicitly starts Orbit by clicking the "Start Orbit"
        // button in the view.
        // Activity Bar view: tree provider showing
        //   [summary header]
        //   [WebDAV section]          (checkbox; toggles mountWebdav)
        //   [MCP server checkboxes]   (visible when Orbit is running)
        //   [Start/Stop Orbit button]
        // The summary row is informational. The WebDAV checkbox
        // mirrors the `orbit.mountWebdav` setting; toggling it
        // updates the setting and adds/removes the orbit-webdav
        // workspace folders accordingly. Each MCP server row has
        // a checkbox whose state mirrors the server's running state;
        // toggling it starts/stops that server and notifies the
        // webapp via SSE -> window.mcpServerNotification(payload).
        // The footer row is a button that runs orbit.start or
        // orbit.stop depending on whether the Orbit web server is up.
        try {
            let currentWebviewView = null;
            // Serial counter so a slow heartbeat from an earlier
            // postState call doesn't overwrite a fresher result.
            let postStateSeq = 0;

            async function postState() {
                if (!currentWebviewView) return;
                const mySeq = ++postStateSeq;
                const orbitRunning = !!server;
                // Report the cached running state. We deliberately
                // do NOT heartbeat already-connected servers here:
                // an echoMessage tool invocation against a server
                // whose OAuth token has expired or whose MCP client
                // has dropped can trigger VS Code to re-prompt the
                // user for authentication. The contract is that an
                // MCP server stays connected until the user clicks
                // Stop Orbit or quits VS Code, so once mcpRunning
                // is true we leave it true; it only flips false on
                // explicit stop (setRunning(false) or orbit.stop).
                // For backends not yet marked running, a heartbeat
                // is safe (and useful: it picks up a server that
                // VS Code connected to without going through our
                // setRunning path, e.g. after window reload).
                const servers = orbitRunning
                    ? await Promise.all(mcpServers.map(async (s) => {
                        if (mcpRunning[s.name]) {
                            return { name: s.name, running: true };
                        }
                        const connected = await isMcpServerConnected(s.name);
                        if (connected) {
                            mcpRunning[s.name] = true;
                        }
                        return { name: s.name, running: connected };
                    }))
                    : [];
                if (mySeq !== postStateSeq) return;
                if (!currentWebviewView) return;
                const payload = {
                    type: 'state',
                    orbitRunning,
                    webdavEnabled: webdavMountEnabled(),
                    servers
                };
                try { currentWebviewView.webview.postMessage(payload); } catch (_) {}
            }
            orbitTreeChangeFire = () => postState();

            function getHtml(webview, nonce) {
                const csp = [
                    "default-src 'none'",
                    `style-src ${webview.cspSource} 'unsafe-inline'`,
                    `script-src 'nonce-${nonce}'`
                ].join('; ');
                return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 8px 12px;
    margin: 0;
    box-sizing: border-box;
  }
  .summary {
    word-wrap: break-word;
    overflow-wrap: break-word;
    white-space: normal;
    line-height: 1.4;
  }
  hr {
    border: none;
    border-top: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border, rgba(128,128,128,0.35)));
    margin: 10px 0;
  }
  .section-label {
    font-weight: bold;
    margin-bottom: 6px;
  }
  .server {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 0;
  }
  .server input[type="checkbox"] {
    margin: 0;
    cursor: pointer;
  }
  .server .name { flex: 0 0 auto; }
  .server .status {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }
  .footer-button {
    width: 100%;
    text-align: center;
    cursor: pointer;
    padding: 4px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
  }
  .footer-button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
  <div class="summary">Orbit pair-programs Smalltalk with you.</div>
  <hr>
  <div class="section-label">virtual filesystems</div>
  <div class="server">
    <input type="checkbox" id="webdav-toggle">
    <label for="webdav-toggle" class="name">mount Smalltalk folders</label>
  </div>
  <hr id="hr-top">
  <div id="mcp-section-label" class="section-label">remote systems</div>
  <div id="servers"></div>
  <hr>
  <button id="orbit-toggle" class="footer-button">Start Orbit</button>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const serversEl = document.getElementById('servers');
  const toggleBtn = document.getElementById('orbit-toggle');
  const webdavCb = document.getElementById('webdav-toggle');

  toggleBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'toggleOrbit' });
  });

  webdavCb.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleWebdav', desired: webdavCb.checked });
  });

  function render(state) {
    toggleBtn.textContent = state.orbitRunning ? 'Stop Orbit' : 'Start Orbit';
    webdavCb.checked = !!state.webdavEnabled;
    const hasServers = state.servers && state.servers.length > 0;
    document.getElementById('hr-top').style.display = hasServers ? '' : 'none';
    document.getElementById('mcp-section-label').style.display = hasServers ? '' : 'none';
    serversEl.innerHTML = '';
    for (const s of state.servers) {
      const row = document.createElement('div');
      row.className = 'server';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!s.running;
      cb.id = 'cb-' + s.name;
      cb.addEventListener('change', () => {
        vscode.postMessage({
          type: 'toggleServer',
          name: s.name,
          desired: cb.checked
        });
      });
      const label = document.createElement('label');
      label.className = 'name';
      label.htmlFor = cb.id;
      label.textContent = s.name;
      const status = document.createElement('span');
      status.className = 'status';
      status.textContent = s.running ? 'running' : 'stopped';
      row.appendChild(cb);
      row.appendChild(label);
      row.appendChild(status);
      serversEl.appendChild(row);
    }
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.type === 'state') render(msg);
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
            }

            const provider = {
                resolveWebviewView(webviewView) {
                    currentWebviewView = webviewView;
                    webviewView.webview.options = { enableScripts: true };
                    const nonce = Math.random().toString(36).slice(2) +
                        Math.random().toString(36).slice(2);
                    webviewView.webview.html = getHtml(webviewView.webview, nonce);

                    webviewView.webview.onDidReceiveMessage(async (msg) => {
                        if (!msg) return;
                        if (msg.type === 'ready') {
                            postState();
                            return;
                        }
                        if (msg.type === 'toggleOrbit') {
                            try {
                                if (server) {
                                    await vscode.commands.executeCommand('orbit.stop');
                                } else {
                                    await vscode.commands.executeCommand('orbit.start');
                                }
                            } catch (e) {
                                orbitError('[orbit] toggleOrbit failed:', e && e.message);
                            }
                            postState();
                            return;
                        }
                        if (msg.type === 'toggleServer') {
                            const srv = mcpServers.find(s => s.name === msg.name);
                            if (!srv) { postState(); return; }
                            const desired = !!msg.desired;
                            if (!!srv.getRunning() === desired) { postState(); return; }
                            try {
                                await srv.setRunning(desired);
                            } catch (e) {
                                orbitError('[orbit] MCP setRunning failed:', e && e.message);
                            }
                            notifyMcpState(srv.name, !!srv.getRunning());
                            postState();
                            return;
                        }
                        if (msg.type === 'toggleWebdav') {
                            const desired = !!msg.desired;
                            try {
                                await vscode.workspace
                                    .getConfiguration('orbit')
                                    .update(
                                        'mountWebdav',
                                        desired,
                                        vscode.ConfigurationTarget.Global
                                    );
                            } catch (e) {
                                orbitError('[orbit] mountWebdav update failed:', e && e.message);
                                postState();
                                return;
                            }
                            try {
                                if (desired) {
                                    await addWebdavWorkspaceFolders();
                                } else {
                                    removeWebdavWorkspaceFolders();
                                }
                            } catch (e) {
                                orbitError('[orbit] toggleWebdav apply failed:', e && e.message);
                            }
                            postState();
                            return;
                        }
                    });

                    webviewView.onDidDispose(() => {
                        if (currentWebviewView === webviewView) currentWebviewView = null;
                    });

                    // Re-post when the view becomes visible so a stale
                    // UI (e.g. a backend dropped while the view was
                    // hidden) gets corrected immediately.
                    webviewView.onDidChangeVisibility(() => {
                        if (webviewView.visible) postState();
                    });
                }
            };

            const mcpRefresher = () => postState();
            mcpStateSubscribers.add(mcpRefresher);

            const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('orbit.mountWebdav')) postState();
            });

            const viewReg = vscode.window.registerWebviewViewProvider(
                'orbit.status', provider,
                { webviewOptions: { retainContextWhenHidden: true } }
            );
            context.subscriptions.push(viewReg, cfgSub, {
                dispose: () => mcpStateSubscribers.delete(mcpRefresher)
            });
        } catch (e) {
            orbitError('[orbit] activity bar view registration failed:', e && e.message);
        }

        // Ad-hoc command: prompt the user for a task and run an isolated
        // Copilot CLI subagent. Output streams to the "Orbit Subagent"
        // output channel.
        const runSubagentCmd = vscode.commands.registerCommand('orbit.runIsolatedSubagent', async () => {
            const promptText = await vscode.window.showInputBox({
                title: 'Orbit: Run Isolated Subagent',
                prompt: 'Task for the isolated Copilot CLI subagent',
                placeHolder: 'e.g. Fetch the source of Object>>yourself via the Orbit MCP backend.',
                ignoreFocusOut: true
            });
            if (!promptText) return;

            const model = await vscode.window.showInputBox({
                title: 'Orbit: Run Isolated Subagent',
                prompt: 'Model name (optional; leave blank for default)',
                placeHolder: 'gpt-5.4',
                ignoreFocusOut: true
            });

            const ch = getSubagentChannel();
            ch.show(true);
            ch.appendLine(`\n--- ${new Date().toISOString()} ---`);
            ch.appendLine(`prompt: ${promptText}`);
            if (model) ch.appendLine(`model: ${model}`);
            ch.appendLine('');

            const cwd = (vscode.workspace.workspaceFolders
                && vscode.workspace.workspaceFolders[0]
                && vscode.workspace.workspaceFolders[0].uri.fsPath) || undefined;

            try {
                const { code, stdout, stderr, hadBearer } = await spawnIsolatedSubagent({
                    prompt: promptText,
                    model: model || undefined,
                    cwd,
                    extensionPath: context.extensionPath,
                    onStderr: (s) => ch.append(s)
                });
                if (!hadBearer) {
                    ch.appendLine('[warn] No MCP bearer token found. Set ORBIT_MCP_BEARER, or write the token to <extensionPath>/secrets/mcp-bearer.txt or ~/.orbit/mcp-bearer. The Orbit MCP server will reject the subagent with 401.');
                }
                ch.appendLine('\n=== stdout ===');
                ch.append(stdout);
                if (code !== 0) {
                    ch.appendLine(`\n[exit code ${code}]`);
                    if (stderr) {
                        ch.appendLine('=== stderr ===');
                        ch.append(stderr);
                    }
                }
            } catch (e) {
                ch.appendLine(`\n[error] ${e && e.message || e}`);
            }
        });
        context.subscriptions.push(runSubagentCmd);

        // Language model tool: invokable by the @orbit chat participant
        // (and any other Copilot Chat tool-using model) to run a task in
        // an isolated Copilot CLI subprocess. The subprocess does its own
        // tool dispatch; only the final text response is returned.
        try {
            const subagentTool = vscode.lm.registerTool('orbit_runIsolatedSubagent', {
                async prepareInvocation(_options, _token) {
                    return { invocationMessage: 'Running isolated Copilot CLI subagent…' };
                },
                async invoke(options, token) {
                    const input = (options && options.input) || {};
                    const promptText = input.prompt;
                    if (!promptText || typeof promptText !== 'string') {
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart('Error: `prompt` is required.')
                        ]);
                    }
                    const cwd = (vscode.workspace.workspaceFolders
                        && vscode.workspace.workspaceFolders[0]
                        && vscode.workspace.workspaceFolders[0].uri.fsPath) || undefined;
                    try {
                        const { code, stdout, stderr, hadBearer } = await spawnIsolatedSubagent({
                            prompt: promptText,
                            model: input.model || undefined,
                            cwd,
                            extensionPath: context.extensionPath,
                            token
                        });
                        const bearerNote = hadBearer
                            ? ''
                            : '[warn] No MCP bearer token configured; the Orbit MCP server likely returned 401 and was not attached. Set ORBIT_MCP_BEARER or write the token to <extensionPath>/secrets/mcp-bearer.txt.\n\n';
                        if (code !== 0) {
                            return new vscode.LanguageModelToolResult([
                                new vscode.LanguageModelTextPart(
                                    bearerNote +
                                    `[copilot CLI exited with code ${code}]\n` +
                                    (stderr ? `stderr:\n${stderr}\n\n` : '') +
                                    `stdout:\n${stdout}`
                                )
                            ]);
                        }
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(bearerNote + stdout)
                        ]);
                    } catch (e) {
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(
                                `Failed to spawn copilot CLI: ${e && e.message || e}`
                            )
                        ]);
                    }
                }
            });
            context.subscriptions.push(subagentTool);
            orbitLog('[orbit] runIsolatedSubagent tool registered');
        } catch (e) {
            orbitError('[orbit] runIsolatedSubagent tool registration failed:', e && e.message);
        }

        // Chat participants:
        //   @orbit                 — unrestricted: all available tools
        //   @orbit-<server>        — restricted to mcp_<server>_* tools
        //                            (one per active Smalltalk MCP server)
        const agentMdPath = path.join(context.extensionPath, 'agents', 'orbit.agent.md');
        const agentInstructions = fs.readFileSync(agentMdPath, 'utf8');

        function makeOrbitParticipantHandler(participantId, toolFilter, extraSystemNote) {
            return async (request, chatContext, response, token) => {
                try {
                    const sysText = extraSystemNote
                        ? agentInstructions + '\n\n' + extraSystemNote
                        : agentInstructions;
                    const messages = [vscode.LanguageModelChatMessage.User(sysText)];

                    for (const turn of (chatContext.history || [])) {
                        if (turn instanceof vscode.ChatRequestTurn) {
                            if (turn.participant === participantId) {
                                messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
                            }
                        } else if (turn instanceof vscode.ChatResponseTurn) {
                            if (turn.participant === participantId) {
                                const text = (turn.response || [])
                                    .map(p => (p && p.value && typeof p.value.value === 'string') ? p.value.value : '')
                                    .join('');
                                if (text) messages.push(vscode.LanguageModelChatMessage.Assistant(text));
                            }
                        }
                    }

                    messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

                    const allTools = (vscode.lm.tools || []).filter(t => t && t.name && t.description);
                    const filtered = toolFilter ? allTools.filter(toolFilter) : allTools;
                    const toolMap = new Map(filtered.map(t => [t.name, t]));
                    const toolsForModel = filtered.map(t => ({
                        name: t.name,
                        description: t.description,
                        inputSchema: t.inputSchema
                    }));

                    const MAX_ITERATIONS = 16;
                    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
                        if (token.isCancellationRequested) return;

                        const lmResponse = await request.model.sendRequest(
                            messages,
                            { tools: toolsForModel },
                            token
                        );

                        const toolCalls = [];
                        const assistantParts = [];
                        for await (const part of lmResponse.stream) {
                            if (token.isCancellationRequested) return;
                            if (part instanceof vscode.LanguageModelTextPart) {
                                response.markdown(part.value);
                                assistantParts.push(part);
                            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                                toolCalls.push(part);
                                assistantParts.push(part);
                            }
                        }

                        if (toolCalls.length === 0) return;

                        messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

                        for (const call of toolCalls) {
                            if (token.isCancellationRequested) return;
                            const tool = toolMap.get(call.name);
                            if (!tool) {
                                messages.push(vscode.LanguageModelChatMessage.User([
                                    new vscode.LanguageModelToolResultPart(call.callId, [
                                        new vscode.LanguageModelTextPart(`Tool '${call.name}' is not available to this participant.`)
                                    ])
                                ]));
                                continue;
                            }
                            try {
                                response.progress(`Invoking ${call.name}…`);
                                const result = await vscode.lm.invokeTool(call.name, {
                                    input: call.input,
                                    toolInvocationToken: request.toolInvocationToken
                                }, token);
                                messages.push(vscode.LanguageModelChatMessage.User([
                                    new vscode.LanguageModelToolResultPart(call.callId, result.content)
                                ]));
                            } catch (toolErr) {
                                messages.push(vscode.LanguageModelChatMessage.User([
                                    new vscode.LanguageModelToolResultPart(call.callId, [
                                        new vscode.LanguageModelTextPart(
                                            `Tool '${call.name}' failed: ${toolErr && toolErr.message || toolErr}`
                                        )
                                    ])
                                ]));
                            }
                        }
                    }

                    response.markdown(`\n\n_(Tool-loop iteration cap reached.)_`);
                } catch (e) {
                    response.markdown(`\n\n**Orbit participant error:** ${e && e.message || e}`);
                    orbitError('[orbit] participant error:', e);
                }
            };
        }

        // Tools whose name doesn't start with "mcp_" are non-MCP
        // (e.g. orbit.runIsolatedSubagent). They're available to every
        // Orbit participant. Per-server participants additionally only
        // see MCP tools whose prefix matches their server.
        function isNonMcpTool(t) { return !/^mcp_/.test(t.name); }
        function makeServerToolFilter(serverName) {
            const prefix = `mcp_${serverName}_`;
            return (t) => isNonMcpTool(t) || t.name.startsWith(prefix);
        }

        const participant = vscode.chat.createChatParticipant(
            'orbit.orbit',
            makeOrbitParticipantHandler('orbit.orbit', null, null)
        );
        participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'public', 'pictures', 'icons', 'participant', 'orbit.jpg');
        context.subscriptions.push(participant);

        // Per-server participants. Each is created when its server is
        // running and disposed when it stops, so the @-picker only
        // lists currently-available servers.
        //
        // Steering: every Orbit participant gets the shared base
        // (agents/orbit.agent.md). A per-server participant additionally
        // appends, in order:
        //   1. Contents of the file in `instructionsFile`, if present
        //      and readable. Path is resolved relative to extension root,
        //      so it survives livecoding symlinks. Default convention:
        //      agents/orbit-<serverName>.agent.md.
        //   2. The auto-generated restriction note telling the model
        //      which MCP-tool prefix it's allowed to use.
        // Edit the per-server .md file (or change `instructionsFile`)
        // to control steering for that participant. Reload to pick up
        // changes; the file is read each time the participant is
        // created (i.e. whenever the server transitions to running),
        // so a stop/start of the MCP server is enough to re-read.
        const PER_SERVER_PARTICIPANTS = [
            {
                serverName: '2300-backend',
                participantId: 'orbit.orbit-2300-backend',
                instructionsFile: 'agents/orbit-2300-backend.agent.md'
            },
            {
                serverName: '2300-ui',
                participantId: 'orbit.orbit-2300-ui',
                instructionsFile: 'agents/orbit-2300-ui.agent.md'
            }
        ];
        const liveServerParticipants = new Map(); // serverName -> Disposable

        function loadServerInstructions(spec) {
            if (!spec.instructionsFile) return '';
            const p = path.join(context.extensionPath, spec.instructionsFile);
            try {
                if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
            } catch (e) {
                orbitError(`[orbit] read ${spec.instructionsFile} failed:`, e && e.message);
            }
            return '';
        }

        function createServerParticipant(spec) {
            try {
                const restriction = `You are restricted to the "${spec.serverName}" Smalltalk MCP server. Only the tools you've been given (mcp_${spec.serverName}_*) target it; do not assume access to any other Smalltalk system.`;
                const fileNote = loadServerInstructions(spec);
                const note = fileNote
                    ? (fileNote.trimEnd() + '\n\n' + restriction)
                    : restriction;
                const p = vscode.chat.createChatParticipant(
                    spec.participantId,
                    makeOrbitParticipantHandler(
                        spec.participantId,
                        makeServerToolFilter(spec.serverName),
                        note
                    )
                );
                p.iconPath = vscode.Uri.joinPath(context.extensionUri, 'public', 'pictures', 'icons', 'participant', 'orbit.jpg');
                liveServerParticipants.set(spec.serverName, p);
            } catch (e) {
                orbitError(`[orbit] per-server participant ${spec.participantId} register failed:`, e && e.message);
            }
        }

        function disposeServerParticipant(serverName) {
            const p = liveServerParticipants.get(serverName);
            if (!p) return;
            try { p.dispose(); }
            catch (e) { orbitError(`[orbit] per-server participant ${serverName} dispose failed:`, e && e.message); }
            liveServerParticipants.delete(serverName);
        }

        function syncServerParticipants() {
            for (const spec of PER_SERVER_PARTICIPANTS) {
                const srv = mcpServers.find(s => s.name === spec.serverName);
                const shouldBeLive = !!server && !!srv && !!srv.getRunning();
                const isLive = liveServerParticipants.has(spec.serverName);
                if (shouldBeLive && !isLive) createServerParticipant(spec);
                else if (!shouldBeLive && isLive) disposeServerParticipant(spec.serverName);
            }
        }

        // React to MCP server start/stop and Orbit start/stop.
        const participantSyncSubscriber = () => syncServerParticipants();
        mcpStateSubscribers.add(participantSyncSubscriber);
        context.subscriptions.push({
            dispose: () => {
                mcpStateSubscribers.delete(participantSyncSubscriber);
                for (const name of Array.from(liveServerParticipants.keys())) {
                    disposeServerParticipant(name);
                }
            }
        });
        // Initial sync (mcpServers + Orbit server may already be up).
        syncServerParticipants();

        // Diagnostic: log what VS Code thinks our manifest contributes look like.
        try {
            const ext = vscode.extensions.getExtension('BlackPageDigital.orbit');
            const contributes = ext && ext.packageJSON && ext.packageJSON.contributes;
            const mcp = contributes && contributes.mcpServerDefinitionProviders;
            orbitLog('[orbit] packageJSON.contributes keys:', contributes && Object.keys(contributes));
            orbitLog('[orbit] mcpServerDefinitionProviders:', JSON.stringify(mcp));
        } catch (e) {
            orbitLog('[orbit] manifest inspect failed:', e && e.message);
        }

        try {
            mcpDefinitionsChanged = new vscode.EventEmitter();
            const mcpProvider = vscode.lm.registerMcpServerDefinitionProvider('orbitBackend', {
                onDidChangeMcpServerDefinitions: mcpDefinitionsChanged.event,
                async provideMcpServerDefinitions() {
                    if (!mcpEnabled) return [];
                    // Probe each backend's MCP port; only return
                    // definitions for those that accept a TCP
                    // connection. This keeps unreachable backends
                    // out of the MCP servers list entirely instead
                    // of leaving them visible-but-erroring.
                    const reachable = await reachableBackends('mcp');
                    mcpReachable.clear();
                    reachable.forEach(b => mcpReachable.add(b.name));
                    orbitLog('[orbit] MCP provider: reachable=' +
                        JSON.stringify(reachable.map(b => b.name)));
                    return reachable.map(b => new vscode.McpHttpServerDefinition(
                        b.name,
                        vscode.Uri.parse(mcpUrlFor(b))
                    ));
                }
            });
            context.subscriptions.push(mcpProvider, mcpDefinitionsChanged);
            orbitLog('[orbit] MCP provider registered');

            // VS Code does not auto-start MCP servers on window
            // reload, so the reachable backend servers would be
            // visible but stopped. Kick off an initial activation
            // pass and a periodic retry loop, but only if the user
            // wants Orbit to auto-start (and hasn't explicitly
            // stopped it). Otherwise we'd start MCP servers behind
            // the user's back even when the Orbit web server is
            // intentionally stopped. orbit.start runs these same
            // passes explicitly, so a manual start still wires
            // everything up.
            for (const b of BACKENDS) mcpRunning[b.name] = false;
            const wantAutoStart = (() => {
                try {
                    if (!vscode.workspace.getConfiguration('orbit')
                        .get('autoStart', false)) return false;
                    const stoppedAt = +context.workspaceState
                        .get(EXPLICIT_STOP_KEY, 0) || 0;
                    if (stoppedAt > 0
                        && (Date.now() - stoppedAt) < EXPLICIT_STOP_TTL_MS) {
                        return false;
                    }
                    return true;
                } catch (_) { return false; }
            })();
            if (wantAutoStart) {
                activateReachableBackends().catch((e) => {
                    orbitError('[orbit] initial activateReachableBackends failed:',
                        e && e.message);
                });
                scheduleBackendActivationRetries();
            } else {
                orbitLog('[orbit] activate: skipping MCP activation (autoStart off or user explicitly stopped Orbit)');
            }
        } catch (e) {
            orbitError('[orbit] MCP provider registration failed:', e && e.message);
        }

        // On activate (including window reload) we deliberately do
        // NOT mount any WebDAV workspace folders. They are added only
        // when the user explicitly starts Orbit (orbit.start) or
        // toggles the WebDAV mount on via the webview. Any stale
        // orbit-webdav folders persisted in the workspace file from a
        // previous session are removed here so a fresh reload starts
        // with no Smalltalk filesystems mounted.
        try {
            removeWebdavWorkspaceFolders();
        } catch (e) {
            orbitError('[orbit] webdav folder cleanup on activate failed:',
                e && e.message);
        }

        // Auto-start the web server at activation time so that browser
        // tabs left open at the Orbit URL across VS Code restarts can
        // reconnect without the user having to invoke `orbit.start`.
        // Controlled by the `orbit.autoStart` setting (default: true).
        try {
            const autoStart = vscode.workspace
                .getConfiguration('orbit')
                .get('autoStart', false);
            const explicitlyStopped = (() => {
                try {
                    const stoppedAt = +context.workspaceState.get(EXPLICIT_STOP_KEY, 0) || 0;
                    return stoppedAt > 0 && (Date.now() - stoppedAt) < EXPLICIT_STOP_TTL_MS;
                }
                catch (_) { return false; }
            })();
            if (explicitlyStopped) {
                orbitLog('[orbit] auto-start skipped: user explicitly stopped Orbit before this activation');
            }
            if (autoStart && !explicitlyStopped) {
                // On a VS Code window reload, any Orbit browser tab
                // the user had open is restored *before* this
                // extension activates and starts the server, so the
                // restored tab shows a "failed to load" page. We use
                // the Integrated Browser's reuseUrlFilter option in
                // showOrbitBrowser, which navigates the existing
                // dead tab to the freshly-running server URL instead
                // of leaving it behind beside a new tab.
                startServer(context, true).catch((e) => {
                    orbitError('[orbit] auto-start failed:', e && e.message);
                });
                // MCP server start and WebDAV mount are handled by
                // activateReachableBackends + scheduleBackendActivationRetries
                // above, which run unconditionally on activate().
            } else {
                // autoStart is off (or user explicitly stopped Orbit
                // before this activation). On a window reload, any
                // Orbit browser tab the user had open is restored
                // by VS Code before we activate. Run orbit.stop
                // silently to close those stale tabs so the user
                // doesn't see a dead webapp until they click
                // "Start Orbit".
                vscode.commands.executeCommand('orbit.stop', { silent: true })
                    .then(undefined, (e) => {
                        orbitError('[orbit] activate-time orbit.stop failed:',
                            e && e.message);
                    });
            }
        } catch (e) {
            orbitError('[orbit] auto-start check failed:', e && e.message);
        }
    }

    function deactivate() {
        stopClipboardBridge();
        stopWorkspaceFsBridge();
        stopBackendActivationRetries();
        if (server) {
            server.close();
            server = null;
            setRunningContext(false);
        }
        if (webdavMountEnabled()) {
            try { removeWebdavWorkspaceFolders(); } catch (_) {}
        }
    }

    return { activate, deactivate };
};
