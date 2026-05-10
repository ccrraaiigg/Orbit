// Page-side helper for the Orbit workspace-fs HTTP bridge. Exposes
// window.orbitWorkspaceFs, which proxies to vscode.workspace.fs via
// the bridge started by the Orbit extension. See
// designs/workspace-fs-bridge.md for endpoint documentation.
(function () {
  const BASE = '/workspace-fs';

  async function call(path, params, { binary = false } = {}) {
    const url = new URL(BASE + path, window.location.origin);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url.toString());
    if (binary) {
      if (!res.ok) {
        // Bridge sends JSON for errors even on the binary endpoint.
        let detail = {};
        try { detail = await res.json(); } catch (_) {}
        throw makeError(res.status, detail);
      }
      return new Uint8Array(await res.arrayBuffer());
    }
    let body;
    try { body = await res.json(); } catch (_) { body = {}; }
    if (!res.ok) throw makeError(res.status, body);
    return body;
  }

  function makeError(status, body) {
    const err = new Error(body.error || ('HTTP ' + status));
    err.status = status;
    if (body.code) err.code = body.code;
    if (body.name) err.serverName = body.name;
    return err;
  }

  const td = new TextDecoder('utf-8');

  window.orbitWorkspaceFs = {
    /** List workspace folders visible to VS Code. */
    folders() { return call('/folders'); },

    /** vscode.workspace.fs.stat */
    stat(uri) { return call('/stat', { uri }); },

    /** vscode.workspace.fs.readDirectory */
    readDirectory(uri) { return call('/readDirectory', { uri }); },

    /** Raw bytes (Uint8Array). */
    readFile(uri) { return call('/read', { uri }, { binary: true }); },

    /** Convenience: decode bytes as UTF-8 text. */
    async readText(uri) {
      const bytes = await this.readFile(uri);
      return td.decode(bytes);
    },

    /** True iff the bridge is currently reachable. */
    async isAvailable() {
      try { await this.folders(); return true; }
      catch (_) { return false; }
    }
  };
})();
