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

    function orbitUrl(port) {
        const base = `http://localhost:${port}/orbit.html`;
        return isDevHost ? `${base}?backend=192.168.1.140` : base;
    }

    let server = null;

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
    // returns the orbit backend definition only while `mcpEnabled` is
    // true; orbit.stop flips it to false and fires the change emitter
    // so VS Code drops the definition from its server list.
    let mcpEnabled = true;
    let mcpDefinitionsChanged = null;
    const ORBIT_MCP_SERVER_ID =
        'blackpagedigital.orbit-agentic-pair-programming-for-smalltalk/2300-backend';

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
    // The Smalltalk backend exposes a WebDAV server. The Orbit
    // extension talks to it directly via the in-process
    // FileSystemProvider (see src/webdav-fs.js); no host-OS WebDAV
    // client is involved.
    function webdavUrl() {
        const host = isDevHost ? '192.168.1.140' : '127.0.0.1';
        return `http://${host}:19073/webdav`;
    }

    function webdavMountEnabled() {
        try {
            return vscode.workspace
                .getConfiguration('orbit')
                .get('mountWebdav', true);
        } catch (_) { return true; }
    }

    // ---- WebDAV workspace folder management ------------------------------
    // The Orbit extension registers an in-process FileSystemProvider for
    // the orbit-webdav:// scheme (see src/webdav-fs.js). These helpers
    // add/remove that scheme's root as a workspace folder so the user
    // sees the Smalltalk-served tree in the Explorer without any host-OS
    // WebDAV client. Adding a non-first workspace folder in a
    // multi-root workspace does not restart the extension host.
    const WEBDAV_WS_URI = 'orbit-webdav://orbit/';

    function webdavWorkspaceFolderUri() {
        return vscode.Uri.parse(WEBDAV_WS_URI);
    }

    function findWebdavWorkspaceFolderIndex() {
        const folders = vscode.workspace.workspaceFolders || [];
        for (let i = 0; i < folders.length; i++) {
            if (folders[i].uri.scheme === 'orbit-webdav') return i;
        }
        return -1;
    }

    function addWebdavWorkspaceFolder() {
        const existingIdx = findWebdavWorkspaceFolderIndex();
        const existingFolders = vscode.workspace.workspaceFolders || [];
        orbitLog('[orbit] addWebdavWorkspaceFolder: called; existingIdx=' +
            existingIdx + ' folders=' +
            JSON.stringify(existingFolders.map(f => f.uri.toString())));
        if (existingIdx >= 0) return false;
        const folderSpec = { uri: webdavWorkspaceFolderUri(), name: 'Smalltalk' };
        const ok = vscode.workspace.updateWorkspaceFolders(
            existingFolders.length, 0, folderSpec
        );
        orbitLog('[orbit] addWebdavWorkspaceFolder: updateWorkspaceFolders=' + ok);
        // Verify after a tick. updateWorkspaceFolders is asynchronous
        // in effect: a true return doesn't guarantee the folder
        // appears, and a false return is silent. Log either way and
        // attempt one retry on the next folder-change tick.
        const sub = vscode.workspace.onDidChangeWorkspaceFolders((e) => {
            const idx = findWebdavWorkspaceFolderIndex();
            orbitLog('[orbit] onDidChangeWorkspaceFolders: idx=' + idx +
                ' added=' + JSON.stringify(e.added.map(f => f.uri.toString())) +
                ' removed=' + JSON.stringify(e.removed.map(f => f.uri.toString())));
            if (idx >= 0) sub.dispose();
        });
        setTimeout(() => {
            const idx = findWebdavWorkspaceFolderIndex();
            orbitLog('[orbit] addWebdavWorkspaceFolder: 500ms post-check idx=' + idx);
            if (idx < 0) {
                const now = vscode.workspace.workspaceFolders || [];
                const ok2 = vscode.workspace.updateWorkspaceFolders(
                    now.length, 0, folderSpec
                );
                orbitLog('[orbit] addWebdavWorkspaceFolder: retry updateWorkspaceFolders=' + ok2);
            }
        }, 500);
        return ok;
    }

    function removeWebdavWorkspaceFolder() {
        const idx = findWebdavWorkspaceFolderIndex();
        orbitLog('[orbit] removeWebdavWorkspaceFolder: called; idx=' + idx);
        if (idx < 0) return false;
        // Note: if this is the only workspace folder, VS Code will
        // force a window reload. The `orbit.explicitlyStopped`
        // workspaceState flag set by orbit.stop prevents auto-start
        // from running after that reload.
        const ok = vscode.workspace.updateWorkspaceFolders(idx, 1);
        orbitLog('[orbit] removeWebdavWorkspaceFolder: updateWorkspaceFolders=' + ok);
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
            url: `http://${mcpHost}:15072/mcpservice/v1/mcp`
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
    function setRunningContext(running) {
        try {
            vscode.commands.executeCommand('setContext', 'orbit.running', !!running);
        } catch (_) {}
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
                baseUrl: webdavUrl(),
                getAuthHeader: () => {
                    const b = readBearer(context.extensionPath);
                    return b ? 'Bearer ' + b : null;
                }
            });
            const reg = vscode.workspace.registerFileSystemProvider(scheme, provider, {
                isCaseSensitive: true,
                isReadonly: false
            });
            context.subscriptions.push(reg);
            orbitLog('[orbit] webdav FileSystemProvider registered for ' + scheme + '://');
        } catch (e) {
            orbitError('[orbit] webdav FS provider registration failed:', e && e.message);
        }

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
            if (webdavMountEnabled()) addWebdavWorkspaceFolder();
            // Re-publish the Orbit MCP definition (orbit.stop withdrew
            // it) before asking VS Code to start the server.
            if (!mcpEnabled) {
                mcpEnabled = true;
                if (mcpDefinitionsChanged) mcpDefinitionsChanged.fire();
            }
            // Best-effort: also start the Orbit MCP backend server so
            // the user doesn't have to start it separately. The server
            // id is `<extKey>/<label>`, where extKey is the lowercased
            // extension identifier and label is the McpHttpServerDefinition
            // label ('2300-backend').
            try {
                await vscode.commands.executeCommand(
                    'workbench.mcp.startServer',
                    ORBIT_MCP_SERVER_ID,
                    { autoTrustChanges: true }
                );
            } catch (e) {
                orbitError('[orbit] MCP startServer failed:', e && e.message);
            }
        });

        const stopCmd = vscode.commands.registerCommand('orbit.stop', async (opts) => {
            const keepTabs = !!(opts && opts.keepTabs);
            orbitLog('[orbit] orbit.stop: invoked; keepTabs=' + keepTabs);
            // Only treat this as an explicit user stop when invoked
            // standalone (not as part of orbit.start's restart cycle,
            // which signals itself via opts.keepTabs).
            if (!keepTabs) {
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
                vscode.window.showInformationMessage('Orbit stopped.');
            } else {
                vscode.window.showInformationMessage('Orbit is not running.');
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
            // Only remove the WebDAV workspace folder when the user
            // explicitly stopped Orbit. When orbit.stop is invoked as
            // part of orbit.start's restart cycle (keepTabs=true), the
            // remove + re-add races against VS Code's async folder
            // mutation pipeline and the re-add silently fails on the
            // first attempt — leaving the user with no WebDAV folder
            // until they retry. The FS provider stays registered for
            // the lifetime of the extension, so the folder remains
            // functional across a server restart.
            if (!keepTabs && webdavMountEnabled()) removeWebdavWorkspaceFolder();
            // Stop the Orbit MCP backend connection and withdraw its
            // definition so it disappears from the MCP servers list.
            try {
                await vscode.commands.executeCommand(
                    'workbench.mcp.stopServer',
                    ORBIT_MCP_SERVER_ID
                );
            } catch (e) {
                orbitError('[orbit.stop] MCP stopServer failed:', e && e.message);
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
            const subpath = await vscode.window.showInputBox({
                title: 'Orbit: Add WebDAV Folder to Workspace',
                prompt: 'Subpath under the WebDAV root. Leave blank to add the root.',
                placeHolder: 'classes/Object',
                ignoreFocusOut: true,
                value: ''
            });
            if (subpath === undefined) return; // user cancelled
            const cleaned = subpath.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
            const uriPath = '/' + cleaned;
            const uri = vscode.Uri.parse('orbit-webdav://orbit' + uriPath);

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
            const name = cleaned ? `Smalltalk:${cleaned}` : 'Smalltalk';
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
        // When the view first becomes visible (the user clicked the
        // Orbit icon in the activity bar), auto-start Orbit if it
        // isn't already running. Once the user has explicitly stopped
        // it via the Stop Orbit button, they'll restart it from the
        // same view, so we only auto-start if the server isn't up.
        try {
            const treeDataProvider = {
                getTreeItem: (el) => el,
                getChildren: () => []
            };
            const treeView = vscode.window.createTreeView('orbit.status', {
                treeDataProvider,
                showCollapseAll: false
            });
            const maybeAutoStart = async () => {
                if (server) return;
                orbitLog('[orbit] activity bar maybeAutoStart: starting server');
                try {
                    await startServer(context, true);
                } catch (e) {
                    orbitError('[orbit] auto-start from activity bar failed:', e && e.message);
                }
                if (webdavMountEnabled()) {
                    try { addWebdavWorkspaceFolder(); }
                    catch (e) { orbitError('[orbit] activity bar webdav add failed:', e && e.message); }
                }
            };
            if (treeView.visible) maybeAutoStart();
            const visSub = treeView.onDidChangeVisibility((e) => {
                if (e.visible) maybeAutoStart();
            });
            context.subscriptions.push(treeView, visSub);
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

        // Chat participant: @orbit
        const agentMdPath = path.join(context.extensionPath, 'agents', 'orbit.agent.md');
        const agentInstructions = fs.readFileSync(agentMdPath, 'utf8');

        const participant = vscode.chat.createChatParticipant('orbit.orbit', async (request, chatContext, response, token) => {
            try {
                const messages = [vscode.LanguageModelChatMessage.User(agentInstructions)];

                // Replay chat history so multi-turn works.
                for (const turn of (chatContext.history || [])) {
                    if (turn instanceof vscode.ChatRequestTurn) {
                        if (turn.participant === 'orbit.orbit') {
                            messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
                        }
                    } else if (turn instanceof vscode.ChatResponseTurn) {
                        if (turn.participant === 'orbit.orbit') {
                            const text = (turn.response || [])
                                .map(p => (p && p.value && typeof p.value.value === 'string') ? p.value.value : '')
                                .join('');
                            if (text) messages.push(vscode.LanguageModelChatMessage.Assistant(text));
                        }
                    }
                }

                messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

                // Build the tool list available to the model. Filter out our own
                // chat participant or anything without a description.
                const allTools = (vscode.lm.tools || []).filter(t => t && t.name && t.description);
                const toolMap = new Map(allTools.map(t => [t.name, t]));
                const toolsForModel = allTools.map(t => ({
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

                    // Record the assistant turn (text + tool calls) before tool results.
                    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

                    for (const call of toolCalls) {
                        if (token.isCancellationRequested) return;
                        const tool = toolMap.get(call.name);
                        if (!tool) {
                            messages.push(vscode.LanguageModelChatMessage.User([
                                new vscode.LanguageModelToolResultPart(call.callId, [
                                    new vscode.LanguageModelTextPart(`Tool '${call.name}' is not available.`)
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
        });
        participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'public', 'pictures', 'icons', 'participant', 'orbit.jpg');
        context.subscriptions.push(participant);

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
                provideMcpServerDefinitions() {
                    if (!mcpEnabled) return [];
                    return [
                        new vscode.McpHttpServerDefinition(
                            '2300-backend',
                            vscode.Uri.parse(`http://${mcpHost}:15072/mcpservice/v1/mcp`)
                        )
                    ];
                }
            });
            context.subscriptions.push(mcpProvider, mcpDefinitionsChanged);
            orbitLog('[orbit] MCP provider registered');
        } catch (e) {
            orbitError('[orbit] MCP provider registration failed:', e && e.message);
        }

        // Add the WebDAV workspace folder unconditionally on activate.
        // The FS provider above is registered unconditionally too, so
        // there is no scenario in which the folder should be present
        // but the provider absent. Doing this outside the
        // autoStart/explicitlyStopped gate ensures the user always
        // sees the Smalltalk tree in the Explorer regardless of
        // whether the web server is running. Surfaced as a
        // showInformationMessage on first add so the user gets visible
        // confirmation even if the DevTools console is filtered.
        try {
            if (webdavMountEnabled()) {
                addWebdavWorkspaceFolder();
            }
        } catch (e) {
            orbitError('[orbit] webdav folder add (unconditional) failed:',
                e && e.message);
        }

        // Auto-start the web server at activation time so that browser
        // tabs left open at the Orbit URL across VS Code restarts can
        // reconnect without the user having to invoke `orbit.start`.
        // Controlled by the `orbit.autoStart` setting (default: true).
        try {
            const autoStart = vscode.workspace
                .getConfiguration('orbit')
                .get('autoStart', true);
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
                // Ensure the Orbit MCP backend is started too, so the
                // user doesn't see it sitting in the MCP servers list
                // in a stopped state. On a fresh window reload, VS
                // Code hasn't yet enumerated this provider's
                // definitions when activate() runs, so an immediate
                // startServer call is a no-op. Retry a few times with
                // a short delay until it takes effect.
                try {
                    if (!mcpEnabled) {
                        mcpEnabled = true;
                        if (mcpDefinitionsChanged) mcpDefinitionsChanged.fire();
                    }
                    const tryStart = (attempt) => {
                        vscode.commands.executeCommand(
                            'workbench.mcp.startServer',
                            ORBIT_MCP_SERVER_ID,
                            { autoTrustChanges: true }
                        ).then(() => {
                            orbitLog('[orbit] auto-start MCP startServer ok (attempt ' + attempt + ')');
                        }, (e) => {
                            orbitError('[orbit] auto-start MCP startServer failed (attempt ' +
                                attempt + '):', e && e.message);
                            if (attempt < 5) {
                                setTimeout(() => tryStart(attempt + 1), 500 * attempt);
                            }
                        });
                    };
                    setTimeout(() => tryStart(1), 500);
                } catch (e) {
                    orbitError('[orbit] auto-start MCP failed:', e && e.message);
                }
            }
        } catch (e) {
            orbitError('[orbit] auto-start check failed:', e && e.message);
        }
    }

    function deactivate() {
        stopClipboardBridge();
        stopWorkspaceFsBridge();
        if (server) {
            server.close();
            server = null;
            setRunningContext(false);
        }
        if (webdavMountEnabled()) {
            try { removeWebdavWorkspaceFolder(); } catch (_) {}
        }
    }

    return { activate, deactivate };
};
