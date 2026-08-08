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

    // True iff the installed extension was wired up by
    // ./scripts/install-extension.sh (or build-extension.sh),
    // which replaces selected files inside the installed extension
    // directory with symlinks back to the workspace source. We use
    // public/orbit.html as the canary; the script always symlinks it.
    // This is the signal we use to default `orbit.autoStart` to true
    // on developer machines while keeping the default false for
    // end-user installs from the Marketplace.
    function isDeveloperInstall(context) {
        try {
            if (!context || !context.extensionPath) return false;
            const canary = path.join(context.extensionPath, 'public', 'orbit.html');
            return fs.lstatSync(canary).isSymbolicLink();
        } catch (_) {
            return false;
        }
    }

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
    //
    // The "Caffeine" backend is different: it's hosted by the Orbit
    // webapp page (the SqueakJS image in the browser) and proxied by
    // the Orbit webserver's CaffeineBridge (see website/src/caffeine-bridge.js).
    // Reachability is "is there a tether currently registered with
    // the bridge?", and the MCP URL is the bridge's HTTP endpoint on
    // the local Orbit webserver port (8089).
    //
    // To let Orbit run under stable VS Code and VS Code Insiders at the
    // same time (each activates its own copy of the extension, each
    // wanting to bind the webserver port), Insiders uses a distinct
    // port so the two don't collide. vscode.env.appName is
    // "Visual Studio Code - Insiders" on Insiders builds.
    const isInsiders = (() => {
        try { return /insiders/i.test(vscode.env.appName || ''); }
        catch (_) { return false; }
    })();
    const ORBIT_WEB_PORT = isInsiders ? 8090 : 8089;
    // The endpoint of the primary (historical) Caffeine MCP server,
    // hosted by SmalltalkMCPServer in the page's SqueakJS image. The
    // static "Caffeine" bridge backend below is the stable anchor for
    // this endpoint; additional MCPServer subclasses the page announces
    // are surfaced dynamically (see discoveredBridgeBackends()).
    const PRIMARY_BRIDGE_ENDPOINT = '/mcp/smalltalk';
    const BACKENDS = [
        { name: '2300-backend', kind: 'tcp',    mcpPort: 15072, webdavPort: 19072, toolPrefix: '2300-backend', proxyPort: 15172 },
        { name: '2300-ui',      kind: 'tcp',    mcpPort: 15070, webdavPort: 19070, toolPrefix: '2300-ui',      proxyPort: 15170 },
        { name: '2300-tmc',     kind: 'tcp',    mcpPort: 15200, webdavPort: 19200, toolPrefix: '2300-tmc',     proxyPort: 15300 },
        { name: 'Caffeine',     kind: 'bridge' }
    ];

    // Set by startServer to the live express app, so the MCP provider
    // and reachability probes can consult app.mcpBridge.
    let currentApp = null;

    function backendByName(name) {
        return allBackends().find(b => b.name === name);
    }

    // --- evaluate-call markers + undo --------------------------------
    //
    // To roll back the effect of an `evaluate` MCP tool call, the agent
    // is steered (see .github/copilot-instructions.md) to append one
    // JSON record line to a single persistent ledger, just before each
    // evaluate call:
    //
    //     .orbit/toolLogs/evaluate-markers.jsonl
    //
    // The user rolls calls back from the in-webapp Evaluate ledger
    // window (the <evaluate-ledger> web component), whose ↩ Undo button
    // POSTs to this extension's eval bridge → performEvaluateUndo. On
    // undo we signal the rollback over the tether and stamp the line
    // `"undoneAt"` (audit trail + idempotency). Because the records are
    // independent and the ledger is durable, evaluations can be undone
    // out of order and long after the fact.
    //
    // (An earlier iteration rendered a per-line editor CodeLens here
    // instead; it has been retired in favor of the web component. We
    // also deliberately avoid VS Code's chat Keep/Undo controls: undoing
    // any agent edit goes through the platform UndoRedoService with a
    // source mismatch that forces a blocking "Would you like to undo
    // 'X'?" modal with no setting to suppress — which is why the ledger
    // is written via the orbit.appendEvaluateMarker command, never an
    // agent edit tool.)
    const EVAL_LOG_REL = path.join('.orbit', 'toolLogs', 'evaluate-markers.jsonl');
    const EVAL_MARKERS_HEADER =
        '// evaluate undo markers — do not delete this header line; ' +
        'new entries are inserted directly below it (newest first)';
    const APPEND_EVAL_COMMAND = 'orbit.appendEvaluateMarker';
    const CLEAR_EVAL_COMMAND = 'orbit.clearEvaluateMarkers';
    const CAFFEINE_SNAPSHOT_COMMAND = 'orbit.caffeineSnapshot';
    function localWorkspaceFsPath() {
        const folders = vscode.workspace.workspaceFolders || [];
        const local = folders.find(f => f.uri && f.uri.scheme === 'file');
        return local ? local.uri.fsPath : null;
    }

    function evalMarkersFsPath() {
        const root = localWorkspaceFsPath();
        return root ? path.join(root, EVAL_LOG_REL) : null;
    }

    // Parse a marker document's text into line descriptors
    // ({ lineIndex, record }) for each JSON record line. The header and
    // any other non-JSON lines are ignored.
    function parseMarkerLines(text) {
        const lines = (text || '').split(/\r?\n/);
        const out = [];
        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (!trimmed || trimmed[0] !== '{') continue;
            let rec;
            try { rec = JSON.parse(trimmed); } catch (_) { continue; }
            if (rec && typeof rec === 'object' && rec.id != null) {
                out.push({ lineIndex: i, record: rec });
            }
        }
        return out;
    }

    function signalEvaluateUndo(record) {
        // The user clicked this marker's ↩ Undo button in the Evaluate
        // ledger window. Tell the page's SqueakJS image to roll back the
        // call's effect by
        // sending Lam2300 class >> undo: <json> over the tether, where
        // <json> is the stringified record originally written to the
        // marker file (tool, backend, id, at, source, ...). No
        // VisualWorks, no MCP — a fire-and-forget direct message-send
        // to a SqueakJS class (see CaffeineBridge.signalUndo). Any
        // error handling is Squeak's responsibility; we only log.
        const bridge = currentApp && currentApp.mcpBridge;
        const id = record && record.id;
        if (!bridge) {
            orbitError(`[orbit] evaluate UNDO for ${id || '?'}: no bridge available`);
            return;
        }
        const payload = JSON.stringify(record || {});
        orbitLog(`[orbit] evaluate UNDO detected for call ${id || '?'} ` +
            `(backend ${(record && record.backend) || '?'}); signaling page`);
        Promise.resolve(bridge.signalUndo(payload))
            .then(() => orbitLog(`[orbit] undo signal delivered for ${id || '?'}`))
            .catch((e) => orbitError(
                `[orbit] undo signal failed for ${id || '?'}: ` + (e && e.message)));
    }

    // Ensure the single persistent marker document exists with its
    // stable header line, so the agent always has an anchor to insert
    // below and our watcher has a file to follow.
    function ensureEvalMarkersFile(file) {
        try {
            if (!fs.existsSync(file)) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, EVAL_MARKERS_HEADER + '\n', 'utf8');
            }
        } catch (e) {
            orbitError('[orbit] could not create evaluate markers file: ' +
                (e && e.message));
        }
    }

    // The ledger must never be touched by an agent edit tool (that
    // attaches chat Keep/Undo controls) and we also want to avoid
    // buffer/disk divergence: when the file happens to be open in an
    // editor, the buffer and disk must agree. When the file is open in
    // an editor we therefore write *through the document* with a
    // WorkspaceEdit and save it (buffer is authoritative, no chat
    // controls); when it is closed we write directly with fs. Either
    // way the chat editing session never sees the change.
    function currentMarkerText() {
        const file = evalMarkersFsPath();
        if (!file) return null;
        const open = vscode.workspace.textDocuments.find(
            d => d.uri.scheme === 'file' && d.uri.fsPath === file);
        if (open) return open.getText();
        try { return fs.readFileSync(file, 'utf8'); }
        catch (_) { return EVAL_MARKERS_HEADER + '\n'; }
    }

    // Apply `transform(oldText) -> newText` to the ledger, preferring
    // the open document so buffer and disk stay in lock-step.
    async function persistMarker(transform) {
        const file = evalMarkersFsPath();
        if (!file) return false;
        ensureEvalMarkersFile(file);
        const uri = vscode.Uri.file(file);
        const open = vscode.workspace.textDocuments.find(
            d => d.uri.scheme === 'file' && d.uri.fsPath === file);
        if (open) {
            const oldText = open.getText();
            const newText = transform(oldText);
            if (newText === oldText) return true;
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                open.positionAt(0), open.positionAt(oldText.length));
            edit.replace(uri, fullRange, newText);
            const ok = await vscode.workspace.applyEdit(edit);
            if (ok) { try { await open.save(); } catch (_) { /* best effort */ } }
            return ok;
        }
        let oldText;
        try { oldText = fs.readFileSync(file, 'utf8'); }
        catch (_) { oldText = EVAL_MARKERS_HEADER + '\n'; }
        try { fs.writeFileSync(file, transform(oldText), 'utf8'); return true; }
        catch (e) {
            orbitError('[orbit] could not write evaluate markers file: ' +
                (e && e.message));
            return false;
        }
    }

    // Command: append a marker line for an evaluate call. The agent
    // invokes this via run_vscode_command (NOT its edit tools), so the
    // chat editing session never sees the change — no Keep/Undo buttons
    // appear on the logfile. The single string arg is the JSON record.
    async function appendEvaluateMarkerCommand(recordArg) {
        const file = evalMarkersFsPath();
        if (file) ensureEvalMarkersFile(file);
        let record;
        try { record = typeof recordArg === 'string' ? JSON.parse(recordArg) : recordArg; }
        catch (e) { orbitError('[orbit] appendEvaluateMarker: bad JSON arg'); return null; }
        if (!record || typeof record !== 'object') record = {};
        if (record.tool == null) record.tool = 'evaluate';
        // Fill in id + at from a single instant when the caller omits
        // them, so the agent doesn't have to compute anything.
        const nowIso = new Date().toISOString();
        if (record.at == null) record.at = nowIso;
        if (record.id == null) {
            record.id = record.at.replace(/[:.]/g, '-').replace('Z', '') +
                '-' + Math.random().toString(36).slice(2, 8);
        }
        const line = JSON.stringify(record);
        await persistMarker((text) => {
            // Insert directly below the header (first line); newest first.
            const nl = text.indexOf('\n');
            return nl >= 0
                ? text.slice(0, nl + 1) + line + '\n' + text.slice(nl + 1)
                : text + (text.endsWith('\n') || text === '' ? '' : '\n') + line + '\n';
        });
        orbitLog(`[orbit] evaluate marker appended: ${record.id} ` +
            `(backend ${record.backend || '?'})`);
        return record.id;
    }

    // The current ledger as an array of records (newest first), for the
    // eval bridge and anything else that needs to list evaluations.
    // Reads the open buffer when present, else disk.
    function listEvaluateMarkers() {
        return parseMarkerLines(currentMarkerText()).map((m) => m.record);
    }

    // Reset the ledger to header-only, dropping every marker. Driven by
    // the eval bridge (the web component's Clear button). Uses
    // persistMarker so an open editor buffer stays authoritative and no
    // chat Keep/Undo buttons attach. Returns { ok, cleared:N }.
    async function performEvaluateClear() {
        let removed = 0;
        await persistMarker((text) => {
            for (const line of text.split(/\r?\n/)) {
                const t = line.trim();
                if (t && t[0] === '{') removed++;
            }
            return EVAL_MARKERS_HEADER + '\n';
        });
        orbitLog(`[orbit] evaluate ledger cleared (${removed} marker` +
            `${removed === 1 ? '' : 's'})`);
        return { ok: true, cleared: removed };
    }

    async function clearEvaluateMarkersCommand() {
        const file = evalMarkersFsPath();
        if (file) ensureEvalMarkersFile(file);
        const result = await performEvaluateClear();
        return result.cleared;
    }

    // Command: snapshot the page-side SqueakJS (Caffeine) object
    // memory. The agent invokes this via run_vscode_command just
    // before exporting caffeine.image/caffeine.changes during an
    // extension rebuild (see the steering file). Delegates to
    // CaffeineBridge.snapshot, which sends `snapshot` to the page
    // tether. Returns true on success; throws if no bridge/page tether.
    async function caffeineSnapshotCommand() {
        const bridge = currentApp && currentApp.mcpBridge;
        if (!bridge) throw new Error('no Caffeine bridge available');
        await bridge.snapshot();
        orbitLog('[orbit] Caffeine snapshot requested');
        // The image state is durable now; fold the disk mirror to match.
        checkpointKeepMirror().catch((e) => orbitLog(
            `[keep-mirror] checkpoint after snapshot failed: ${e && e.message}`));
        return true;
    }

    // --- Keep note filesystem mirror ---------------------------------
    //
    // The Keep store lives inside the Caffeine SqueakJS image and is
    // otherwise persisted only when the image is snapshotted. To make
    // agent memory survive image loss (and to make it diffable /
    // greppable / PR-reviewable), we mirror every Keep *mutation* that
    // flows through the CaffeineBridge to two on-disk artifacts under
    // .orbit/keep/ (see designs/keep-fs-persistence.md):
    //
    //   ops.jsonl        append-only, event-sourced mutation log
    //                    (durable source of truth on disk; replayable)
    //   notes/<id>.md    per-note Markdown projection (front-matter +
    //                    content; human-readable, regenerable)
    //   edge-tags.json   declared edge-tag forward/inverse pairs
    //
    // As with the Evaluate ledger, the *extension* writes these files
    // itself (plain fs, off to the side of the chat editing session) —
    // never the image, never an agent edit tool — so no chat Keep/Undo
    // controls attach. The tap is CaffeineBridge's onKeepMutation hook.
    const KEEP_DIR_REL   = path.join('.orbit', 'keep');
    const KEEP_OPS_REL   = path.join(KEEP_DIR_REL, 'ops.jsonl');
    const KEEP_NOTES_REL = path.join(KEEP_DIR_REL, 'notes');
    const KEEP_EDGES_REL = path.join(KEEP_DIR_REL, 'edge-tags.json');
    const KEEP_SNAP_REL  = path.join(KEEP_DIR_REL, 'snapshot.json');
    const KEEP_OPS_ARCHIVE_REL = path.join(KEEP_DIR_REL, 'ops-archive');
    let keepOpSeq = null; // lazily initialized: snapshot base + line count
    // While true, mutations flowing through the bridge are NOT mirrored
    // — set when the extension itself re-issues ops that are already on
    // disk (startup reconciliation), to avoid duplicating them.
    let keepMirrorSuppress = false;

    function keepPathFor(rel) {
        const root = localWorkspaceFsPath();
        return root ? path.join(root, rel) : null;
    }

    // Sanitize a note id for use as a filename. The true id is always
    // preserved inside the note's front-matter, so the mapping is
    // recoverable even when sanitization collapses distinct ids.
    function keepSafeId(id) {
        return String(id == null ? 'unnamed' : id)
            .replace(/[^A-Za-z0-9._-]/g, '_')
            .slice(0, 200) || 'unnamed';
    }

    // Current monotonic op sequence number, initialized once from the
    // checkpoint snapshot's covered seq plus the existing ops.jsonl line
    // count, so numbering is stable across extension restarts and
    // continues across op-log rotations.
    function ensureKeepSeq(opsFile) {
        if (keepOpSeq == null) {
            let base = 0;
            try {
                const snap = JSON.parse(
                    fs.readFileSync(keepPathFor(KEEP_SNAP_REL), 'utf8'));
                if (snap && Number.isFinite(snap.seq)) base = snap.seq;
            } catch (_) { base = 0; }
            let count = 0;
            try {
                const text = fs.readFileSync(opsFile, 'utf8');
                count = text.split('\n').filter((l) => l.trim() !== '').length;
            } catch (_) { count = 0; }
            keepOpSeq = base + count;
        }
        return keepOpSeq;
    }

    function nextKeepSeq(opsFile) {
        ensureKeepSeq(opsFile);
        keepOpSeq += 1;
        return keepOpSeq;
    }

    // Extract the full note from a Keep tool's decoded result: keepTag
    // answers {note: {...}}; keepPut and keepNow answer the bare note.
    function keepNoteFromResult(res) {
        if (!res || typeof res !== 'object') return null;
        if (res.note && typeof res.note === 'object') return res.note;
        return (res.id != null && 'content' in res) ? res : null;
    }

    // Render a note's Markdown projection: JSON-encoded scalars in the
    // front-matter (valid YAML flow scalars, no YAML dep, no injection)
    // followed by the note content as the body.
    function keepNoteMarkdown(note) {
        const j = (v) => JSON.stringify(v == null ? '' : v);
        const tags = note && typeof note.tags === 'object' && note.tags
            ? note.tags : {};
        const lines = [
            '---',
            'id: ' + j(note && note.id),
            'agent: ' + j(note && note.agent),
            'createdAt: ' + j(note && note.createdAt),
            'summary: ' + j(note && note.summary),
            'tags: ' + JSON.stringify(tags),
            '---',
            '',
            (note && typeof note.content === 'string') ? note.content : ''
        ];
        return lines.join('\n') + '\n';
    }

    // Write/overwrite a note's Markdown projection from a full note
    // object (as returned by keepPut / keepTag / keepNow-write).
    function keepWriteNoteFile(note) {
        const notesDir = keepPathFor(KEEP_NOTES_REL);
        if (!notesDir || !note || note.id == null) return;
        fs.mkdirSync(notesDir, { recursive: true });
        const file = path.join(notesDir, keepSafeId(note.id) + '.md');
        fs.writeFileSync(file, keepNoteMarkdown(note), 'utf8');
    }

    // Delete a note's Markdown projection (keepRemove).
    function keepDeleteNoteFile(id) {
        const notesDir = keepPathFor(KEEP_NOTES_REL);
        if (!notesDir || id == null) return;
        const file = path.join(notesDir, keepSafeId(id) + '.md');
        try { fs.unlinkSync(file); } catch (_) { /* already gone */ }
    }

    // Merge a declared edge tag into edge-tags.json (keepDeclareEdgeTag).
    function keepMergeEdgeTag(tag, inverse) {
        const file = keepPathFor(KEEP_EDGES_REL);
        if (!file || tag == null) return;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        let map = {};
        try { map = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; }
        catch (_) { map = {}; }
        map[tag] = inverse == null ? null : inverse;
        fs.writeFileSync(file, JSON.stringify(map, null, 2) + '\n', 'utf8');
    }

    // The CaffeineBridge.onKeepMutation hook: append a faithful op-log
    // record for the mutation, then update the Markdown/edge-tag
    // projection. Best-effort — never allowed to break an MCP call.
    function mirrorKeepMutation(params, result) {
        if (keepMirrorSuppress) return;
        const opsFile = keepPathFor(KEEP_OPS_REL);
        if (!opsFile) return;
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        const res  = (result && typeof result === 'object') ? result : {};
        const note = keepNoteFromResult(res);
        const id = (note && note.id) != null ? note.id
            : (res.id != null ? res.id : args.id);

        // 1) Append the op-log record (source of truth on disk).
        fs.mkdirSync(path.dirname(opsFile), { recursive: true });
        const record = {
            seq: nextKeepSeq(opsFile),
            at: new Date().toISOString(),
            tool: name,
            id: id == null ? null : id,
            agent: args.agent != null ? args.agent
                : (note && note.agent != null ? note.agent : undefined),
            args,
            result: res
        };
        fs.appendFileSync(opsFile, JSON.stringify(record) + '\n', 'utf8');

        // 2) Update the projection.
        switch (name) {
        case 'keepPut':
        case 'keepTag':
        case 'keepNow':
            if (note) keepWriteNoteFile(note);
            break;
        case 'keepRemove':
            keepDeleteNoteFile(id);
            break;
        case 'keepDeclareEdgeTag':
            keepMergeEdgeTag(res.tag != null ? res.tag : args.tag,
                res.inverse != null ? res.inverse : args.inverse);
            break;
        case 'keepArchive':
            // Op-log only: the archive result carries just the affected
            // ids, not their bodies, so the per-note `archived` flag
            // lags until each note is next put/tagged. See the design
            // note's "known limitation".
            break;
        default:
            break;
        }
        orbitLog(`[orbit] Keep mirror: ${name} ${id || ''} (seq ${record.seq})`);
    }

    // Core rollback: signal the tether and stamp the matching marker
    // "undoneAt". Driven by the eval bridge (the web component's ↩ Undo).
    // Returns { ok, record, alreadyUndone?, reason? } — never throws for
    // the expected not-found / already-undone cases.
    async function performEvaluateUndo(id) {
        const wantId = String(id);
        const text = currentMarkerText();
        if (text == null) {
            return { ok: false, reason: 'no-ledger' };
        }
        let live = null;
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed[0] !== '{') continue;
            let rec; try { rec = JSON.parse(trimmed); } catch (_) { continue; }
            if (rec && String(rec.id) === wantId) { live = rec; break; }
        }
        if (!live) {
            return { ok: false, reason: 'not-found' };
        }
        if (live.undoneAt) {
            return { ok: false, alreadyUndone: true, record: live };
        }
        // 1. Signal the rollback over the tether (fire-and-forget).
        signalEvaluateUndo(live);
        // 2. Stamp the matching line undone — audit trail + idempotency
        //    guard. Re-find by id inside the transform so we stamp the
        //    correct line even if the ledger shifted.
        const undoneAt = new Date().toISOString();
        await persistMarker((t) => {
            const lines = t.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const trimmed = lines[i].trim();
                if (!trimmed || trimmed[0] !== '{') continue;
                let rec; try { rec = JSON.parse(trimmed); } catch (_) { continue; }
                if (rec && String(rec.id) === wantId && !rec.undoneAt) {
                    rec.undoneAt = undoneAt;
                    lines[i] = JSON.stringify(rec);
                    break;
                }
            }
            return lines.join('\n');
        });
        return { ok: true, record: Object.assign({}, live, { undoneAt }) };
    }

    function setupEvalMarkers(context) {
        const file = evalMarkersFsPath();
        if (file) ensureEvalMarkersFile(file);
        const appendCmd = vscode.commands.registerCommand(
            APPEND_EVAL_COMMAND, appendEvaluateMarkerCommand);
        const clearCmd = vscode.commands.registerCommand(
            CLEAR_EVAL_COMMAND, clearEvaluateMarkersCommand);
        const snapshotCmd = vscode.commands.registerCommand(
            CAFFEINE_SNAPSHOT_COMMAND, caffeineSnapshotCommand);
        const keepCheckpointCmd = vscode.commands.registerCommand(
            'orbit.keepCheckpoint', checkpointKeepMirror);
        if (context && context.subscriptions) {
            context.subscriptions.push(appendCmd, clearCmd, snapshotCmd,
                keepCheckpointCmd);
        }
        orbitLog('[orbit] evaluate marker commands armed' + (file ? ' on ' + file : ''));
    }

    // Resolve the bridge endpoint that backs a given bridge-kind
    // backend. Multi-endpoint aware: the page announces one MCP
    // endpoint per registered MCPServer subclass in its SqueakJS image
    // (see Tether>>provideSmalltalkMCPService). A dynamically-discovered
    // backend descriptor carries its own `endpoint`; we return it once
    // the bridge has actually seen the page announce it. The static
    // "Caffeine" anchor backend carries no endpoint, so it resolves to
    // the primary SmalltalkMCPServer endpoint (falling back to the
    // first announced endpoint for older images).
    function bridgeEndpointFor(backend) {
        if (!currentApp || !currentApp.mcpBridge) return null;
        const announced = Array.from(currentApp.mcpBridge.mcpServers.keys());
        if (backend && backend.endpoint) {
            return announced.includes(backend.endpoint) ? backend.endpoint : null;
        }
        if (announced.includes(PRIMARY_BRIDGE_ENDPOINT)) return PRIMARY_BRIDGE_ENDPOINT;
        return announced[0] || null;
    }

    // The endpoint a bridge backend may claim as its own for MCP
    // registration purposes. Discovered backends own their announced
    // endpoint. The static "Caffeine" anchor owns its resolved endpoint
    // only when the page announced it under the plain 'Caffeine' name —
    // i.e. the primary object memory, or an older image announcing no
    // name. A secondary object memory always announces a suffixed name
    // (e.g. 'Caffeine-ableton', see caffeine-bridge.js), even when it
    // owns the primary endpoint because the primary page isn't open;
    // discoveredBridgeBackends() surfaces it under that name, and the
    // anchor must not also claim it, or VS Code would list the same
    // server mislabeled "Caffeine".
    function ownedBridgeEndpointFor(backend) {
        const ep = bridgeEndpointFor(backend);
        if (!ep) return null;
        if (backend && backend.endpoint) return ep;
        const bridge = currentApp && currentApp.mcpBridge;
        if (!bridge || typeof bridge.mcpServerNameFor !== 'function') return ep;
        return bridge.mcpServerNameFor(ep) === 'Caffeine' ? ep : null;
    }

    // Turn an endpoint path into a stable, prefix-safe backend name for
    // any non-primary MCP server the page announces, e.g.
    // '/mcp/inventory' -> 'Caffeine-inventory'.
    function bridgeBackendNameFromEndpoint(endpoint) {
        const tail = String(endpoint).replace(/^\/+/, '').split('/').pop() || 'server';
        return 'Caffeine-' + tail.replace(/[^A-Za-z0-9_-]/g, '-');
    }

    // Dynamically discover the extra bridge-kind backends the page has
    // announced beyond the primary Caffeine server. Each announced
    // endpoint corresponds to an MCPServer subclass in the image; the
    // primary endpoint (/mcp/smalltalk) is represented by the static
    // "Caffeine" backend, so it is skipped here — but only while it is
    // announced under the plain 'Caffeine' name. When a secondary
    // object memory owns it (announced as e.g. 'Caffeine-ableton'), it
    // is surfaced here under that name instead. The rest become extra
    // bridge backends whose name comes from the serverInfo the image
    // supplied with its providing-frame (falling back to a name derived
    // from the endpoint path).
    function discoveredBridgeBackends() {
        if (!currentApp || !currentApp.mcpBridge) return [];
        const bridge = currentApp.mcpBridge;
        if (typeof bridge.discoveredEndpoints !== 'function') return [];
        const out = [];
        for (const { endpoint, name } of bridge.discoveredEndpoints()) {
            if (endpoint === PRIMARY_BRIDGE_ENDPOINT
                && (!name || name === 'Caffeine')) continue;
            const serverName = name || bridgeBackendNameFromEndpoint(endpoint);
            out.push({
                name: serverName,
                kind: 'bridge',
                endpoint,
                // VS Code names an MCP server's tools from its
                // serverInfo.name, normalizing non-alphanumeric chars
                // to '_'. Mirror that so isMcpServerActuallyRunning's
                // prefix match works for discovered servers.
                toolPrefix: serverName.replace(/[^A-Za-z0-9]/g, '_')
            });
        }
        return out;
    }

    // The full set of backends: the static ones plus any dynamically
    // discovered bridge servers. Used by everything that must react to
    // servers the page adds at runtime (reachability probes, the MCP
    // definition provider, activation). The activity-bar UI machinery
    // continues to key off the static BACKENDS array.
    //
    // Backends we've abandoned (see abandonUnconnected2300Backends) are
    // filtered out here, which removes them from the MCP definition
    // provider (VS Code's MCP servers list), the Orbit panel checkbox
    // rows, and the activation/reconnect machinery in one stroke.
    function allBackends() {
        return BACKENDS.concat(discoveredBridgeBackends())
            .filter(b => !mcpAbandoned.has(b.name));
    }

    // Whether VS Code's MCP client has actually contacted the bridge
    // endpoint (i.e. POSTed an initialize) since the page registered.
    // This is the authoritative "VS Code is talking to us" signal for
    // bridge-kind backends, since vscode.lm.tools can retain stale
    // tool entries from previous sessions even when the MCP client
    // is no longer connected.
    function bridgeVscodeConnected(backend) {
        if (!currentApp || !currentApp.mcpBridge) return false;
        const ep = ownedBridgeEndpointFor(backend);
        if (!ep) return false;
        return currentApp.mcpBridge.lastInitializeAt.has(ep);
    }

    function mcpUrlFor(backend) {
        if (backend.kind === 'bridge') {
            const ep = ownedBridgeEndpointFor(backend);
            if (!ep) return null;
            // The Orbit webserver always runs on the same machine
            // as VS Code, so target localhost regardless of the
            // dev-host LAN-address override used for the 2300
            // backends. Use the string "localhost" (not 127.0.0.1)
            // because VS Code's MCP HTTP client appears to silently
            // refuse to POST initialize to a bare-IP loopback URL.
            return `http://localhost:${ORBIT_WEB_PORT}${ep}`;
        }
        // Route TCP backends through their per-backend proxy server
        // (own port → own origin → isolated OAuth). Fall back to
        // direct URL if proxies aren't running yet.
        if (mcpProxies && mcpProxies.has(backend.name)) {
            const p = mcpProxies.get(backend.name);
            return `http://localhost:${p.port}/mcpservice/v1/mcp`;
        }
        return `http://${mcpHost}:${backend.mcpPort}/mcpservice/v1/mcp`;
    }

    function webdavUrlFor(backend) {
        if (backend.kind === 'bridge') {
            // Caffeine has no listening HTTP WebDAV port; its WebDAVServer is
            // reached over the CaffeineBridge tether, proxied same-origin at the
            // Orbit webserver's /webdav route (see app-impl.js). Only usable once
            // the page tether has announced itself.
            return ownedBridgeEndpointFor(backend)
                ? `http://localhost:${ORBIT_WEB_PORT}/webdav`
                : null;
        }
        return `http://${backendHost}:${backend.webdavPort}/webdav`;
    }

    // Headers to send to the Orbit CaffeineBridge so it accepts the
    // proxied JSON-RPC POST. The bridge gates POSTs on the same
    // Orbit MCP bearer that the 2300 backends accept via OAuth; we
    // bypass OAuth here because the bridge endpoint is local-only.
    function bridgeAuthHeaders() {
        const bridge = currentApp && currentApp.mcpBridge;
        const bearer = bridge && bridge.bearer;
        return bearer ? { Authorization: `Bearer ${bearer}` } : undefined;
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
    // service. Returns an array of {backend, reachable}. Bridge-kind
    // backends serve both 'mcp' and 'webdav' over the tether (their
    // reachability is "is there a tether registered with the Orbit
    // CaffeineBridge?"); they are reachable for either kind once the
    // page tether has announced.
    async function probeBackends(kind) {
        const probes = allBackends().map(async (b) => {
            let reachable;
            if (b.kind === 'bridge') {
                // Caffeine now serves both MCP and WebDAV over the bridge tether, so it
                // is reachable for either kind whenever the page tether has announced
                // an endpoint this backend owns (see ownedBridgeEndpointFor).
                reachable = !!ownedBridgeEndpointFor(b);
            } else {
                const port = kind === 'mcp' ? b.mcpPort : b.webdavPort;
                const host = kind === 'mcp' ? mcpHost : backendHost;
                reachable = await probeTcp(host, port, 800);
            }
            return { backend: b, reachable };
        });
        return Promise.all(probes);
    }

    async function reachableBackends(kind) {
        const results = await probeBackends(kind);
        return results.filter(r => r.reachable).map(r => r.backend);
    }

    // Resolve the devtunnel CLI binary path (cross-platform).
    async function findDevtunnelCli() {
        const candidates = process.platform === 'win32'
            ? ['devtunnel.exe']
            : ['/opt/homebrew/bin/devtunnel', '/usr/local/bin/devtunnel', 'devtunnel'];
        for (const c of candidates) {
            if (path.isAbsolute(c)) {
                try { await fs.promises.access(c); return c; }
                catch (_) {}
            } else {
                return c; // bare name, assume in PATH
            }
        }
        return null;
    }

    // Child process hosting the devtunnel. Killed on deactivate/stop.
    let tunnelHostProcess = null;
    // The devtunnel ID for the currently hosted tunnel.
    let activeTunnelId = null;

    // Keep sync controller instance. Created on server start if
    // orbit.keepSync.gistId or orbit.keepSync.org is configured.
    let keepSync = null;

    // Start (or reuse) a dedicated Orbit dev tunnel that forwards
    // the given port to localhost. Returns the tunnel's HTTPS URI,
    // or null if the CLI is unavailable or hosting fails.
    //
    // Strategy:
    //   1. Look for an existing tunnel labeled "orbit" + hostname.
    //   2. If none exists, create one.
    //   3. Ensure port is registered + org ACL applied.
    //   4. Spawn `devtunnel host <tunnelId>` as a child process.
    //   5. Parse the "Connect via browser:" line for the URI.
    async function startTunnelHost(port) {
        const { execFile, spawn } = require('child_process');
        const DEVTUNNEL = await findDevtunnelCli();
        if (!DEVTUNNEL) return null;

        let loggedIn = false;
        const execOnce = (args) => new Promise((resolve, reject) => {
            execFile(DEVTUNNEL, args, { timeout: 15000 }, (err, stdout, stderr) => {
                if (err) reject(new Error(stderr || err.message));
                else resolve(stdout);
            });
        });
        const exec = async (args) => {
            try {
                return await execOnce(args);
            } catch (e) {
                if (!loggedIn && /login token expired|unauthorized|login required/i.test(e.message)) {
                    orbitLog('[orbit] devtunnel token expired, re-authenticating...');
                    await execOnce(['login', '--github']);
                    loggedIn = true;
                    return await execOnce(args);
                }
                throw e;
            }
        };

        const hostname = os.hostname().split('.')[0].toLowerCase();
        const org = vscode.workspace.getConfiguration('orbit.keepSync').get('org');

        // Find or create the Orbit tunnel
        let tunnelId = null;
        try {
            const out = await exec(['list', '--json']);
            const parsed = JSON.parse(out);
            const tunnels = parsed.tunnels || parsed;
            const existing = tunnels.find(t =>
                (t.labels || []).includes('orbit') &&
                (t.labels || []).includes(hostname)
            );
            if (existing) {
                tunnelId = (existing.tunnelId || '').replace(/\.\w+$/, '');
            }
        } catch (_) {}

        if (!tunnelId) {
            try {
                const out = await exec(['create', '--labels', 'orbit', '--labels', hostname, '--json']);
                const parsed = JSON.parse(out);
                const t = parsed.tunnel || parsed;
                tunnelId = (t.tunnelId || '').replace(/\.\w+$/, '');
                orbitLog(`[orbit] Created tunnel ${tunnelId}`);
            } catch (e) {
                orbitLog(`[orbit] Failed to create tunnel: ${e.message}`);
                return null;
            }
        }

        // Ensure port is registered
        try {
            const showOut = await exec(['show', tunnelId, '--json']);
            const info = (JSON.parse(showOut)).tunnel || JSON.parse(showOut);
            const hasPort = (info.ports || []).some(p => p.portNumber === port);
            if (!hasPort) {
                await exec(['port', 'create', tunnelId, '-p', String(port)]);
                orbitLog(`[orbit] Registered port ${port} on tunnel ${tunnelId}`);
            }
        } catch (e) {
            orbitLog(`[orbit] Port setup warning: ${e.message}`);
        }

        // Ensure org-scoped access
        if (org) {
            try {
                await exec(['access', 'create', tunnelId, '--org', org]);
                orbitLog(`[orbit] Org access set for ${org} on tunnel ${tunnelId}`);
            } catch (e) {
                const msg = e.message || '';
                if (!msg.includes('already') && !msg.includes('exists')) {
                    orbitLog(`[orbit] Org access warning: ${msg}`);
                }
            }
        }

        // Check if devtunnel host is already running for this tunnel
        // (e.g. surviving from a previous extension activation)
        activeTunnelId = tunnelId;
        try {
            const { execSync } = require('child_process');
            const ps = execSync(`ps aux`, { encoding: 'utf8', timeout: 5000 });
            if (ps.includes(`devtunnel host ${tunnelId}`)) {
                // Already hosting — derive URI from `devtunnel show`
                try {
                    const showOut = await exec(['show', tunnelId, '--json']);
                    const info = (JSON.parse(showOut)).tunnel || JSON.parse(showOut);
                    const portInfo = (info.ports || []).find(p => p.portNumber === port);
                    if (portInfo && portInfo.portForwardingUris && portInfo.portForwardingUris.length) {
                        const uri = portInfo.portForwardingUris[0];
                        orbitLog(`[orbit] Reattached to existing tunnel host: ${uri}`);
                        return uri;
                    }
                } catch (_) {}
                // Fallback: construct URI from clusterId
                try {
                    const showOut = await exec(['show', tunnelId, '--json']);
                    const info = (JSON.parse(showOut)).tunnel || JSON.parse(showOut);
                    const clusterId = info.clusterId || 'usw3';
                    const uri = `https://${tunnelId.replace(/\./g, '')}-${port}.${clusterId}.devtunnels.ms`;
                    orbitLog(`[orbit] Reattached to existing tunnel host (constructed): ${uri}`);
                    return uri;
                } catch (_) {}
            }
        } catch (_) {}

        // Spawn `devtunnel host` and wait for the URI line
        return new Promise((resolve) => {
            const child = spawn(DEVTUNNEL, ['host', tunnelId], {
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: false
            });
            let resolved = false;
            let output = '';

            const onData = (chunk) => {
                output += chunk.toString();
                // Look for: "Connect via browser: https://..., https://ID-PORT.REGION.devtunnels.ms"
                const match = output.match(/https:\/\/([a-z0-9]+-\d+\.[a-z0-9]+\.devtunnels\.ms)/);
                if (match && !resolved) {
                    resolved = true;
                    tunnelHostProcess = child;
                    resolve('https://' + match[1]);
                }
            };
            child.stdout.on('data', onData);
            child.stderr.on('data', onData);

            child.on('error', (err) => {
                if (!resolved) {
                    resolved = true;
                    orbitLog(`[orbit] devtunnel host failed: ${err.message}`);
                    resolve(null);
                }
            });
            child.on('exit', (code) => {
                tunnelHostProcess = null;
                if (!resolved) {
                    resolved = true;
                    orbitLog(`[orbit] devtunnel host exited (code ${code})`);
                    resolve(null);
                }
            });

            // Timeout after 20s
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    orbitLog('[orbit] devtunnel host timed out waiting for URI');
                    child.kill();
                    resolve(null);
                }
            }, 20000);
        });
    }

    // Stop the devtunnel host child process if running.
    function stopTunnelHost() {
        if (tunnelHostProcess) {
            try { tunnelHostProcess.kill(); } catch (_) {}
            tunnelHostProcess = null;
        }
    }

    function orbitUrl(port) {
        const base = `http://localhost:${port}/orbit.html`;
        return isDevHost ? `${base}?backend=192.168.1.140` : base;
    }

    // URL for booting a specific local object memory (a *.image in the
    // page's IndexedDB) in its own Integrated Browser tab. squeak.html
    // reads the `image` query param and boots that image. The primary
    // "caffeine" memory uses the plain orbitUrl. No `backend` param:
    // a secondary memory is unlikely to pair with a remote Smalltalk.
    function orbitUrlForMemory(port, memory) {
        if (!memory || memory === 'caffeine') return orbitUrl(port);
        const base = `http://localhost:${port}/orbit.html`;
        return `${base}?image=${encodeURIComponent(memory)}`;
    }

    // Object memories (*.image files) the page has reported present in
    // its IndexedDB. Reported by public/js/orbit-object-memories.js via
    // POST /object-memories. 'caffeine' (the primary) is always
    // considered available even before the first report.
    let reportedObjectMemories = [];

    let server = null;
    // The tunnel URI for this instance's HTTP server, discovered via
    // the devtunnel CLI. null when no tunnel is active. Other Orbit
    // instances can reach this instance at this URI — access is
    // restricted to members of the configured GitHub org by the
    // Dev Tunnels relay (org-scoped ACL).
    let tunnelUri = null;
    // Per-backend MCP proxy servers (Map<name, {port, server}>),
    // started in startServer(). Each proxy gives a TCP backend its
    // own origin so OAuth discovery is isolated.
    let mcpProxies = null;
    // Reference to the WebDAV FileSystemProvider, set when activate()
    // registers it. Module-scoped so the orbit web server's
    // /fs-changed route (registered in startServer) can call back into
    // it to fire onDidChangeFile events.
    let webdavProvider = null;

    // True if there is currently a VS Code editor tab showing the
    // Orbit page (Simple Browser or Integrated Browser). Matches by
    // tab label, which VS Code populates from the served page's
    // <title> once the page loads. Two needles:
    //   1. The distinctive title phrase
    //      ("agentic pair programming in Smalltalk", see
    //      website/public/orbit.html).
    //   2. The Orbit web server URL
    //      ("http://localhost:<ORBIT_WEB_PORT>"), which is what the
    //      Integrated Browser uses as the tab label before the page
    //      finishes loading — e.g. right after a window reload, when
    //      VS Code restores the tab before the extension brings the
    //      server back up. Without this fallback, activate-time
    //      orbit.stop runs while the tab label is still the URL and
    //      findOrbitTabs returns nothing.
    // True if there is currently a VS Code editor tab showing the
    // Orbit page (Simple Browser or Integrated Browser). Matches by
    // tab label. VS Code truncates the Integrated Browser's label
    // to ~30 characters (e.g. "Orbit: agentic pair programmin…"),
    // and `tab.input` is null on those tabs, so we match against a
    // short, distinctive prefix that fits inside the truncated form.
    // The two needles cover:
    //   1. "Orbit: agentic" — the page's <title> prefix; remains
    //      visible after VS Code's truncation.
    //   2. `http://localhost:<port>` — the URL the Integrated Browser
    //      shows as a fallback label before the page finishes
    //      loading (e.g. immediately after a window reload).
    function findOrbitTabs() {
        const titleNeedle = 'Orbit: agentic';
        const urlNeedle   = `http://localhost:${ORBIT_WEB_PORT}`;
        const found = [];
        try {
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    const label = tab.label || '';
                    if (label.includes(titleNeedle)
                        || label.includes(urlNeedle)) {
                        found.push(tab);
                    }
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
        try {
            await vscode.window.tabGroups.close(tabs, true);
        } catch (e) {
            orbitError('[orbit] closing browser tab failed:', e && e.message);
        }
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

    // workspaceState key: timestamp (ms since epoch) set just before
    // addWebdavWorkspaceFolders() in a single-root workspace. Adding
    // folders to a single-root workspace (no .code-workspace file)
    // transitions VS Code to multi-root mode, which restarts the
    // extension host. This flag tells the subsequent activate() to
    // auto-start Orbit so the user doesn't see it stop and stay
    // stopped. The TTL is generous enough to survive the restart.
    const RUNNING_BEFORE_RELOAD_KEY = 'orbit.runningBeforeReload';
    const RUNNING_BEFORE_RELOAD_TTL_MS = 10 * 1000;

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

    // Servers the user has explicitly stopped via the Orbit view
    // checkbox. While a name is in this set, the auto-reconnect
    // machinery (postState's reconcile-to-true probe and
    // activateReachableBackends' restart loop) leaves it alone, so a
    // manual stop sticks instead of being instantly reverted. Cleared
    // when the user starts the server again (or on orbit.start/stop).
    const mcpUserStopped = new Set();

    // Backends we've permanently given up on for this run: 2300-*
    // servers that never established an MCP connection within one
    // minute of the Orbit extension starting. Once a name is in this
    // set, allBackends() filters it out — so it vanishes from the MCP
    // servers list in the Orbit panel and we stop trying to connect to
    // it (see abandonUnconnected2300Backends). Reset on orbit.start so
    // a manual restart gives those backends a fresh chance.
    const mcpAbandoned = new Set();

    // Backends that have connected at least once this run. Populated by
    // notifyMcpState when a server goes running, and consulted by the
    // abandonment timer so a backend that connected (even if it later
    // dropped) is never abandoned.
    const mcpEverConnected = new Set();

    // Per-server control objects backing the Orbit panel checkboxes.
    // Built lazily and cached by name so that dynamically-discovered
    // bridge servers (extra MCPServer subclasses the page announces)
    // get a checkbox row too — not just the static BACKENDS. Each
    // control's setRunning() asks VS Code to start/stop that specific
    // MCP server and mirrors the user's intent into mcpRunning /
    // mcpUserStopped.
    const mcpServerControlCache = new Map();
    function makeServerControl(name) {
        return {
            name,
            getRunning: () => !!mcpRunning[name],
            setRunning: async (running) => {
                const id = mcpServerIdFor(name);
                if (running) {
                    // User intent: keep this server running. Re-enable the
                    // auto-reconnect machinery for it.
                    mcpUserStopped.delete(name);
                    try {
                        await vscode.commands.executeCommand(
                            'workbench.mcp.startServer',
                            id,
                            { autoTrustChanges: true }
                        );
                    } catch (e) {
                        orbitError(`[orbit] MCP startServer ${name} failed:`, e && e.message);
                        return;
                    }
                    // Confirm via an actual echoMessage/tool round-trip
                    // that VS Code is connected before flipping the UI
                    // flag. workbench.mcp.startServer resolves before any
                    // tools have been negotiated, and vscode.lm.tools can
                    // hold stale entries from a previous session, so we
                    // round-trip a real call. If verification fails,
                    // leave the flag false so the periodic retry tick
                    // re-issues the start.
                    let verified = false;
                    for (let i = 0; i < 24; i++) {
                        if (await isMcpServerConnected(name)) { verified = true; break; }
                        await new Promise(r => setTimeout(r, 250));
                    }
                    mcpRunning[name] = verified;
                    if (!verified) {
                        orbitError(`[orbit] MCP startServer ${name}: resolved but no tools appeared`);
                    }
                } else {
                    try {
                        await vscode.commands.executeCommand(
                            'workbench.mcp.stopServer',
                            id
                        );
                        mcpRunning[name] = false;
                        // User intent: keep this server stopped. Suppress
                        // auto-reconnect until the user starts it again.
                        mcpUserStopped.add(name);
                    } catch (e) {
                        orbitError(`[orbit] MCP stopServer ${name} failed:`, e && e.message);
                    }
                }
            }
        };
    }
    function mcpServerControlFor(name) {
        let c = mcpServerControlCache.get(name);
        if (!c) { c = makeServerControl(name); mcpServerControlCache.set(name, c); }
        return c;
    }
    // Like mcpServerControlFor, but only for a currently-known backend
    // (static or dynamically discovered). Returns null for an unknown
    // name so callers don't conjure controls for servers that no longer
    // exist.
    function mcpServerControlIfKnown(name) {
        return allBackends().some(b => b.name === name)
            ? mcpServerControlFor(name)
            : null;
    }
    // The panel's per-server controls: the static backends plus any
    // dynamically discovered bridge servers, in a stable order.
    function mcpServerControls() {
        return allBackends().map(b => mcpServerControlFor(b.name));
    }

    // Subscribers (page SSE clients + view refresher) listening for
    // MCP server state changes. Each subscriber is a function taking
    // { name, running }.
    const mcpStateSubscribers = new Set();
    function notifyMcpState(name, running) {
        if (running) mcpEverConnected.add(name);
        notifyPageEvent({ name, running });
    }
    // Broadcast an arbitrary payload on the same channel (used for
    // non-server events such as { closeMemory }).
    function notifyPageEvent(payload) {
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

    // ---- Chat bridge -----------------------------------------------------
    // Lets the Orbit webapp open a VS Code Copilot Chat session from
    // inside the Integrated Browser. The page POSTs to /chat against the
    // public Orbit origin; app-impl.js proxies the call to a private
    // loopback server we start here, which dispatches to
    // workbench.action.chat.open. Same port-file convention as the
    // clipboard bridge.
    //
    // Body: { query?: string, mode?: 'panel' | 'sidebar', newSession?: boolean }
    //   query:      initial prompt text (optional)
    //   mode:       'panel' (default) opens the chat panel; 'sidebar' opens
    //               chat in the secondary side bar.
    //   newSession: when true, start a fresh chat session before opening,
    //               so `query` does not append to the in-progress
    //               conversation.
    const CHAT_PORT_FILE = path.join(os.tmpdir(), 'orbit-chat.port');
    let chatServer = null;
    let extensionContext = null;

    // Locate the workspace-scoped chatSessions/ directory. Copilot Chat
    // writes one <sessionId>.jsonl per session there. Returns null if
    // the extension hasn't been activated yet or VS Code didn't give
    // us a workspace storageUri (e.g. no workspace open).
    function chatSessionsDir() {
        if (!extensionContext || !extensionContext.storageUri) return null;
        return path.join(extensionContext.storageUri.fsPath, '..', 'chatSessions');
    }

    function firstRequestText(v) {
        const reqs = v && Array.isArray(v.requests) ? v.requests : [];
        for (const r of reqs) {
            const msg = r && r.message;
            if (msg && typeof msg.text === 'string' && msg.text.trim()) {
                return msg.text.trim();
            }
        }
        return '';
    }

    function summarizeTitle(s, max) {
        if (!s) return '';
        const oneLine = s.replace(/\s+/g, ' ').trim();
        return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
    }

    // Apply a JSON-patch-like "set at path" operation to `state`,
    // creating intermediate objects/arrays as needed. `path` is an
    // array of string/number keys; for missing intermediates we
    // create an array when the next key is a number, otherwise an
    // object. We only walk paths we care about, so this is a small
    // helper, not a general patcher.
    function setAtPath(state, path, value) {
        if (!Array.isArray(path) || path.length === 0) return;
        let cur = state;
        for (let i = 0; i < path.length - 1; i++) {
            const key = path[i];
            const next = path[i + 1];
            if (cur[key] == null || typeof cur[key] !== 'object') {
                cur[key] = (typeof next === 'number') ? [] : {};
            }
            cur = cur[key];
        }
        cur[path[path.length - 1]] = value;
    }

    // Read the JSONL session file, applying patch lines (kind 1/2 with
    // a `k` path and `v` value) to the initial `v` state. VS Code
    // writes the session's `customTitle` and `requests` after the
    // first line in newer versions, so we must scan the whole file to
    // get an accurate header. We only apply patches whose path starts
    // with "customTitle" or "requests" to avoid building unnecessary
    // structure from unrelated patches.
    function readSessionHeader(file) {
        try {
            const stat = fs.statSync(file);
            const text = fs.readFileSync(file, 'utf8');
            const nl = text.indexOf('\n');
            const firstLine = nl < 0 ? text : text.slice(0, nl);
            const obj = JSON.parse(firstLine);
            const v = obj && obj.v;
            if (!v) return null;
            if (nl >= 0) {
                let start = nl + 1;
                while (start < text.length) {
                    let end = text.indexOf('\n', start);
                    if (end < 0) end = text.length;
                    const line = text.slice(start, end);
                    start = end + 1;
                    if (!line) continue;
                    let patch;
                    try { patch = JSON.parse(line); } catch (_) { continue; }
                    if (!patch || !Array.isArray(patch.k) || patch.k.length === 0) continue;
                    const root = patch.k[0];
                    if (root !== 'customTitle' && root !== 'requests') continue;
                    setAtPath(v, patch.k, patch.v);
                }
            }
            const customTitle = (typeof v.customTitle === 'string' ? v.customTitle : '').trim();
            const derivedTitle = customTitle || summarizeTitle(firstRequestText(v), 80);
            return {
                id:           v.sessionId || path.basename(file, '.jsonl'),
                title:        derivedTitle,
                customTitle:  customTitle,
                createdAt:    v.creationDate || null,
                location:     v.initialLocation || null,
                requestCount: Array.isArray(v.requests) ? v.requests.length : 0,
                modifiedAt:   stat.mtimeMs,
                sizeBytes:    stat.size
            };
        } catch (_) {
            return null;
        }
    }

    function listChatSessions() {
        const dir = chatSessionsDir();
        if (!dir || !fs.existsSync(dir)) return [];
        const out = [];
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.jsonl')) continue;
            const desc = readSessionHeader(path.join(dir, name));
            if (desc) out.push(desc);
        }
        out.sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
        return out;
    }

    function readChatSession(id) {
        const dir = chatSessionsDir();
        if (!dir) return null;
        const file = path.join(dir, id + '.jsonl');
        if (!fs.existsSync(file)) return null;
        const text = fs.readFileSync(file, 'utf8');
        return text;
    }

    // Substring search across all session JSONL files. Case-insensitive.
    // Returns up to `limit` matches; each entry is the session header
    // plus a short snippet around the first match in that file.
    function searchChatSessions(query, limit) {
        const q = String(query || '').toLowerCase();
        if (!q) return [];
        const max = Math.max(1, Math.min(parseInt(limit, 10) || 50, 500));
        const dir = chatSessionsDir();
        if (!dir || !fs.existsSync(dir)) return [];
        const out = [];
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.jsonl')) continue;
            const file = path.join(dir, name);
            let text;
            try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
            const lc = text.toLowerCase();
            const idx = lc.indexOf(q);
            if (idx < 0) continue;
            const header = readSessionHeader(file) ||
                { id: path.basename(name, '.jsonl'), title: '', createdAt: null,
                  location: null, requestCount: 0, modifiedAt: 0, sizeBytes: 0 };
            const start = Math.max(0, idx - 120);
            const end = Math.min(text.length, idx + q.length + 120);
            header.snippet = text.slice(start, end);
            out.push(header);
            if (out.length >= max) break;
        }
        out.sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
        return out;
    }

    function startChatBridge() {
        if (chatServer) return;
        const srv = http.createServer((req, res) => {
            const remote = req.socket && req.socket.remoteAddress;
            if (remote && remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
                res.statusCode = 403;
                res.end();
                return;
            }
            const url = req.url || '';
            // GET /chat/sessions          → list
            // GET /chat/sessions/:id      → raw jsonl
            // GET /chat/search?q=…&limit= → search
            if (req.method === 'GET' && url === '/chat/sessions') {
                try {
                    const list = listChatSessions();
                    res.statusCode = 200;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({ ok: true, sessions: list }));
                } catch (err) {
                    res.statusCode = 500;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({ error: String(err && err.message || err) }));
                }
                return;
            }
            const sessMatch = req.method === 'GET' && url.match(/^\/chat\/sessions\/([A-Za-z0-9_\-]+)$/);
            if (sessMatch) {
                const text = readChatSession(sessMatch[1]);
                if (text == null) {
                    res.statusCode = 404;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({ error: 'session not found' }));
                    return;
                }
                res.statusCode = 200;
                res.setHeader('content-type', 'application/x-ndjson');
                res.end(text);
                return;
            }
            if (req.method === 'GET' && url.startsWith('/chat/search')) {
                try {
                    const qs = new URL('http://x' + url).searchParams;
                    const matches = searchChatSessions(qs.get('q'), qs.get('limit'));
                    res.statusCode = 200;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({ ok: true, query: qs.get('q') || '', matches }));
                } catch (err) {
                    res.statusCode = 500;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({ error: String(err && err.message || err) }));
                }
                return;
            }
            if (url !== '/chat') {
                res.statusCode = 404;
                res.end();
                return;
            }
            if (req.method !== 'POST') {
                res.statusCode = 405;
                res.end();
                return;
            }
            let chunks = '';
            req.setEncoding('utf8');
            req.on('data', (c) => { chunks += c; if (chunks.length > 1 * 1024 * 1024) req.destroy(); });
            req.on('end', () => {
                let query = '';
                let mode = 'panel';
                let newSession = false;
                try {
                    const parsed = chunks ? JSON.parse(chunks) : {};
                    if (parsed && typeof parsed.query === 'string') query = parsed.query;
                    if (parsed && typeof parsed.mode === 'string') mode = parsed.mode;
                    if (parsed && parsed.newSession) newSession = true;
                } catch (_) {}
                const command = mode === 'sidebar'
                    ? 'workbench.action.chat.openInSidebar'
                    : 'workbench.action.chat.open';
                const args = query ? { query } : undefined;
                const startNew = newSession
                    ? Promise.resolve(vscode.commands.executeCommand('workbench.action.chat.newChat'))
                          .catch((err) => {
                              orbitError('[orbit] chat bridge: newChat failed:', err && err.message);
                          })
                    : Promise.resolve();
                startNew.then(() => vscode.commands.executeCommand(command, args)).then(() => {
                    res.statusCode = 200;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({ ok: true, command, query, newSession }));
                }, (err) => {
                    orbitError('[orbit] chat bridge: ' + command + ' failed:', err && err.message);
                    res.statusCode = 500;
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({ error: String(err && err.message || err) }));
                });
            });
        });
        srv.on('error', (err) => {
            orbitError('[orbit] chat bridge error:', err && err.message);
        });
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            try {
                fs.writeFileSync(CHAT_PORT_FILE, String(port), { mode: 0o600 });
            } catch (e) {
                orbitError('[orbit] failed to write chat port file:', e && e.message);
            }
            orbitLog('[orbit] chat bridge listening on 127.0.0.1:' + port);
        });
        chatServer = srv;
    }

    function stopChatBridge() {
        if (chatServer) {
            try { chatServer.close(); } catch (_) {}
            chatServer = null;
        }
        try {
            if (fs.existsSync(CHAT_PORT_FILE)) fs.unlinkSync(CHAT_PORT_FILE);
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

    // ---- Evaluate-ledger bridge ------------------------------------------
    // Expose the evaluate-undo ledger to the Orbit page so the
    // <evaluate-ledger> web component can list markers and trigger
    // rollbacks — the in-page equivalent of the editor CodeLenses. Same
    // loopback-server + tmp-port-file + app-impl proxy pattern as the
    // chat and workspace-fs bridges.
    //
    //   GET  /eval/markers       → { ok, markers: [record, …] } (newest first)
    //   POST /eval/undo {id}     → { ok, record } | { ok:false, … }
    //   POST /eval/clear         → { ok, cleared:N } (resets to header-only)
    const EVAL_PORT_FILE = path.join(os.tmpdir(), 'orbit-eval.port');
    let evalBridgeServer = null;

    function startEvalBridge() {
        if (evalBridgeServer) return;
        const srv = http.createServer((req, res) => {
            const remote = req.socket && req.socket.remoteAddress;
            if (remote && remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
                res.statusCode = 403; res.end(); return;
            }
            const url = req.url || '';
            if (req.method === 'GET' && url === '/eval/markers') {
                try {
                    return sendJson(res, 200, { ok: true, markers: listEvaluateMarkers() });
                } catch (err) {
                    return sendJson(res, 500, { error: String(err && err.message || err) });
                }
            }
            if (url === '/eval/undo') {
                if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
                let chunks = '';
                req.setEncoding('utf8');
                req.on('data', (c) => { chunks += c; if (chunks.length > 256 * 1024) req.destroy(); });
                req.on('end', () => {
                    let id = null;
                    try {
                        const parsed = chunks ? JSON.parse(chunks) : {};
                        if (parsed && parsed.id != null) id = String(parsed.id);
                    } catch (_) {}
                    if (!id) { return sendJson(res, 400, { error: 'missing id' }); }
                    Promise.resolve(performEvaluateUndo(id)).then((result) => {
                        const code = result.ok ? 200
                            : result.alreadyUndone ? 409
                            : result.reason === 'not-found' ? 404 : 500;
                        sendJson(res, code, result);
                    }, (err) => {
                        sendJson(res, 500, { error: String(err && err.message || err) });
                    });
                });
                return;
            }
            if (url === '/eval/clear') {
                if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
                Promise.resolve(performEvaluateClear()).then((result) => {
                    sendJson(res, 200, result);
                }, (err) => {
                    sendJson(res, 500, { error: String(err && err.message || err) });
                });
                return;
            }
            res.statusCode = 404; res.end();
        });
        srv.on('error', (err) => {
            orbitError('[orbit] eval bridge error:', err && err.message);
        });
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            try {
                fs.writeFileSync(EVAL_PORT_FILE, String(port), { mode: 0o600 });
            } catch (e) {
                orbitError('[orbit] failed to write eval port file:', e && e.message);
            }
            orbitLog('[orbit] eval bridge listening on 127.0.0.1:' + port);
        });
        evalBridgeServer = srv;
    }

    function stopEvalBridge() {
        if (evalBridgeServer) {
            try { evalBridgeServer.close(); } catch (_) {}
            evalBridgeServer = null;
        }
        try {
            if (fs.existsSync(EVAL_PORT_FILE)) fs.unlinkSync(EVAL_PORT_FILE);
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

    // True when the workspace is single-root (no .code-workspace file).
    // Adding folders via updateWorkspaceFolders in this mode causes
    // VS Code to transition to multi-root, which restarts the
    // extension host.
    function isSingleRootWorkspace() {
        // workspaceFile is undefined in single-folder mode, has a
        // file: URI when a saved .code-workspace is open, or untitled:
        // for an unsaved multi-root workspace.
        return !vscode.workspace.workspaceFile;
    }

    async function addWebdavWorkspaceFolders() {
        // Probe all backends and add a folder per reachable one.
        // Folders for unreachable backends are skipped, and any stale
        // orbit-webdav folder (e.g. left behind by an earlier mount
        // whose backend is no longer reachable, or with an unknown
        // authority) is removed first.
        const reachable = await reachableBackends('webdav');
        const reachableNames = new Set(reachable.map(b => b.name.toLowerCase()));
        orbitLog('[orbit] addWebdavWorkspaceFolders: reachable=' +
            JSON.stringify(Array.from(reachableNames)));

        // Drop stale folders. Iterate from the end so indices stay
        // valid as we remove.
        const existing = findWebdavFolderIndices();
        for (let k = existing.length - 1; k >= 0; k--) {
            const f = existing[k].folder;
            const auth = String(f.uri.authority || '').toLowerCase();
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
            findWebdavFolderIndices().map(e => String(e.folder.uri.authority || '').toLowerCase())
        );
        const toAdd = reachable.filter(b => !present.has(b.name.toLowerCase()));
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
        const bearer = require('./bearer').readBearer(extensionPath);

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
        // Booting the primary memory's page; count it as running until
        // its tether connects (or the grace window elapses).
        startedObjectMemories.set('caffeine', Date.now());
        try {
            await vscode.commands.executeCommand(
                'workbench.action.browser.open',
                { url, reuseUrlFilter: url }
            );
            rememberObjectMemoryTab('caffeine');
            return;
        } catch (e) {
            orbitError('[orbit] workbench.action.browser.open failed; falling back to simpleBrowser.show:',
                e && e.message);
        }
        try {
            await vscode.commands.executeCommand('simpleBrowser.show', url);
            rememberObjectMemoryTab('caffeine');
        } catch (e) {
            orbitError('[orbit] simpleBrowser.show failed:', e && e.message);
        }
    }
    // Object memories the user has started in an Integrated Browser
    // tab, mapped to the time we opened them. Used only as an optimistic
    // "running" hint during the boot window; once a memory's tether
    // connects, liveObjectMemories() (tether presence) is authoritative.
    const startedObjectMemories = new Map();
    const OBJECT_MEMORY_BOOT_GRACE_MS = 25000;

    // The Integrated Browser tab we opened for each object memory. VS
    // Code doesn't expose a browser tab's URL (tab.input is null on
    // those tabs) and every memory's page carries the same title, so
    // remembering the tab object is the only way to close the right
    // one later.
    const objectMemoryTabs = new Map();

    function rememberObjectMemoryTab(memory) {
        try {
            const group = vscode.window.tabGroups.activeTabGroup;
            const tab = group && group.activeTab;
            if (tab) objectMemoryTabs.set(memory, tab);
        } catch (_) {}
    }

    // Close the browser tab hosting `memory`, if we still know it. A
    // page inside the Integrated Browser's cross-origin iframe can't
    // close its own tab, so the extension has to do it.
    async function closeObjectMemoryBrowserTab(memory) {
        const tab = objectMemoryTabs.get(memory);
        objectMemoryTabs.delete(memory);
        if (!tab) return false;
        let stillOpen = false;
        try {
            for (const group of vscode.window.tabGroups.all) {
                if (group.tabs.indexOf(tab) !== -1) { stillOpen = true; break; }
            }
        } catch (_) {}
        if (!stillOpen) return false;
        try {
            await vscode.window.tabGroups.close(tab, true);
            return true;
        } catch (e) {
            orbitError(`[orbit] closing ${memory} browser tab failed:`, e && e.message);
            return false;
        }
    }

    // Names of local object memories currently running, per the
    // CaffeineBridge (a live tether announcing MCP servers), including
    // 'caffeine' (the primary) while its page is open.
    function liveObjectMemories() {
        const bridge = currentApp && currentApp.mcpBridge;
        if (bridge && typeof bridge.liveMemories === 'function') {
            try { return bridge.liveMemories(); } catch (_) {}
        }
        return [];
    }

    // Whether a memory should render as running: it has a live tether,
    // or we opened its tab recently and it's still booting.
    function objectMemoryRunning(name, liveSet) {
        if (liveSet.has(name)) return true;
        const at = startedObjectMemories.get(name);
        return !!at && (Date.now() - at) < OBJECT_MEMORY_BOOT_GRACE_MS;
    }

    // Start a secondary object memory in its own Integrated Browser tab.
    //
    // Opened the usual way, via `workbench.action.browser.open`. The
    // apparent "clobber" of Caffeine in earlier attempts was actually
    // the extension's own tab-dedup closing the primary tab (it matched
    // Orbit tabs by title, not URI); with dedup now keyed strictly on
    // URI, a normal open coexists with the primary. We also tell the
    // bridge to attribute the next new tether to this memory so its
    // running state is reflected.
    async function openObjectMemoryTab(memory) {
        const url = orbitUrlForMemory(ORBIT_WEB_PORT, memory);
        try {
            const bridge = currentApp && currentApp.mcpBridge;
            if (bridge && bridge.labelNextTether) bridge.labelNextTether(memory);
        } catch (_) {}
        startedObjectMemories.set(memory, Date.now());
        try {
            await vscode.commands.executeCommand(
                'workbench.action.browser.open', { url });
        } catch (e) {
            orbitError(`[orbit] open object memory ${memory} failed:`, e && e.message);
            try { await vscode.commands.executeCommand('simpleBrowser.show', url); }
            catch (_) {}
        }
        rememberObjectMemoryTab(memory);
        // Re-evaluate the checkbox once the boot grace elapses, in case
        // the memory never connected a tether.
        setTimeout(() => {
            if (orbitTreeChangeFire) { try { orbitTreeChangeFire(); } catch (_) {} }
        }, OBJECT_MEMORY_BOOT_GRACE_MS + 500);
    }

    // Stop a secondary object memory. The extension can't map a memory
    // to its Integrated Browser tab, so we broadcast a close request the
    // memory page obeys (public/js/orbit-object-memories.js closes its
    // own window). Its tether then drops and it stops being listed.
    async function closeObjectMemoryTab(memory) {
        startedObjectMemories.delete(memory);
        try { notifyPageEvent({ closeMemory: memory }); } catch (_) {}
        try { await closeObjectMemoryBrowserTab(memory); } catch (_) {}
        if (orbitTreeChangeFire) { try { orbitTreeChangeFire(); } catch (_) {} }
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

            // Invalidate require-cache entries under the website tree
            // so livecoding edits to app-impl.js, routes, src/tether.js,
            // src/caffeine-bridge.js, etc. take effect on the next
            // orbit.start without a full window reload (which would
            // restart SqueakJS in the page). We deliberately skip
            // extension-impl.js (we're running inside it) and anything
            // under node_modules.
            try {
                const shimPath = path.join(context.extensionPath, 'app.js');
                const selfPath = path.join('src', 'extension-impl.js');
                let websiteRoot = null;
                const shimEntry = require.cache[shimPath];
                if (shimEntry) {
                    for (const child of shimEntry.children || []) {
                        if (child.id.endsWith(path.sep + 'app-impl.js')) {
                            websiteRoot = path.dirname(child.id);
                            break;
                        }
                    }
                }
                const toDrop = [];
                for (const key of Object.keys(require.cache)) {
                    if (key === shimPath) { toDrop.push(key); continue; }
                    if (!websiteRoot) continue;
                    if (!key.startsWith(websiteRoot + path.sep)) continue;
                    if (key.includes(path.sep + 'node_modules' + path.sep)) continue;
                    if (key.endsWith(selfPath)) continue;
                    toDrop.push(key);
                }
                for (const key of toDrop) delete require.cache[key];
                if (toDrop.length) {
                    orbitLog(`[orbit] startServer: invalidated ${toDrop.length} require-cache entries`);
                }
            } catch (e) {
                orbitError('[orbit] startServer: require-cache invalidation failed:',
                    e && e.message);
            }

            const app = require(path.join(context.extensionPath, 'app'));
            currentApp = app;

            // Expose the reachable backend Snowglobe ports to the page
            // (consumed by GET /orbit/backends.json, dialed by the
            // Caffeine image's Lam2300>>connect). Probing here, on the
            // extension host, mirrors the LAN path the browser uses, so
            // the page only opens Snowglobe/tether WebSockets to
            // backends that are actually up.
            app.orbitSnowglobePorts = async () => {
                try {
                    const reachable = await reachableBackends('webdav');
                    return reachable.map(b => b.webdavPort);
                } catch (_) {
                    return null;
                }
            };

            // Start per-backend MCP reverse-proxy servers so each
            // gets a unique serverInfo.name (and thus a distinct tool
            // prefix in VS Code). Each proxy listens on its own port
            // so OAuth discovery works independently per backend.
            // Awaited in the server.listen callback below so that
            // mcpProxies is populated before startServer resolves —
            // activateReachableBackends needs proxy ports when
            // building MCP definition URLs.
            let startProxiesFn;
            try {
                startProxiesFn = require(
                    path.join(context.extensionPath, 'src', 'mcp-proxy')).startProxies;
            } catch (e) {
                orbitError('[orbit] MCP proxy require failed:', e && e.message);
            }

            // Hook the CaffeineBridge so a fresh page-MCP announce can
            // refire VS Code's MCP definitions (used to expose the
            // Caffeine backend). We install the hook here because
            // the MCP definition provider is registered earlier in
            // activate(), before this require() runs.
            if (app.mcpBridge && mcpDefinitionsChanged) {
                // Route the bridge's logs through the Orbit output
                // channel so we can see incoming HTTP requests.
                app.mcpBridge.log = (...a) => orbitLog('[caffeine-bridge]', ...a);
                app.mcpBridge.error = (...a) => orbitError('[caffeine-bridge]', ...a);
                // Reapply the saved "Caffeine mirroring" checkbox state to the
                // (re)connected page, so the toggle is authoritative across page
                // reloads. Both enable and disable are idempotent in the image;
                // if the page tether isn't ready yet the send rejects harmlessly
                // and a later providers-change retries.
                const applyCaffeineMirrorConfig = () => {
                    const desired = vscode.workspace
                        .getConfiguration('orbit').get('caffeineMirror', false);
                    if (!app.mcpBridge || !app.mcpBridge.setCaffeineMirror) return;
                    app.mcpBridge.setCaffeineMirror(desired).catch((e) => {
                        orbitLog(`[orbit] caffeineMirror apply deferred: ${e && e.message}`);
                    });
                };
                app.mcpBridge.onProvidersChanged = () => {
                    orbitLog('[orbit] CaffeineBridge providers changed; refiring MCP definitions');
                    try { mcpDefinitionsChanged.fire(); } catch (_) {}
                    // Refresh the Orbit panel immediately so a newly
                    // announced bridge server (an extra MCPServer
                    // subclass) gets its checkbox row without waiting
                    // for the async activation pass below to finish.
                    if (orbitTreeChangeFire) {
                        try { orbitTreeChangeFire(); } catch (_) {}
                    }
                    activateReachableBackends().catch((e) => {
                        orbitError('[orbit] activateReachableBackends after bridge change failed:',
                            e && e.message);
                    });
                    // Re-arm the retry loop in case it had stopped
                    // (e.g. the 2300 backends had already settled
                    // as "all up" before Caffeine showed up).
                    scheduleBackendActivationRetries();
                    applyCaffeineMirrorConfig();
                };
                // Record an evaluate-ledger marker for every Caffeine
                // `evaluate` tools/call so it shows up in the Evaluate
                // ledger window, just like the VisualWorks backends'
                // evaluations (those are recorded by the agent; the
                // Caffeine MCP traffic flows through this bridge, so we
                // record it automatically here). We invoke the same
                // orbit.appendEvaluateMarker command the agent uses, so
                // the marker is written without any chat edit tool and
                // no Keep/Undo buttons attach.
                app.mcpBridge.onEvaluateCall = (params) => {
                    const args = (params && params.arguments) || {};
                    const record = {
                        tool: 'evaluate',
                        backend: 'caffeine',
                        source: typeof args.source === 'string' ? args.source : ''
                    };
                    Promise.resolve(
                        vscode.commands.executeCommand(
                            APPEND_EVAL_COMMAND, JSON.stringify(record)))
                        .catch((e) => orbitError(
                            '[orbit] recording Caffeine evaluate marker failed:',
                            e && e.message));
                };
                // Mirror every Keep mutation that flows through the
                // bridge to the on-disk op-log + Markdown projection
                // under .orbit/keep/ (see designs/keep-fs-persistence.md
                // and mirrorKeepMutation above). Best-effort: a
                // filesystem error degrades to "not mirrored", never to
                // a failed MCP call.
                app.mcpBridge.onKeepMutation = (params, result) => {
                    try { mirrorKeepMutation(params, result); }
                    catch (e) { orbitError(
                        '[orbit] Keep mirror failed:', e && e.message); }
                };
            }
            // The Orbit page reports which object memories (*.image
            // files) exist in its IndexedDB here, so the panel's
            // "local object memories" section can list them. Body:
            // { memories: ["caffeine", "ableton", ...] }.
            (app.extensionRoutes || app).post('/object-memories', (req, res) => {
                try {
                    const body = req.body || {};
                    const list = Array.isArray(body.memories) ? body.memories : [];
                    reportedObjectMemories = list
                        .map(n => String(n || '').trim())
                        .filter(Boolean);
                    if (orbitTreeChangeFire) {
                        try { orbitTreeChangeFire(); } catch (_) {}
                    }
                    res.status(200).json({ ok: true, count: reportedObjectMemories.length });
                } catch (e) {
                    orbitError('[orbit] /object-memories failed:', e && e.message);
                    res.status(400).json({ ok: false });
                }
            });
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
                for (const s of mcpServerControls()) {
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

            // Onboarding routing (page -> extension).
            //
            // The on-page onboarding App (and the image, on behalf of the
            // in-conversation App) POSTs the user's choice here so the
            // steering write happens *deterministically in the extension*
            // — the App never edits files itself. Same-origin loopback
            // POST from the shared page on :8089.
            //
            //   POST /onboarding/apply-steering   body { choice }
            //     'augment' -> run orbit.applyOnboardingSteering, clear suppression
            //     'never'   -> remember "don't ask again" for this workspace
            //     'later'   -> noted (will offer again next session)
            //
            //   GET  /onboarding/should-show
            //     -> { show } so the image can gate startup mounting on the
            //        remembered "don't ask again" preference.
            //
            // The "already onboarded" flag is stored in the discoverable
            // VS Code setting `orbit.onboarded` (searchable in Settings so
            // the user can toggle it), not a hidden workspaceState memento.
            (app.extensionRoutes || app).get('/onboarding/should-show', (req, res) => {
                res.setHeader('Content-Type', 'application/json');
                let onboarded = false;
                try { onboarded = !!vscode.workspace.getConfiguration('orbit').get('onboarded', false); }
                catch (_) {}
                const show = !onboarded;
                // When onboarding is about to be shown on the page, reveal the
                // Orbit panel so the App's "its controls live in the Orbit
                // panel" tour points at something visible. Best-effort and
                // non-blocking — never let a reveal failure affect the gate.
                if (show) {
                    Promise.resolve(
                        vscode.commands.executeCommand('orbit.revealPanel')
                    ).catch(() => {});
                }
                res.end(JSON.stringify({ show }));
            });
            (app.extensionRoutes || app).post('/onboarding/apply-steering', async (req, res) => {
                res.setHeader('Content-Type', 'application/json');
                const choice = req.body && req.body.choice;
                try {
                    if (choice === 'augment') {
                        try { await vscode.workspace.getConfiguration('orbit').update('onboarded', true, vscode.ConfigurationTarget.Global); } catch (_) {}
                        const r = await vscode.commands.executeCommand('orbit.applyOnboardingSteering');
                        res.end(JSON.stringify(r || { ok: false, reason: 'no-result' }));
                        return;
                    }
                    if (choice === 'never') {
                        try { await vscode.workspace.getConfiguration('orbit').update('onboarded', true, vscode.ConfigurationTarget.Global); } catch (_) {}
                        res.end(JSON.stringify({ ok: true, action: 'suppressed' }));
                        return;
                    }
                    if (choice === 'later') {
                        res.end(JSON.stringify({ ok: true, action: 'noted' }));
                        return;
                    }
                    res.statusCode = 400;
                    res.end(JSON.stringify({ ok: false, reason: 'bad-choice' }));
                } catch (e) {
                    orbitError('[orbit] /onboarding/apply-steering failed:', e && e.message);
                    res.statusCode = 500;
                    res.end(JSON.stringify({ ok: false, reason: 'error' }));
                }
            });

            // GET /keep-sync/status
            //
            // Peer discovery endpoint. Returns this instance's
            // identity and tunnel information so other Orbit peers
            // can verify reachability and negotiate sync.
            // Access control is handled by the Dev Tunnels relay
            // (org-scoped ACL) — no application-layer auth needed.
            (app.extensionRoutes || app).get('/keep-sync/status', (req, res) => {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                    orbit: true,
                    machineId: vscode.env.machineId,
                    sessionId: vscode.env.sessionId,
                    tunnelUri: tunnelUri || null,
                    hostname: shortHostname,
                    port: ORBIT_WEB_PORT
                }));
            });

            // GET /keep-sync/ops?since=N
            //
            // Returns local Keep ops from the audit trail starting
            // after line index N. Used by remote peers to pull ops
            // directly via the tunnel.
            (app.extensionRoutes || app).get('/keep-sync/ops', (req, res) => {
                const since = parseInt(req.query.since, 10) || 0;
                const ops = keepSync ? keepSync.readLocalOps(since) : [];
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                    ops,
                    total: keepSync ? keepSync.countLocalLines() : 0,
                    hostname: shortHostname
                }));
            });

            // POST /keep-sync/apply
            //
            // Applies a remote Keep op to the local image. Called by
            // the sync module when consuming remote ops from the Gist
            // or from a peer's tunnel. Body is a single op object.
            (app.extensionRoutes || app).post('/keep-sync/apply', async (req, res) => {
                const op = req.body;
                if (!op || !op.op || !op.id) {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ error: 'invalid op' }));
                    return;
                }

                // Deduplicate: check if this op ID already exists in ANY audit file
                const auditDir = path.join(
                    vscode.workspace.workspaceFolders
                        && vscode.workspace.workspaceFolders[0]
                        && vscode.workspace.workspaceFolders[0].uri.fsPath
                        || context.extensionPath,
                    'audit');
                try { fs.mkdirSync(auditDir, { recursive: true }); } catch (_) {}
                const today = new Date().toISOString().slice(0, 10);
                const auditFile = path.join(auditDir, `${today}-keep-ops.jsonl`);
                try {
                    const allAuditFiles = fs.readdirSync(auditDir)
                        .filter(f => f.endsWith('-keep-ops.jsonl'));
                    for (const af of allAuditFiles) {
                        const content = fs.readFileSync(path.join(auditDir, af), 'utf8');
                        if (content.includes(`"id":"${op.id}"`)) {
                            res.setHeader('Content-Type', 'application/json');
                            res.end(JSON.stringify({ applied: false, id: op.id, reason: 'duplicate' }));
                            return;
                        }
                    }
                } catch (_) {}

                // Replay the op into the local Keep store via Caffeine MCP
                try {
                    const bridgeEp = bridgeEndpointFor(backendByName('Caffeine'));
                    if (bridgeEp) {
                        let toolName, toolArgs;
                        if (op.op === 'put') {
                            toolName = 'keepPut';
                            toolArgs = {
                                id: op.id,
                                agent: op.agent || 'sync',
                                content: op.content || '',
                                summary: op.summary || '',
                                tags: op.tags ? JSON.stringify(op.tags) : undefined
                            };
                        } else if (op.op === 'tag') {
                            toolName = 'keepTag';
                            toolArgs = {
                                id: op.id,
                                tags: op.tags ? JSON.stringify(op.tags) : '{}'
                            };
                        } else if (op.op === 'remove') {
                            toolName = 'keepRemove';
                            toolArgs = { id: op.id };
                        }
                        if (toolName) {
                            const rpcBody = JSON.stringify({
                                jsonrpc: '2.0',
                                id: Date.now(),
                                method: 'tools/call',
                                params: { name: toolName, arguments: toolArgs }
                            });
                            await new Promise((resolve, reject) => {
                                const r = require('http').request({
                                    hostname: 'localhost',
                                    port: ORBIT_WEB_PORT,
                                    path: bridgeEp,
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        'Content-Length': Buffer.byteLength(rpcBody)
                                    }
                                }, (resp) => {
                                    let d = '';
                                    resp.on('data', c => { d += c; });
                                    resp.on('end', () => {
                                        if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(d);
                                        else reject(new Error(`bridge ${resp.statusCode}: ${d.slice(0, 200)}`));
                                    });
                                });
                                r.on('error', reject);
                                r.write(rpcBody);
                                r.end();
                            });
                            orbitLog(`[keep-sync] Replayed ${op.op} ${op.id} into local Keep`);
                        }
                    }
                } catch (e) {
                    orbitLog(`[keep-sync] Failed to replay op ${op.id}: ${e.message}`);
                }

                // Write to local audit trail with remote origin marker
                const entry = JSON.stringify({ ...op, synced: true }) + '\n';
                fs.appendFileSync(auditFile, entry);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ applied: true, id: op.id }));
            });

            // POST /keep-sync/exchange-token
            //
            // Token exchange endpoint for peer handshake. The caller
            // sends their machineId and connectToken; we respond with
            // ours. Both sides cache the received token locally.
            (app.extensionRoutes || app).post('/keep-sync/exchange-token', async (req, res) => {
                const { machineId, hostname, connectToken } = req.body || {};
                if (!machineId || !connectToken) {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ error: 'machineId and connectToken required' }));
                    return;
                }
                // Store the peer's token locally
                if (keepSync && keepSync.storePeerToken) {
                    keepSync.storePeerToken(machineId, connectToken);
                    orbitLog(`[keep-sync] Received token from ${hostname || machineId}`);
                }
                // Generate our own token to send back
                let ourToken = null;
                if (keepSync && keepSync.getLocalToken) {
                    ourToken = await keepSync.getLocalToken();
                }
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                    machineId: vscode.env.machineId,
                    hostname: shortHostname,
                    connectToken: ourToken
                }));
            });

            // POST /extension/install-vsix
            //
            // Accepts either:
            //   (a) JSON body { url, token } — fetches the VSIX from
            //       the given tunnel URL using the provided connect token
            //   (b) Binary body (application/octet-stream) — raw VSIX
            // Installs it into the local VS Code instance.
            (app.extensionRoutes || app).post('/extension/install-vsix', (req, res) => {
                const contentType = (req.headers['content-type'] || '').toLowerCase();

                // If Express already parsed the JSON body, handle immediately
                if (contentType.includes('application/json') && req.body && req.body.url) {
                    (async () => {
                        try {
                            const body = req.body;
                            let fetchToken = body.token;
                            if (!fetchToken && keepSync && keepSync.getPeerTokenForUrl) {
                                fetchToken = keepSync.getPeerTokenForUrl(body.url);
                            }
                            orbitLog(`[extension] Fetching VSIX from ${body.url}${fetchToken ? '' : ' (no token)'}`);
                            const vsixBuf = await fetchVsixFromUrl(body.url, fetchToken);
                            await installVsixBuffer(vsixBuf, res);
                        } catch (e) {
                            orbitLog(`[extension] VSIX install failed: ${e.message}`);
                            res.statusCode = 500;
                            res.end(JSON.stringify({ error: e.message }));
                        }
                    })();
                    return;
                }

                // Fallback: read raw body (binary VSIX or unparsed JSON)
                const chunks = [];
                req.on('data', chunk => chunks.push(chunk));
                req.on('end', async () => {
                    try {
                        let vsixBuf;

                        if (contentType.includes('application/json')) {
                            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                            if (!body.url) {
                                res.statusCode = 400;
                                res.end(JSON.stringify({ error: 'url required' }));
                                return;
                            }
                            let fetchToken = body.token;
                            if (!fetchToken && keepSync && keepSync.getPeerTokenForUrl) {
                                fetchToken = keepSync.getPeerTokenForUrl(body.url);
                            }
                            orbitLog(`[extension] Fetching VSIX from ${body.url}${fetchToken ? '' : ' (no token)'}`);
                            vsixBuf = await fetchVsixFromUrl(body.url, fetchToken);
                        } else {
                            vsixBuf = Buffer.concat(chunks);
                        }

                        await installVsixBuffer(vsixBuf, res);
                    } catch (e) {
                        orbitLog(`[extension] VSIX install failed: ${e.message}`);
                        res.statusCode = 500;
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
            });

            // Helper: install a VSIX buffer and respond
            async function installVsixBuffer(vsixBuf, res) {
                if (!vsixBuf || vsixBuf.length < 100) {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ error: 'empty or too small' }));
                    return;
                }

                const tmpDir = require('os').tmpdir();
                const vsixPath = require('path').join(tmpDir, `orbit-pushed-${Date.now()}.vsix`);
                fs.writeFileSync(vsixPath, vsixBuf);
                orbitLog(`[extension] Received VSIX (${(vsixBuf.length / 1024).toFixed(0)} KB), installing from ${vsixPath}`);

                const { execSync } = require('child_process');
                let codeBin = 'code';
                if (process.platform === 'win32') {
                    const winPath = process.env.VSCODE_CWD
                        ? require('path').join(process.env.VSCODE_CWD, 'bin', 'code.cmd')
                        : 'code';
                    codeBin = winPath;
                }

                const publisher = require(require('path').join(__dirname, '..', 'package.json')).publisher.toLowerCase();
                const name = require(require('path').join(__dirname, '..', 'package.json')).name;
                try { execSync(`"${codeBin}" --uninstall-extension ${publisher}.${name}`, { timeout: 30000 }); } catch (_) {}
                execSync(`"${codeBin}" --install-extension "${vsixPath}" --force`, { timeout: 60000 });

                orbitLog(`[extension] VSIX installed successfully. Reload window to activate.`);
                try { fs.unlinkSync(vsixPath); } catch (_) {}

                vscode.window.showInformationMessage(
                    'Orbit extension updated by remote peer. Reload to activate?',
                    'Reload'
                ).then(choice => {
                    if (choice === 'Reload') {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });

                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ installed: true, size: vsixBuf.length }));
            }

            // Helper: fetch a VSIX from a tunnel URL (120s timeout)
            function fetchVsixFromUrl(url, connectToken) {
                const https = require('https');
                const parsed = new URL(url);
                const headers = {};
                if (connectToken) {
                    headers['X-Tunnel-Authorization'] = `tunnel ${connectToken}`;
                }
                return new Promise((resolve, reject) => {
                    const req = https.get({
                        hostname: parsed.hostname,
                        port: 443,
                        path: parsed.pathname + parsed.search,
                        headers,
                        timeout: 120000
                    }, (response) => {
                        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                            // Follow redirect
                            fetchVsixFromUrl(response.headers.location, null).then(resolve).catch(reject);
                            return;
                        }
                        if (response.statusCode !== 200) {
                            reject(new Error(`HTTP ${response.statusCode} fetching VSIX`));
                            return;
                        }
                        const chunks = [];
                        response.on('data', chunk => chunks.push(chunk));
                        response.on('end', () => resolve(Buffer.concat(chunks)));
                        response.on('error', reject);
                    });
                    req.on('timeout', () => { req.destroy(); reject(new Error('VSIX fetch timed out (120s)')); });
                    req.on('error', reject);
                });
            }

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

            // The MCP bridge (see website/src/caffeine-bridge.js) needs to
            // own the WebSocket upgrade for its path; install its
            // upgrade listener now, before any clients connect.
            if (typeof app.attachMcpBridge === 'function') {
                try { app.attachMcpBridge(server); }
                catch (e) { orbitError('[orbit] attachMcpBridge failed:', e && e.message); }
            }
            if (typeof app.attachSnowglobeServer === 'function') {
                try { app.attachSnowglobeServer(server); }
                catch (e) { orbitError('[orbit] attachSnowglobeServer failed:', e && e.message); }
            }

            server.listen(ORBIT_WEB_PORT, async () => {
                const addr = server.address();
                setRunningContext(true);
                vscode.window.showInformationMessage(`Orbit running on port ${addr.port}`);
                if (openBrowser) {
                    showOrbitBrowser(orbitUrl(addr.port));
                }
                // Register the evaluate-marker append command and ensure
                // the ledger file exists (undo itself is driven by the
                // in-webapp Evaluate ledger via the eval bridge).
                try { setupEvalMarkers(context); }
                catch (e) { orbitError('[orbit] setupEvalMarkers failed:', e && e.message); }
                // Start the MCP reverse proxies and wait for them so
                // mcpProxies is set before we resolve — callers
                // (orbit.start, autoStart) immediately run
                // activateReachableBackends which needs proxy ports.
                if (startProxiesFn) {
                    try {
                        const proxies = await startProxiesFn(BACKENDS, {
                            mcpHost,
                            log: (...a) => orbitLog('[mcp-proxy]', ...a),
                            error: (...a) => orbitError('[mcp-proxy]', ...a)
                        });
                        mcpProxies = proxies;
                        orbitLog('[orbit] MCP proxies started: ' +
                            [...proxies.entries()].map(([n, p]) => `${n}→:${p.port}`).join(', '));
                        if (mcpDefinitionsChanged) {
                            try { mcpDefinitionsChanged.fire(); } catch (_) {}
                        }
                    } catch (e) {
                        orbitError('[orbit] MCP proxy start failed:', e && e.message);
                    }
                }
                // Start a dedicated Orbit dev tunnel that forwards
                // port 8089 to localhost. Creates or reuses a tunnel
                // labeled "orbit,<hostname>", applies org ACL, and
                // spawns `devtunnel host` as a child process.
                try {
                    tunnelUri = await startTunnelHost(addr.port);
                    if (tunnelUri) {
                        orbitLog(`[orbit] Tunnel hosting: ${tunnelUri}`);
                    } else {
                        orbitLog('[orbit] No tunnel available; peer sync via Gist only');
                    }
                } catch (e) {
                    tunnelUri = null;
                    orbitLog(`[orbit] Tunnel start failed (non-fatal): ${e && e.message}`);
                }
                // Start Keep sync if configured and enabled
                const syncCfg = vscode.workspace.getConfiguration('orbit.keepSync');
                if (syncCfg.get('enabled', true) && (syncCfg.get('org') || syncCfg.get('gistId'))) {
                    try {
                        const createKeepSync = require(
                            path.join(__dirname, 'keep-sync'));
                        const auditDir = path.join(
                            vscode.workspace.workspaceFolders
                                && vscode.workspace.workspaceFolders[0]
                                && vscode.workspace.workspaceFolders[0].uri.fsPath
                                || context.extensionPath,
                            'audit');
                        keepSync = createKeepSync(vscode, {
                            getPort: () => ORBIT_WEB_PORT,
                            getTunnelUri: () => tunnelUri,
                            getTunnelId: () => activeTunnelId,
                            getHostname: () => shortHostname,
                            getAuditDir: () => auditDir,
                            orbitLog,
                            findDevtunnelCli
                        });
                        await keepSync.start();
                    } catch (e) {
                        orbitLog(`[keep-sync] Start failed: ${e && e.message}`);
                        keepSync = null;
                    }
                }
                resolve();
            });

            server.on('error', (err) => {
                vscode.window.showErrorMessage(`Orbit server error: ${err.message}`);
                server = null;
                tunnelUri = null;
                stopTunnelHost();
                if (keepSync) { keepSync.stop(); keepSync = null; }
                setRunningContext(false);
                resolve();
            });
        });
    }

    // Read the MCP/WebDAV bearer token from env or known files.
    const { readBearer } = require('./bearer');

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
            const backend = backendByName(name);
            // Bridge-kind backends (Caffeine and the object-memory
            // servers): the authoritative "VS Code's MCP client is
            // connected" signal is that it POSTed `initialize` to the
            // endpoint (bridgeVscodeConnected, tracked per-endpoint in
            // the CaffeineBridge). We deliberately do NOT gate on a
            // computed tool prefix here: VS Code derives tool-name
            // prefixes from a lowercased-and-truncated serverInfo.name
            // (e.g. "Caffeine-ableton" → tools "mcp_caffeine-able_…"),
            // which we can't reliably predict — so a prefix check gives
            // false "stopped" readings for de-collided/secondary
            // servers.
            if (backend && backend.kind === 'bridge') {
                return bridgeVscodeConnected(backend);
            }
            // TCP backends: "running" means VS Code has surfaced at
            // least one tool under the expected prefix.
            const tools = (vscode.lm && vscode.lm.tools) || [];
            const prefix = backend && backend.toolPrefix
                ? `mcp_${backend.toolPrefix}_`.toLowerCase()
                : `mcp_${name}_`.toLowerCase();
            for (const t of tools) {
                const n = ((t && t.name) || '').toLowerCase();
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
            // Bridge-kind backends (e.g. Caffeine) don't expose a
            // fixed echoMessage tool; their toolset is whatever the
            // page-hosted MCP server provides. For them, "connected"
            // means VS Code has at least one tool registered under
            // mcp_<name>_ — i.e. the bridge has successfully proxied
            // tools/list to the page and back.
            const backend = backendByName(name);
            if (backend && backend.kind === 'bridge') {
                return isMcpServerActuallyRunning(name);
            }
            // Use the backend's toolPrefix (derived from the server's
            // serverInfo.name) rather than the definition name, since
            // VS Code names tools from serverInfo.name.
            const pfx = backend && backend.toolPrefix
                ? backend.toolPrefix : name;
            const toolName = `mcp_${pfx}_echoMessage`;
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
        // We verify with an actual echoMessage round-trip — not
        // just vscode.lm.tools presence (which retains stale entries
        // after a window reload). If echoMessage succeeds, VS Code
        // genuinely has an active MCP client connection.
        for (const b of allBackends()) {
            if (mcpRunning[b.name]) continue;
            if (mcpUserStopped.has(b.name)) continue;
            if (b.kind === 'bridge') continue;
            const connected = await isMcpServerConnected(b.name);
            if (connected) {
                mcpRunning[b.name] = true;
                notifyMcpState(b.name, true);
                orbitLog(`[orbit] activateReachableBackends: ${b.name} running=true (reconciled via echoMessage)`);
            }
        }
        const probes = await Promise.all(allBackends().map(async (b) => {
            let mcp;
            if (mcpRunning[b.name]) mcp = true;
            else if (b.kind === 'bridge') mcp = !!ownedBridgeEndpointFor(b);
            else mcp = await probeTcp(mcpHost, b.mcpPort, 800);
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
            // VS Code re-queries the MCP definition provider
            // asynchronously after the change event. Give it a beat
            // so workbench.mcp.startServer below can find the
            // newly-registered server id (otherwise the start is a
            // no-op and the server stays "stopped" until the next
            // retry tick).
            await new Promise(r => setTimeout(r, 250));
        }
        for (const { b, mcp } of probes) {
            if (!mcp || mcpRunning[b.name]) continue;
            if (mcpUserStopped.has(b.name)) continue;
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
        return allBackends().every(b => mcpRunning[b.name] || mcpUserStopped.has(b.name));
    }

    // Periodically retry activateReachableBackends so a backend that
    // wasn't ready at activate() (slow Smalltalk image, restarting
    // backend, etc.) still gets its MCP server started and WebDAV
    // folder mounted once it comes up. Backs off to a slow poll once
    // every backend is activated.

    // Open the Keep viewer on the Orbit page via the Caffeine MCP bridge.
    // By default (startup) passes restore:false so an existing collapsed
    // window is refreshed without ever being un-hidden or raised; the
    // panel's explicit "view" action passes { restore: true }.
    async function openKeepViewerOnStartup(opts) {
        const restore = !!(opts && opts.restore);
        const bridgeEp = bridgeEndpointFor(backendByName('Caffeine'));
        if (!bridgeEp) {
            orbitLog('[keep-viewer] Caffeine bridge not available; skipping');
            return;
        }
        const rpcBody = JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: { name: 'openKeepViewer', arguments: { restore } }
        });
        try {
            await new Promise((resolve, reject) => {
                const r = require('http').request({
                    hostname: 'localhost',
                    port: ORBIT_WEB_PORT,
                    path: bridgeEp,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(rpcBody)
                    }
                }, (resp) => {
                    let d = '';
                    resp.on('data', c => { d += c; });
                    resp.on('end', () => {
                        if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(d);
                        else reject(new Error(`bridge ${resp.statusCode}: ${d.slice(0, 200)}`));
                    });
                });
                r.on('error', reject);
                r.write(rpcBody);
                r.end();
            });
            orbitLog('[keep-viewer] Keep viewer opened on startup');
        } catch (e) {
            orbitLog(`[keep-viewer] Failed to open Keep viewer: ${e && e.message}`);
        }
    }

    // Open (or focus) the Lam 2300 digital twin window on the Orbit
    // page by invoking the Caffeine MCP tool `openDigitalTwin`, which
    // mounts a <lam2300-vr> window in the outer orbit.html document
    // (mirroring openKeepViewerOnStartup).
    async function openDigitalTwinOnPage() {
        const bridgeEp = bridgeEndpointFor(backendByName('Caffeine'));
        if (!bridgeEp) {
            orbitLog('[digital-twin] Caffeine bridge not available; skipping');
            return;
        }
        const rpcBody = JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: { name: 'openDigitalTwin', arguments: {} }
        });
        try {
            await new Promise((resolve, reject) => {
                const r = require('http').request({
                    hostname: 'localhost',
                    port: ORBIT_WEB_PORT,
                    path: bridgeEp,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(rpcBody)
                    }
                }, (resp) => {
                    let d = '';
                    resp.on('data', c => { d += c; });
                    resp.on('end', () => {
                        if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(d);
                        else reject(new Error(`bridge ${resp.statusCode}: ${d.slice(0, 200)}`));
                    });
                });
                r.on('error', reject);
                r.write(rpcBody);
                r.end();
            });
            orbitLog('[digital-twin] Digital twin opened');
        } catch (e) {
            orbitLog(`[digital-twin] Failed to open digital twin: ${e && e.message}`);
        }
    }

    // Open (or focus) the evaluate-undo ledger window on the Orbit
    // page by invoking the Caffeine MCP tool `openEvaluations`, which
    // calls the page-side OrbitEvaluateLedger.open() (single-instance,
    // restores a collapsed window) (mirroring openDigitalTwinOnPage).
    async function openEvaluationsOnPage() {
        const bridgeEp = bridgeEndpointFor(backendByName('Caffeine'));
        if (!bridgeEp) {
            orbitLog('[evaluations] Caffeine bridge not available; skipping');
            return;
        }
        const rpcBody = JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: { name: 'openEvaluations', arguments: {} }
        });
        try {
            await new Promise((resolve, reject) => {
                const r = require('http').request({
                    hostname: 'localhost',
                    port: ORBIT_WEB_PORT,
                    path: bridgeEp,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(rpcBody)
                    }
                }, (resp) => {
                    let d = '';
                    resp.on('data', c => { d += c; });
                    resp.on('end', () => {
                        if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(d);
                        else reject(new Error(`bridge ${resp.statusCode}: ${d.slice(0, 200)}`));
                    });
                });
                r.on('error', reject);
                r.write(rpcBody);
                r.end();
            });
            orbitLog('[evaluations] Evaluations ledger opened');
        } catch (e) {
            orbitLog(`[evaluations] Failed to open evaluations ledger: ${e && e.message}`);
        }
    }

    // Open (or focus) the Orbit presentation deck window on the page by
    // invoking the Caffeine MCP tool `openPresentation`, which calls the
    // page-side window.__orbitOpenPresentation() over the Squeak↔JS
    // bridge (single-instance; restores a collapsed window). Mirrors
    // openEvaluationsOnPage / openDigitalTwinOnPage.
    async function startPresentationOnPage() {
        const bridgeEp = bridgeEndpointFor(backendByName('Caffeine'));
        if (!bridgeEp) {
            orbitLog('[presentation] Caffeine bridge not available; skipping');
            return;
        }
        const rpcBody = JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: { name: 'openPresentation', arguments: {} }
        });
        try {
            await new Promise((resolve, reject) => {
                const r = require('http').request({
                    hostname: 'localhost',
                    port: ORBIT_WEB_PORT,
                    path: bridgeEp,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(rpcBody)
                    }
                }, (resp) => {
                    let d = '';
                    resp.on('data', c => { d += c; });
                    resp.on('end', () => {
                        if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(d);
                        else reject(new Error(`bridge ${resp.statusCode}: ${d.slice(0, 200)}`));
                    });
                });
                r.on('error', reject);
                r.write(rpcBody);
                r.end();
            });
            orbitLog('[presentation] Presentation opened');
        } catch (e) {
            orbitLog(`[presentation] Failed to open presentation: ${e && e.message}`);
        }
    }

    // POST a single tools/call to the Caffeine MCP bridge and return
    // the decoded tool result (JSON parsed from the result's text
    // content, or the raw text when it isn't JSON).
    async function callCaffeineTool(name, toolArgs) {
        const bridgeEp = bridgeEndpointFor(backendByName('Caffeine'));
        if (!bridgeEp) throw new Error('Caffeine bridge not available');
        const rpcBody = JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: { name, arguments: toolArgs || {} }
        });
        const raw = await new Promise((resolve, reject) => {
            const r = require('http').request({
                hostname: 'localhost',
                port: ORBIT_WEB_PORT,
                path: bridgeEp,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(rpcBody)
                }
            }, (resp) => {
                let d = '';
                resp.on('data', c => { d += c; });
                resp.on('end', () => {
                    if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(d);
                    else reject(new Error(`bridge ${resp.statusCode}: ${d.slice(0, 200)}`));
                });
            });
            r.on('error', reject);
            r.write(rpcBody);
            r.end();
        });
        try {
            const rpc = JSON.parse(raw);
            const text = rpc && rpc.result && rpc.result.content
                && rpc.result.content[0] && rpc.result.content[0].text;
            if (typeof text !== 'string') return rpc && rpc.result;
            try { return JSON.parse(text); } catch (_) { return text; }
        } catch (_) { return raw; }
    }

    // Replay Keep state from the Caffeine-managed IndexedDB audit log.
    // Called once on startup after the Caffeine MCP bridge is available.
    // The Caffeine image handles its own persistence via the keepReplayAudit
    // tool, which reads ops from the page's IndexedDB and replays them into
    // the in-memory KStore.
    async function replayAuditTrailIntoKeep() {
        try {
            const result = await callCaffeineTool('keepReplayAudit', {});
            orbitLog('[keep-sync] Audit replay complete (Caffeine IndexedDB): '
                + JSON.stringify(result));
        } catch (e) {
            orbitLog(`[keep-sync] Audit replay failed: ${e.message}`);
        }
    }

    // --- Keep mirror lifecycle: replay, reconcile, checkpoint ---------
    //
    // The read side of the .orbit/keep/ mirror (see
    // designs/keep-fs-persistence.md). Disk artifacts:
    //   snapshot.json   full-store checkpoint {at, seq, edgeTags, notes}
    //   ops.jsonl       mutations since the last checkpoint
    //   ops-archive/    rotated pre-checkpoint op logs (history)
    // Expected store state = snapshot notes + ops.jsonl applied in
    // order. At startup (after the IndexedDB audit replay) the expected
    // state is compared against the live KStore and missing/stale notes
    // are re-put, so a git clone alone reconstructs the store.

    function keepReadJsonl(file) {
        let text;
        try { text = fs.readFileSync(file, 'utf8'); }
        catch (_) { return []; }
        const out = [];
        for (const line of text.split('\n')) {
            const t = line.trim();
            if (!t || t[0] !== '{') continue;
            try { out.push(JSON.parse(t)); } catch (_) { /* skip bad line */ }
        }
        return out;
    }

    // Materialize the expected final store state from snapshot.json +
    // ops.jsonl. Uses each op's recorded *result* note (the full body
    // after the mutation), so no Keep semantics are re-implemented.
    // keepArchive results carry no note bodies, so archived tags lag —
    // the same known limitation as the Markdown projection.
    function computeExpectedKeepState() {
        const notes = new Map();
        const snapFile = keepPathFor(KEEP_SNAP_REL);
        let snap = null;
        if (snapFile) {
            try { snap = JSON.parse(fs.readFileSync(snapFile, 'utf8')); }
            catch (_) { snap = null; }
        }
        if (snap && Array.isArray(snap.notes)) {
            for (const n of snap.notes) {
                if (n && n.id != null) notes.set(String(n.id), n);
            }
        }
        const opsFile = keepPathFor(KEEP_OPS_REL);
        for (const rec of (opsFile ? keepReadJsonl(opsFile) : [])) {
            const note = keepNoteFromResult(rec.result);
            switch (rec.tool) {
            case 'keepPut':
            case 'keepTag':
            case 'keepNow':
                if (note && note.id != null) notes.set(String(note.id), note);
                break;
            case 'keepRemove':
                if (rec.id != null) notes.delete(String(rec.id));
                break;
            default:
                break;
            }
        }
        return notes;
    }

    // Compare the expected on-disk state against the live store and
    // repair additively: re-put notes that are missing or whose content
    // differs. Store-only notes are never removed (the disk log may
    // legitimately miss history predating it, or notes restored from an
    // image snapshot); they are only reported. Also refreshes the
    // notes/*.md projection from the expected state.
    async function reconcileKeepMirror() {
        const opsFile = keepPathFor(KEEP_OPS_REL);
        if (!opsFile) return;
        const expected = computeExpectedKeepState();
        if (expected.size === 0) return;
        let actualNotes;
        try {
            const q = await callCaffeineTool('keepQuery',
                { query: '', limit: 1000000 });
            actualNotes = (q && Array.isArray(q.notes)) ? q.notes : [];
        } catch (e) {
            orbitLog(`[keep-mirror] reconcile skipped (query failed): ${e && e.message}`);
            return;
        }
        const actual = new Map();
        for (const n of actualNotes) {
            if (n && n.id != null) actual.set(String(n.id), n);
        }
        const toRestore = [];
        for (const [id, note] of expected) {
            const live = actual.get(id);
            if (!live || (live.content || '') !== (note.content || '')) {
                toRestore.push(note);
            }
        }
        const storeOnly = [...actual.keys()].filter((id) => !expected.has(id));
        // Suppress mirroring while re-issuing ops that are already on
        // disk. (Startup window: a concurrent agent mutation would go
        // unmirrored; accepted.)
        keepMirrorSuppress = true;
        try {
            for (const note of toRestore) {
                const tags = (note.tags && typeof note.tags === 'object')
                    ? note.tags : {};
                await callCaffeineTool('keepPut', {
                    id: String(note.id),
                    agent: note.agent || tags.agent || 'keep-mirror',
                    content: typeof note.content === 'string' ? note.content : '',
                    summary: typeof note.summary === 'string' ? note.summary : '',
                    tags: JSON.stringify(tags)
                });
            }
        } finally {
            keepMirrorSuppress = false;
        }
        try {
            for (const note of expected.values()) keepWriteNoteFile(note);
        } catch (_) { /* projection refresh is best-effort */ }
        orbitLog(`[keep-mirror] reconcile: ${expected.size} on disk, `
            + `${actual.size} in store, restored ${toRestore.length}`
            + (storeOnly.length
                ? `; ${storeOnly.length} store-only left untouched: `
                    + storeOnly.slice(0, 10).join(', ')
                    + (storeOnly.length > 10 ? ', …' : '')
                : ''));
    }

    // Checkpoint: fold the full live store into snapshot.json, rotate
    // ops.jsonl into ops-archive/, regenerate the notes/*.md projection
    // (including orphan removal — the snapshot is the authoritative full
    // state), then clear the IndexedDB crash buffer, which is safe only
    // once the disk checkpoint is durably written. Triggered by the
    // orbit.caffeineSnapshot command and available standalone as
    // orbit.keepCheckpoint.
    async function checkpointKeepMirror() {
        const opsFile  = keepPathFor(KEEP_OPS_REL);
        const snapFile = keepPathFor(KEEP_SNAP_REL);
        if (!opsFile || !snapFile) return { ok: false, reason: 'no local workspace' };
        const q = await callCaffeineTool('keepQuery',
            { query: '', limit: 1000000 });
        const notes = (q && Array.isArray(q.notes)) ? q.notes : null;
        if (!notes) throw new Error('unexpected keepQuery result');
        const seq = ensureKeepSeq(opsFile);
        let edgeTags = {};
        try {
            edgeTags = JSON.parse(
                fs.readFileSync(keepPathFor(KEEP_EDGES_REL), 'utf8')) || {};
        } catch (_) { edgeTags = {}; }
        const snapshot = {
            at: new Date().toISOString(),
            seq,
            noteCount: notes.length,
            edgeTags,
            notes
        };
        fs.mkdirSync(path.dirname(snapFile), { recursive: true });
        const tmp = snapFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 1) + '\n', 'utf8');
        fs.renameSync(tmp, snapFile);
        try {
            if (fs.existsSync(opsFile)) {
                const archiveDir = keepPathFor(KEEP_OPS_ARCHIVE_REL);
                fs.mkdirSync(archiveDir, { recursive: true });
                fs.renameSync(opsFile, path.join(archiveDir,
                    snapshot.at.replace(/[:.]/g, '-') + '-ops.jsonl'));
            }
        } catch (e) {
            orbitLog(`[keep-mirror] checkpoint: op-log rotation failed: ${e && e.message}`);
        }
        try {
            const notesDir = keepPathFor(KEEP_NOTES_REL);
            fs.mkdirSync(notesDir, { recursive: true });
            const want = new Set(notes.map((n) => keepSafeId(n && n.id) + '.md'));
            for (const f of fs.readdirSync(notesDir)) {
                if (f.endsWith('.md') && !want.has(f)) {
                    fs.unlinkSync(path.join(notesDir, f));
                }
            }
            for (const n of notes) keepWriteNoteFile(n);
        } catch (e) {
            orbitLog(`[keep-mirror] checkpoint: projection refresh failed: ${e && e.message}`);
        }
        try {
            await callCaffeineTool('evaluate', {
                source: "JS evaluate: 'window.top.__keepAudit.clear(); return true'"
            });
        } catch (e) {
            orbitLog(`[keep-mirror] checkpoint: __keepAudit.clear failed (non-fatal): ${e && e.message}`);
        }
        orbitLog(`[keep-mirror] checkpoint: ${notes.length} notes folded at seq ${seq}`);
        return { ok: true, notes: notes.length, seq };
    }

    let activateBackendsTimer = null;
    let auditReplayFired = false;

    // --- 2300-* abandonment ------------------------------------------
    //
    // The 2300 backends live in separate VisualWorks images that may
    // not be running at all. If none of them can be reached within one
    // minute of the Orbit extension starting, we give up: remove them
    // from the MCP servers list in the Orbit panel and stop trying to
    // connect. This keeps the panel from perpetually showing three
    // dead 2300 rows (and keeps the retry loop from probing dead ports
    // forever) on machines where the 2300 cluster tool isn't present.
    const ABANDON_2300_MS = 60000;
    let abandon2300Timer = null;
    function is2300Backend(name) {
        return typeof name === 'string' && name.startsWith('2300-');
    }
    function abandonUnconnected2300Backends() {
        abandon2300Timer = null;
        let changed = false;
        for (const b of BACKENDS) {
            if (!is2300Backend(b.name)) continue;
            // Keep any 2300 backend that has connected (or is connected
            // right now) \u2014 the deadline is only about establishing a
            // connection at least once.
            if (mcpRunning[b.name] || mcpEverConnected.has(b.name)) continue;
            if (mcpAbandoned.has(b.name)) continue;
            mcpAbandoned.add(b.name);
            mcpReachable.delete(b.name);
            changed = true;
            orbitLog(`[orbit] abandoning ${b.name}: no MCP connection within ` +
                `${ABANDON_2300_MS / 1000}s of start; removing from panel and halting reconnect`);
        }
        if (!changed) return;
        // Re-query the MCP definition provider (drops the abandoned
        // servers from VS Code's list) and refresh the Orbit panel
        // (drops their checkbox rows). The retry loop will settle on
        // its next tick since allBackends() no longer includes them.
        if (mcpDefinitionsChanged) { try { mcpDefinitionsChanged.fire(); } catch (_) {} }
        if (orbitTreeChangeFire) { try { orbitTreeChangeFire(); } catch (_) {} }
    }
    function armAbandon2300Timer() {
        if (abandon2300Timer) return;
        abandon2300Timer = setTimeout(abandonUnconnected2300Backends, ABANDON_2300_MS);
    }
    function clearAbandon2300Timer() {
        if (abandon2300Timer) { clearTimeout(abandon2300Timer); abandon2300Timer = null; }
    }
    // Un-abandon every 2300 backend and re-arm a fresh one-minute
    // window. Called on orbit.start so a manual restart gives the 2300
    // backends another chance to connect.
    function resetAbandon2300() {
        clearAbandon2300Timer();
        if (mcpAbandoned.size) {
            mcpAbandoned.clear();
            if (mcpDefinitionsChanged) { try { mcpDefinitionsChanged.fire(); } catch (_) {} }
            if (orbitTreeChangeFire) { try { orbitTreeChangeFire(); } catch (_) {} }
        }
        armAbandon2300Timer();
    }

    function scheduleBackendActivationRetries() {
        // Begin the one-minute abandonment countdown when we start
        // trying to connect (extension activation or orbit.start).
        armAbandon2300Timer();
        if (activateBackendsTimer) return;
        let attempt = 0;
        const tick = async () => {
            attempt++;
            let allUp = false;
            try { allUp = await activateReachableBackends(); }
            catch (e) { orbitError('[orbit] activation retry failed:', e && e.message); }
            // Replay audit trail and open Keep viewer as soon as
            // Caffeine is available (don't wait for TCP backends
            // which may never come up).
            if (!auditReplayFired && mcpRunning['Caffeine']) {
                auditReplayFired = true;
                // IndexedDB crash-buffer replay first, then the disk
                // reconcile pass (snapshot.json + ops.jsonl), so a git
                // clone alone reconstructs the store.
                replayAuditTrailIntoKeep()
                    .catch(e =>
                        orbitLog(`[keep-sync] Audit replay failed: ${e && e.message}`))
                    .then(() => reconcileKeepMirror())
                    .catch(e =>
                        orbitLog(`[keep-mirror] reconcile failed: ${e && e.message}`));
                openKeepViewerOnStartup().catch(e =>
                    orbitLog(`[keep-viewer] Startup open failed: ${e && e.message}`));
            }
            if (allUp) {
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

    // Passive watcher: detect MCP servers whose VS Code-side client
    // has dropped (OAuth token expired, backend image restarted,
    // user clicked Stop in the MCP Servers panel, network blip,
    // etc.) and uncheck the corresponding checkbox so the UI stops
    // claiming the server is running.
    //
    // We deliberately do NOT call vscode.lm.invokeTool to verify
    // connectivity: invoking a tool against a server with an expired
    // OAuth token would trigger VS Code's auth re-prompt, breaking
    // the "sticky until user stops" contract documented in
    // activateReachableBackends/postState. Instead we inspect
    // vscode.lm.tools, which is a passive read. As noted in
    // isMcpServerActuallyRunning's caveat, lm.tools can retain
    // stale entries after a disconnect; in that case the checkbox
    // remains checked (a false positive), but we will never flip
    // it to false while the server is still serving tools.
    let mcpDisconnectWatcher = null;
    function startMcpDisconnectWatcher() {
        if (mcpDisconnectWatcher) return;
        mcpDisconnectWatcher = setInterval(async () => {
            try {
                let changed = false;
                for (const b of BACKENDS) {
                    if (!mcpRunning[b.name]) continue;
                    // For TCP backends, combine tool-presence with a
                    // TCP probe. Multiple backends may share the same
                    // serverInfo.name (and tool prefix), so tool
                    // presence alone is ambiguous.
                    if (b.kind !== 'bridge') {
                        const portUp = await probeTcp(mcpHost, b.mcpPort, 800);
                        if (portUp) continue;
                        mcpRunning[b.name] = false;
                        notifyMcpState(b.name, false);
                        changed = true;
                        orbitLog(`[orbit] mcpDisconnectWatcher: ${b.name} port ${b.mcpPort} unreachable; marking not running`);
                        continue;
                    }
                    if (isMcpServerActuallyRunning(b.name)) continue;
                    mcpRunning[b.name] = false;
                    notifyMcpState(b.name, false);
                    changed = true;
                    orbitLog(`[orbit] mcpDisconnectWatcher: ${b.name} tools vanished from vscode.lm.tools; marking not running`);
                }
                if (changed && orbitTreeChangeFire) {
                    try { orbitTreeChangeFire(); } catch (_) {}
                }
            } catch (e) {
                orbitError('[orbit] mcpDisconnectWatcher tick failed:', e && e.message);
            }
        }, 5000);
    }
    function stopMcpDisconnectWatcher() {
        if (mcpDisconnectWatcher) {
            clearInterval(mcpDisconnectWatcher);
            mcpDisconnectWatcher = null;
        }
    }

    function activate(context) {
        const ch = ensureOutputChannel();
        if (ch) context.subscriptions.push(ch);
        extensionContext = context;
        orbitLog('[orbit] activate: extension v' +
            (vscode.extensions.getExtension('BlackPageDigital.orbit-agentic-pair-programming-for-smalltalk')
                && vscode.extensions.getExtension('BlackPageDigital.orbit-agentic-pair-programming-for-smalltalk').packageJSON.version
                || '?') +
            ' workspaceFolders=' +
            JSON.stringify((vscode.workspace.workspaceFolders || []).map(f => f.uri.toString())));
        startClipboardBridge();
        startChatBridge();
        startWorkspaceFsBridge();
        startEvalBridge();
        setRunningContext(false);

        // Register the in-process WebDAV FileSystemProvider under the
        // orbit-webdav:// scheme. This lets us add Smalltalk-served
        // folders to the workspace without any host-OS WebDAV client.
        try {
            const createWebdavFs = require('./webdav-fs');
            const { provider, scheme } = createWebdavFs(vscode, {
                getBaseUrl: (authority) => {
                    const a = String(authority || '').toLowerCase();
                    const b = backendByName(authority)
                        || BACKENDS.find(x => x.name.toLowerCase() === a);
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

        // Register empty FileSearchProvider and TextSearchProvider for
        // the orbit-webdav:// scheme. We do not support searching
        // WebDAV filesystems; without these stubs VS Code would
        // either fall back to walking the FS provider (extremely slow
        // over WebDAV) or surface confusing errors. The providers
        // return no results.
        try {
            const emptyFileSearch = {
                provideFileSearchResults() { return []; }
            };
            const emptyTextSearch = {
                provideTextSearchResults() { return { limitHit: false }; }
            };
            const ws = vscode.workspace;
            const regFns = [
                'registerFileSearchProvider',
                'registerFileSearchProvider2'
            ];
            for (const fn of regFns) {
                if (typeof ws[fn] === 'function') {
                    try {
                        context.subscriptions.push(
                            ws[fn]('orbit-webdav', emptyFileSearch));
                        orbitLog('[orbit] empty ' + fn + ' registered for orbit-webdav://');
                    } catch (e) {
                        orbitError('[orbit] ' + fn + ' failed:', e && e.message);
                    }
                }
            }
            const txtFns = [
                'registerTextSearchProvider',
                'registerTextSearchProvider2'
            ];
            for (const fn of txtFns) {
                if (typeof ws[fn] === 'function') {
                    try {
                        context.subscriptions.push(
                            ws[fn]('orbit-webdav', emptyTextSearch));
                        orbitLog('[orbit] empty ' + fn + ' registered for orbit-webdav://');
                    } catch (e) {
                        orbitError('[orbit] ' + fn + ' failed:', e && e.message);
                    }
                }
            }
        } catch (e) {
            orbitError('[orbit] search provider registration failed:', e && e.message);
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

        // Command: return peer sync info (tunnel URI + identity).
        // Used by the Gist-based peer registry to publish this
        // instance's connection details. No secrets returned —
        // access control is enforced by the tunnel relay (org ACL).
        const peerInfoCmd = vscode.commands.registerCommand(
            'orbit.keepSync.getPeerInfo', () => {
                return {
                    tunnelUri: tunnelUri || null,
                    machineId: vscode.env.machineId,
                    sessionId: vscode.env.sessionId,
                    hostname: shortHostname,
                    port: ORBIT_WEB_PORT
                };
            }
        );
        context.subscriptions.push(peerInfoCmd);

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
            // Ensure the Orbit panel is visible so the user can see the
            // start/stop, preferences and backend controls (and so the
            // onboarding flow can point at it). Best-effort.
            try { await vscode.commands.executeCommand('orbit.revealPanel'); }
            catch (_) {}
            // Re-publish the Orbit MCP definitions (orbit.stop withdrew
            // them) before asking VS Code to start the servers.
            if (!mcpEnabled) {
                mcpEnabled = true;
                if (mcpDefinitionsChanged) mcpDefinitionsChanged.fire();
            }
            // A manual start gives the 2300 backends a fresh one-minute
            // window to connect before they're abandoned again.
            resetAbandon2300();
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
            // Skip in single-root mode: adding folders would transition
            // VS Code to multi-root and restart the extension host.
            if (webdavMountEnabled() && !isSingleRootWorkspace()) {
                try { await addWebdavWorkspaceFolders(); }
                catch (e) {
                    orbitError('[orbit] orbit.start: addWebdavWorkspaceFolders failed:',
                        e && e.message);
                }
            } else if (webdavMountEnabled() && isSingleRootWorkspace()) {
                orbitLog('[orbit] orbit.start: skipping WebDAV mount (single-root workspace; save as workspace file to enable)');
            }
            scheduleBackendActivationRetries();
            startMcpDisconnectWatcher();
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
                tunnelUri = null;
                stopTunnelHost();
                if (keepSync) { keepSync.stop(); keepSync = null; }
                currentApp = null;
                // Stop per-backend MCP proxy servers
                if (mcpProxies) {
                    const { stopProxies } = require(
                        path.join(context.extensionPath, 'src', 'mcp-proxy'));
                    stopProxies(mcpProxies);
                    mcpProxies = null;
                }
                setRunningContext(false);
                stopMcpDisconnectWatcher();
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
            // Close any browser tabs showing the Orbit page.
            // Skipped when invoked from orbit.start with an existing
            // tab to preserve.
            if (!keepTabs) {
                for (const tab of findOrbitTabs()) {
                    const input = tab.input;
                    orbitLog('[orbit.stop] closing tab', JSON.stringify({
                        label: tab.label,
                        viewType: input && input.viewType,
                        editorId: input && (input.id || input.editorId),
                        ctorName: input && input.constructor && input.constructor.name,
                        inputKeys: input ? Object.keys(input) : null,
                    }));
                }
                await closeOrbitTabs();
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
            // A full teardown clears any per-server user-stop intent;
            // the next orbit.start should bring every backend back up.
            mcpUserStopped.clear();
            // Stop the pending abandonment countdown; orbit.start
            // re-arms a fresh one.
            clearAbandon2300Timer();
            if (mcpEnabled) {
                mcpEnabled = false;
                if (mcpDefinitionsChanged) mcpDefinitionsChanged.fire();
            }
        });

        context.subscriptions.push(startCmd, stopCmd);

        // Recycle just the HTTP server (and its WebSocket upgrade
        // handler) so livecoding edits to app-impl.js / routes /
        // src/caffeine-bridge.js / src/tether.js take effect without
        // touching the Orbit browser tab. Unlike orbit.start, this
        // does not close tabs, withdraw MCP definitions, remount
        // WebDAV folders, or restart the SqueakJS image in the page.
        // The page's WebSocket to /orbit-tether will drop and need
        // to be reopened by the page on its own.
        const restartWebserverCmd = vscode.commands.registerCommand(
            'orbit.restartWebserver',
            async () => {
                orbitLog('[orbit] orbit.restartWebserver: invoked');
                if (server) {
                    try { server.close(); } catch (_) {}
                    server = null;
                }
                await startServer(context, /*openBrowser*/ false);
                vscode.window.showInformationMessage('Orbit webserver restarted.');
            });
        context.subscriptions.push(restartWebserverCmd);

        // Command to open steering file from extension details page
        const openSteeringCmd = vscode.commands.registerCommand('orbit.openSteering', () => {
            const steeringPath = vscode.Uri.file(path.join(context.extensionPath, 'agents', 'orbit.agent.md'));
            vscode.commands.executeCommand('vscode.open', steeringPath);
        });
        context.subscriptions.push(openSteeringCmd);

        // Programmatic open/close of a local object memory in its own
        // Integrated Browser tab (same path the panel checkbox uses).
        // Useful for agents/scripts and for verifying the open behavior.
        const openMemoryCmd = vscode.commands.registerCommand(
            'orbit.openObjectMemory', async (memory) => {
                if (memory) await openObjectMemoryTab(String(memory));
            });
        const closeMemoryCmd = vscode.commands.registerCommand(
            'orbit.closeObjectMemory', async (memory) => {
                if (memory) await closeObjectMemoryTab(String(memory));
            });
        context.subscriptions.push(openMemoryCmd, closeMemoryCmd);

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
                // Match ONLY by exact URI. Titles are irrelevant. A tab
                // is closed only if another tab has the identical URI.
                // Tabs whose URI can't be read are never deduped.
                const uriOf = (t) => {
                    try {
                        if (t.input && t.input.uri) return t.input.uri.toString();
                    } catch (_) {}
                    return null;
                };
                try {
                    orbitLog('[orbit] dedup candidates: ' + JSON.stringify(
                        tabs.map(t => ({ label: t.label, uri: uriOf(t) }))));
                } catch (_) {}
                const groups = new Map();
                for (const t of tabs) {
                    const u = uriOf(t);
                    if (!u) continue;
                    if (!groups.has(u)) groups.set(u, []);
                    groups.get(u).push(t);
                }
                const drop = [];
                for (const gtabs of groups.values()) {
                    if (gtabs.length < 2) continue;
                    const keep = gtabs.find(t => t.isActive) || gtabs[gtabs.length - 1];
                    for (const t of gtabs) if (t !== keep) drop.push(t);
                }
                if (!drop.length) return;
                dedupRunning = true;
                try {
                    orbitLog('[orbit] dedup: closing ' + drop.length +
                        ' duplicate Orbit tab(s) by URI');
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
                // For backends not yet marked running, use an
                // actual echoMessage round-trip to confirm VS Code
                // has a live MCP client connection (not stale
                // vscode.lm.tools entries from a previous session).
                const servers = orbitRunning
                    ? (await Promise.all(mcpServerControls().map(async (s) => {
                        if (mcpRunning[s.name]) {
                            mcpEverConnected.add(s.name);
                            return { name: s.name, running: true };
                        }
                        // Respect an explicit user stop: report it as
                        // stopped without probing, so the checkbox
                        // stays unchecked instead of being reverted by
                        // an echoMessage round-trip that still succeeds
                        // moments after stopServer.
                        if (mcpUserStopped.has(s.name)) {
                            return { name: s.name, running: false };
                        }
                        const connected = await isMcpServerConnected(s.name);
                        if (connected) {
                            mcpRunning[s.name] = true;
                            mcpEverConnected.add(s.name);
                        }
                        return { name: s.name, running: connected };
                    })))
                        // Hide servers that have never connected this
                        // run, so the panel list starts empty and each
                        // server only appears once it first connects.
                        // Ones that connected and later dropped (or were
                        // user-stopped) stay visible so they remain
                        // toggleable.
                        .filter(s => s.running || mcpEverConnected.has(s.name))
                    : [];
                if (mySeq !== postStateSeq) return;
                if (!currentWebviewView) return;
                // Build the "local object memories" list: every *.image
                // the page reported in IndexedDB, plus the primary
                // "caffeine". running = has a live tether.
                const live = new Set(liveObjectMemories());
                // Once a memory's tether is live, drop its boot-grace
                // hint so it reverts to "stopped" as soon as that
                // tether goes away.
                for (const name of live) startedObjectMemories.delete(name);
                const memNames = new Set(reportedObjectMemories);
                memNames.add('caffeine');
                const objectMemories = Array.from(memNames).sort().map((name) => ({
                    name,
                    primary: name === 'caffeine',
                    running: objectMemoryRunning(name, live)
                }));
                const payload = {
                    type: 'state',
                    orbitRunning,
                    webdavEnabled: webdavMountEnabled(),
                    singleRoot: isSingleRootWorkspace(),
                    keepSyncEnabled: vscode.workspace.getConfiguration('orbit.keepSync').get('enabled', true),
                    caffeineMirrorEnabled: vscode.workspace.getConfiguration('orbit').get('caffeineMirror', false),
                    servers,
                    objectMemories
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
  .view-btn {
    cursor: pointer;
    min-width: 3em;
    text-align: center;
    padding: 1px 6px;
    border: 1px solid var(--vscode-button-border, transparent);
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-radius: 2px;
    font-family: inherit;
    font-size: 0.9em;
  }
  .view-btn:hover {
    background: var(--vscode-button-hoverBackground);
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
  .note {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    line-height: 1.35;
    margin: 4px 0 0 22px;
  }
</style>
</head>
<body>
  <div class="summary">Orbit pair-programs Smalltalk with you.</div>
  <hr id="hr-toggle-top">
  <button id="orbit-toggle" class="footer-button">Start Orbit</button>
  <hr id="hr-mcp">
  <div id="mcp-section-label" class="section-label">MCP servers</div>
  <div id="servers"></div>
  <hr id="hr-webdav">
  <div id="webdav-section-label" class="section-label">virtual filesystems</div>
  <div id="webdav-row" class="server">
    <input type="checkbox" id="webdav-toggle">
    <label for="webdav-toggle" class="name">mount Smalltalk folders</label>
  </div>
  <div id="webdav-note" class="note" style="display:none">
    Save this folder as a workspace file (<em>File → Save Workspace As…</em>) to enable Smalltalk folder mounting.
  </div>
  <hr id="hr-memory">
  <div id="memory-section-label" class="section-label">agentic memory</div>
  <div id="memory-view-row" class="server">
    <button id="keep-view-btn" class="view-btn">view</button>
    <span class="name">memory graph</span>
  </div>
  <div id="memory-row" class="server">
    <input type="checkbox" id="memory-toggle">
    <label for="memory-toggle" class="name">share memory with other Orbits</label>
  </div>
  <hr id="hr-eval">
  <div id="eval-section-label" class="section-label">evaluations</div>
  <div id="eval-view-row" class="server">
    <button id="eval-open-btn" class="view-btn">open</button>
    <span class="name">evaluate-undo ledger</span>
  </div>
  <hr id="hr-presentation">
  <div id="presentation-section-label" class="section-label">presentation slides</div>
  <div id="presentation-view-row" class="server">
    <button id="presentation-start-btn" class="view-btn">start</button>
    <span class="name">Orbit presentation</span>
  </div>
  <hr id="hr-mirror">
  <div id="mirror-section-label" class="section-label">Caffeine mirroring</div>
  <div id="mirror-row" class="server">
    <input type="checkbox" id="mirror-toggle">
    <label for="mirror-toggle" class="name">mirror Caffeine windows</label>
  </div>
  <hr id="hr-memories">
  <div id="memories-section-label" class="section-label">local object memories</div>
  <div id="memories-list"></div>
  <hr id="hr-twin">
  <div id="twin-section-label" class="section-label">digital twin</div>
  <div id="twin-view-row" class="server">
    <button id="twin-open-btn" class="view-btn">open</button>
    <span class="name">Lam 2300 cluster tool</span>
  </div>
  <hr id="hr-release-notes">
  <div id="release-notes-section-label" class="section-label">release notes</div>
  <div id="release-notes-view-row" class="server">
    <button id="release-notes-view-btn" class="view-btn">view</button>
    <span class="name">changes in this release</span>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const serversEl = document.getElementById('servers');
  const toggleBtn = document.getElementById('orbit-toggle');
  const webdavCb = document.getElementById('webdav-toggle');
  const memoryCb = document.getElementById('memory-toggle');
  const mirrorCb = document.getElementById('mirror-toggle');
  const memoriesEl = document.getElementById('memories-list');

  toggleBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'toggleOrbit' });
  });

  webdavCb.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleWebdav', desired: webdavCb.checked });
  });

  memoryCb.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleKeepSync', desired: memoryCb.checked });
  });

  mirrorCb.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleCaffeineMirror', desired: mirrorCb.checked });
  });

  document.getElementById('keep-view-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'openKeepViewer' });
  });

  document.getElementById('twin-open-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'openDigitalTwin' });
  });

  document.getElementById('eval-open-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'openEvaluations' });
  });

  document.getElementById('presentation-start-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'startPresentation' });
  });

  document.getElementById('release-notes-view-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'viewReleaseNotes' });
  });

  function render(state) {
    toggleBtn.textContent = state.orbitRunning ? 'Stop Orbit' : 'Start Orbit';
    const hasServers = state.orbitRunning && state.servers && state.servers.length > 0;
    document.getElementById('hr-mcp').style.display = hasServers ? '' : 'none';
    document.getElementById('mcp-section-label').style.display = hasServers ? '' : 'none';
    webdavCb.checked = !!state.webdavEnabled && !state.singleRoot;
    webdavCb.disabled = !!state.singleRoot;
    const showWebdav = !!state.orbitRunning;
    document.getElementById('hr-webdav').style.display = showWebdav ? '' : 'none';
    document.getElementById('webdav-section-label').style.display = showWebdav ? '' : 'none';
    document.getElementById('webdav-row').style.display = showWebdav ? '' : 'none';
    const noteEl = document.getElementById('webdav-note');
    noteEl.style.display = (showWebdav && state.singleRoot) ? '' : 'none';
    const showMemory = !!state.orbitRunning;
    document.getElementById('hr-memory').style.display = showMemory ? '' : 'none';
    document.getElementById('memory-section-label').style.display = showMemory ? '' : 'none';
    document.getElementById('memory-row').style.display = showMemory ? '' : 'none';
    document.getElementById('memory-view-row').style.display = showMemory ? '' : 'none';
    memoryCb.checked = !!state.keepSyncEnabled;
    const showEval = !!state.orbitRunning;
    document.getElementById('hr-eval').style.display = showEval ? '' : 'none';
    document.getElementById('eval-section-label').style.display = showEval ? '' : 'none';
    document.getElementById('eval-view-row').style.display = showEval ? '' : 'none';
    const showPresentation = !!state.orbitRunning;
    document.getElementById('hr-presentation').style.display = showPresentation ? '' : 'none';
    document.getElementById('presentation-section-label').style.display = showPresentation ? '' : 'none';
    document.getElementById('presentation-view-row').style.display = showPresentation ? '' : 'none';
    const showMirror = !!state.orbitRunning;
    document.getElementById('hr-mirror').style.display = showMirror ? '' : 'none';
    document.getElementById('mirror-section-label').style.display = showMirror ? '' : 'none';
    document.getElementById('mirror-row').style.display = showMirror ? '' : 'none';
    mirrorCb.checked = !!state.caffeineMirrorEnabled;
    // Local object memories section.
    const memories = state.objectMemories || [];
    const showMemories = !!state.orbitRunning && memories.length > 0;
    document.getElementById('hr-memories').style.display = showMemories ? '' : 'none';
    document.getElementById('memories-section-label').style.display = showMemories ? '' : 'none';
    memoriesEl.style.display = showMemories ? '' : 'none';
    memoriesEl.innerHTML = '';
    for (const m of memories) {
      const row = document.createElement('div');
      row.className = 'server';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!m.running;
      cb.id = 'mem-' + m.name;
      cb.addEventListener('change', () => {
        vscode.postMessage({
          type: 'toggleObjectMemory',
          name: m.name,
          desired: cb.checked
        });
      });
      const label = document.createElement('label');
      label.className = 'name';
      label.htmlFor = cb.id;
      label.textContent = m.name;
      const status = document.createElement('span');
      status.className = 'status';
      status.textContent = m.running ? 'running' : 'stopped';
      row.appendChild(cb);
      row.appendChild(label);
      row.appendChild(status);
      memoriesEl.appendChild(row);
    }
    // Digital twin section hidden until release.
    const showTwin = false;
    document.getElementById('hr-twin').style.display = showTwin ? '' : 'none';
    document.getElementById('twin-section-label').style.display = showTwin ? '' : 'none';
    document.getElementById('twin-view-row').style.display = showTwin ? '' : 'none';
    const showReleaseNotes = !!state.orbitRunning;
    document.getElementById('hr-release-notes').style.display = showReleaseNotes ? '' : 'none';
    document.getElementById('release-notes-section-label').style.display = showReleaseNotes ? '' : 'none';
    document.getElementById('release-notes-view-row').style.display = showReleaseNotes ? '' : 'none';
    document.getElementById('hr-toggle-top').style.display = state.orbitRunning ? '' : 'none';
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
                    const nonce = require('crypto')
                        .randomBytes(16).toString('base64');
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
                            const srv = mcpServerControlIfKnown(msg.name);
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
                                if (desired && !isSingleRootWorkspace()) {
                                    await addWebdavWorkspaceFolders();
                                } else if (!desired) {
                                    removeWebdavWorkspaceFolders();
                                }
                            } catch (e) {
                                orbitError('[orbit] toggleWebdav apply failed:', e && e.message);
                            }
                            postState();
                            return;
                        }
                        if (msg.type === 'toggleKeepSync') {
                            const desired = !!msg.desired;
                            try {
                                await vscode.workspace
                                    .getConfiguration('orbit')
                                    .update(
                                        'keepSync.enabled',
                                        desired,
                                        vscode.ConfigurationTarget.Global
                                    );
                            } catch (e) {
                                orbitError('[orbit] keepSync.enabled update failed:', e && e.message);
                                postState();
                                return;
                            }
                            try {
                                if (desired && !keepSync) {
                                    const syncCfg = vscode.workspace.getConfiguration('orbit.keepSync');
                                    if (syncCfg.get('org') || syncCfg.get('gistId')) {
                                        const createKeepSync = require(
                                            path.join(__dirname, 'keep-sync'));
                                        const auditDir = path.join(
                                            vscode.workspace.workspaceFolders
                                                && vscode.workspace.workspaceFolders[0]
                                                && vscode.workspace.workspaceFolders[0].uri.fsPath
                                                || context.extensionPath,
                                            'audit');
                                        keepSync = createKeepSync(vscode, {
                                            getPort: () => ORBIT_WEB_PORT,
                                            getTunnelUri: () => tunnelUri,
                                            getTunnelId: () => activeTunnelId,
                                            getHostname: () => shortHostname,
                                            getAuditDir: () => auditDir,
                                            orbitLog,
                                            findDevtunnelCli
                                        });
                                        await keepSync.start();
                                    }
                                } else if (!desired && keepSync) {
                                    keepSync.stop();
                                    keepSync = null;
                                }
                            } catch (e) {
                                orbitError('[orbit] toggleKeepSync apply failed:', e && e.message);
                                keepSync = null;
                            }
                            postState();
                            return;
                        }
                        if (msg.type === 'toggleCaffeineMirror') {
                            const desired = !!msg.desired;
                            try {
                                await vscode.workspace
                                    .getConfiguration('orbit')
                                    .update(
                                        'caffeineMirror',
                                        desired,
                                        vscode.ConfigurationTarget.Global
                                    );
                            } catch (e) {
                                orbitError('[orbit] caffeineMirror update failed:', e && e.message);
                                postState();
                                return;
                            }
                            try {
                                const bridge = currentApp && currentApp.mcpBridge;
                                if (bridge && bridge.setCaffeineMirror) {
                                    await bridge.setCaffeineMirror(desired);
                                } else {
                                    orbitLog('[orbit] no Caffeine bridge; mirror toggle recorded, will apply on next connect');
                                }
                            } catch (e) {
                                orbitError('[orbit] setCaffeineMirror apply failed:', e && e.message);
                            }
                            postState();
                            return;
                        }
                        if (msg.type === 'toggleObjectMemory') {
                            const name = String(msg.name || '').trim();
                            const desired = !!msg.desired;
                            if (!name) { postState(); return; }
                            try {
                                if (name === 'caffeine') {
                                    if (desired) await showOrbitBrowser(orbitUrl(ORBIT_WEB_PORT));
                                    else await closeObjectMemoryTab(name);
                                } else if (desired) {
                                    await openObjectMemoryTab(name);
                                } else {
                                    await closeObjectMemoryTab(name);
                                }
                            } catch (e) {
                                orbitError('[orbit] toggleObjectMemory failed:', e && e.message);
                            }
                            postState();
                            return;
                        }
                        if (msg.type === 'openKeepViewer') {
                            openKeepViewerOnStartup({ restore: true }).catch(e =>
                                orbitLog(`[keep-viewer] Panel open failed: ${e && e.message}`));
                            return;
                        }
                        if (msg.type === 'openDigitalTwin') {
                            openDigitalTwinOnPage().catch(e =>
                                orbitLog(`[digital-twin] Panel open failed: ${e && e.message}`));
                            return;
                        }
                        if (msg.type === 'openEvaluations') {
                            openEvaluationsOnPage().catch(e =>
                                orbitLog(`[evaluations] Panel open failed: ${e && e.message}`));
                            return;
                        }
                        if (msg.type === 'startPresentation') {
                            startPresentationOnPage().catch(e =>
                                orbitLog(`[presentation] Panel open failed: ${e && e.message}`));
                            return;
                        }
                        if (msg.type === 'viewReleaseNotes') {
                            try {
                                const notesUri = vscode.Uri.file(path.join(
                                    context.extensionPath, 'RELEASE-NOTES.md'));
                                await vscode.commands.executeCommand(
                                    'markdown.showPreview', notesUri);
                            } catch (e) {
                                orbitError('[orbit] viewReleaseNotes failed:', e && e.message);
                            }
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
                if (e.affectsConfiguration('orbit.mountWebdav') || e.affectsConfiguration('orbit.keepSync.enabled') || e.affectsConfiguration('orbit.caffeineMirror')) postState();
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

        // Reveal the Orbit panel on demand. VS Code auto-registers
        // `<viewId>.focus` for every contributed view, which reveals the
        // view's container and the view itself. The onboarding flow (and
        // orbit.start) use this to guarantee the panel is visible while
        // it teaches about the controls there.
        try {
            const revealPanelCmd = vscode.commands.registerCommand('orbit.revealPanel', async () => {
                try { await vscode.commands.executeCommand('orbit.status.focus'); }
                catch (e) { orbitError('[orbit] orbit.revealPanel failed:', e && e.message); }
            });
            context.subscriptions.push(revealPanelCmd);
        } catch (e) {
            orbitError('[orbit] orbit.revealPanel registration failed:', e && e.message);
        }

        // Onboarding: merge Orbit's bundled steering into the workspace's
        // .github/copilot-instructions.md so the *default* Copilot agent
        // follows it. This is the deterministic write the onboarding App's
        // "augment" choice routes to (and the chat fallback reuses), so the
        // App itself never edits files. Idempotent via marker comments;
        // the whole inserted block is safe to delete to undo.
        const ORBIT_STEERING_BEGIN = '<!-- ORBIT:STEERING:BEGIN -->';
        const ORBIT_STEERING_END = '<!-- ORBIT:STEERING:END -->';
        const applySteeringCmd = vscode.commands.registerCommand('orbit.applyOnboardingSteering', async () => {
            try {
                const folders = vscode.workspace.workspaceFolders;
                if (!folders || folders.length === 0) {
                    vscode.window.showWarningMessage('Orbit: open a folder before adding steering.');
                    return { ok: false, reason: 'no-workspace' };
                }
                const folder = folders[0];
                const srcPath = path.join(context.extensionPath, 'agents', 'orbit.agent.md');
                let steering;
                try { steering = fs.readFileSync(srcPath, 'utf8'); }
                catch (e) {
                    orbitError('[orbit] applyOnboardingSteering: steering source missing:', e && e.message);
                    return { ok: false, reason: 'no-steering-source' };
                }

                const block = ORBIT_STEERING_BEGIN + '\n'
                    + '<!-- Added by Orbit. Safe to remove this whole block to undo. -->\n\n'
                    + steering.trim() + '\n\n' + ORBIT_STEERING_END;

                const targetUri = vscode.Uri.joinPath(folder.uri, '.github', 'copilot-instructions.md');
                let existing = '';
                let existed = false;
                try {
                    const buf = await vscode.workspace.fs.readFile(targetUri);
                    existing = Buffer.from(buf).toString('utf8');
                    existed = true;
                } catch (_) { existed = false; }

                let next, action;
                const bi = existing.indexOf(ORBIT_STEERING_BEGIN);
                const ei = existing.indexOf(ORBIT_STEERING_END);
                if (bi !== -1 && ei !== -1 && ei > bi) {
                    const replaced = existing.slice(0, bi) + block
                        + existing.slice(ei + ORBIT_STEERING_END.length);
                    if (replaced === existing) { action = 'unchanged'; next = existing; }
                    else { action = 'updated'; next = replaced; }
                } else if (existed) {
                    const sep = existing.length === 0 ? '' : (existing.endsWith('\n') ? '\n' : '\n\n');
                    next = existing + sep + block + '\n';
                    action = 'appended';
                } else {
                    next = block + '\n';
                    action = 'created';
                }

                if (action !== 'unchanged') {
                    try { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.github')); }
                    catch (_) {}
                    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(next, 'utf8'));
                }
                orbitLog('[orbit] applyOnboardingSteering: ' + action + ' ' + targetUri.fsPath);
                return { ok: true, action, path: targetUri.fsPath };
            } catch (e) {
                orbitError('[orbit] applyOnboardingSteering failed:', e && e.message);
                return { ok: false, reason: 'error' };
            }
        });
        context.subscriptions.push(applySteeringCmd);

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
        const PER_SERVER_PARTICIPANTS = [];
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
                const srv = mcpServerControlIfKnown(spec.serverName);
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
            const ext = context.extension
                || vscode.extensions.getExtension(
                    'BlackPageDigital.orbit-agentic-pair-programming-for-smalltalk');
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
                    return reachable.map(b => {
                        // TCP backends must go through their proxy so
                        // serverInfo.name gets rewritten (distinct tool
                        // prefix). Skip them until proxies are ready —
                        // we'll re-fire mcpDefinitionsChanged once
                        // startProxies completes.
                        if (b.kind === 'tcp' && !(mcpProxies && mcpProxies.has(b.name))) {
                            return null;
                        }
                        const url = mcpUrlFor(b);
                        if (!url) return null;
                        orbitLog(`[orbit] MCP def for ${b.name}: url=${url}`);
                        return new vscode.McpHttpServerDefinition(
                            b.name,
                            vscode.Uri.parse(url)
                        );
                    }).filter(Boolean);
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
            mcpUserStopped.clear();
            const wantAutoStart = (() => {
                try {
                    const cfg = vscode.workspace.getConfiguration('orbit').inspect('autoStart');
                    const explicit = cfg && (
                        cfg.workspaceFolderValue !== undefined ? cfg.workspaceFolderValue :
                        cfg.workspaceValue       !== undefined ? cfg.workspaceValue :
                        cfg.globalValue          !== undefined ? cfg.globalValue :
                        undefined);
                    const effective = (explicit !== undefined) ? !!explicit : isDeveloperInstall(context);
                    if (!effective) {
                        // Even if the normal autoStart check fails, honour
                        // the "was running before reload" flag (set when
                        // orbit.start added WebDAV folders to a single-root
                        // workspace, triggering an extension host restart).
                        const ts = +context.workspaceState.get(RUNNING_BEFORE_RELOAD_KEY, 0) || 0;
                        if (ts > 0 && (Date.now() - ts) < RUNNING_BEFORE_RELOAD_TTL_MS) {
                            return true;
                        }
                        return false;
                    }
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
                startMcpDisconnectWatcher();
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
        // with no Smalltalk filesystems mounted — UNLESS the reload
        // was triggered by the single-root → multi-root transition
        // that orbit.start itself initiated (in which case the
        // folders should stay).
        const reloadFlagFresh = (() => {
            try {
                const ts = +context.workspaceState.get(RUNNING_BEFORE_RELOAD_KEY, 0) || 0;
                return ts > 0 && (Date.now() - ts) < RUNNING_BEFORE_RELOAD_TTL_MS;
            } catch (_) { return false; }
        })();
        if (reloadFlagFresh) {
            orbitLog('[orbit] webdav folder cleanup skipped (workspace-transition reload in progress)');
        } else {
            try {
                removeWebdavWorkspaceFolders();
            } catch (e) {
                orbitError('[orbit] webdav folder cleanup on activate failed:',
                    e && e.message);
            }
        }

        // Auto-start the web server at activation time so that browser
        // tabs left open at the Orbit URL across VS Code restarts can
        // reconnect without the user having to invoke `orbit.start`.
        //
        // Controlled by the `orbit.autoStart` setting. The default
        // depends on whether this looks like a developer machine: on
        // a dev install (where ./scripts/install-extension.sh
        // has replaced files inside the installed extension with
        // symlinks back to the workspace source) we default to true,
        // so livecoding sessions start automatically. On a normal
        // user install the default is false.
        try {
            const autoStartCfg = vscode.workspace
                .getConfiguration('orbit')
                .inspect('autoStart');
            const explicit = autoStartCfg && (
                autoStartCfg.workspaceFolderValue !== undefined ? autoStartCfg.workspaceFolderValue :
                autoStartCfg.workspaceValue       !== undefined ? autoStartCfg.workspaceValue :
                autoStartCfg.globalValue          !== undefined ? autoStartCfg.globalValue :
                undefined);
            const developerMachine = isDeveloperInstall(context);
            const autoStart = (explicit !== undefined) ? !!explicit : developerMachine;
            if (explicit === undefined && developerMachine) {
                orbitLog('[orbit] auto-start defaulting to true (developer install detected)');
            }
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
            // Detect restart caused by single-root → multi-root
            // transition (addWebdavWorkspaceFolders in orbit.start set
            // the flag just before the extension host was restarted).
            const wasRunningBeforeReload = (() => {
                try {
                    const ts = +context.workspaceState.get(RUNNING_BEFORE_RELOAD_KEY, 0) || 0;
                    if (ts > 0 && (Date.now() - ts) < RUNNING_BEFORE_RELOAD_TTL_MS) {
                        context.workspaceState.update(RUNNING_BEFORE_RELOAD_KEY, 0);
                        return true;
                    }
                } catch (_) {}
                return false;
            })();
            if (wasRunningBeforeReload) {
                orbitLog('[orbit] auto-start: Orbit was running before workspace-transition reload; restarting');
            }
            if ((autoStart || wasRunningBeforeReload) && !explicitlyStopped) {
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
        stopChatBridge();
        stopWorkspaceFsBridge();
        stopEvalBridge();
        stopBackendActivationRetries();
        stopMcpDisconnectWatcher();
        stopTunnelHost();
        if (keepSync) { keepSync.stop(); keepSync = null; }
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
