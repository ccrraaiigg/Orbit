// orbit-chat.js
//
// Exposes `window.orbitChat(query, mode, newSession)` which opens a VS
// Code Copilot Chat session by POSTing to the Orbit extension's /chat
// bridge. Callable from SqueakJS (and other in-page code) via the
// JavaScript bridge, e.g.:
//
//     JS window orbitChat: 'What does Morph>>drawOn: do?'
//     JS window orbitChat: 'Summarize this class' with: 'sidebar'
//     "fresh session instead of appending to the open conversation"
//     JS window orbitChat: 'New topic' with: 'panel' with: true
//
// Parameters:
//   query      — initial prompt text (string, optional)
//   mode       — 'panel' (default) or 'sidebar'
//   newSession — truthy ⇒ start a fresh chat session before opening,
//                so `query` doesn't append to the in-progress
//                conversation.
//
// Body shape and semantics are documented alongside the endpoint in
// website/src/extension-impl.js (startChatBridge) and the proxy in
// website/app-impl.js.

(function () {
  'use strict';

  function orbitChat(query, mode, newSession) {
    var body = {
      query:      typeof query === 'string' ? query : '',
      mode:       typeof mode  === 'string' ? mode  : 'panel',
      newSession: !!newSession
    };
    var headers = { 'content-type': 'application/json' };
    if (typeof window.__ORBIT_BRIDGE_BEARER__ === 'string') {
      headers.authorization = 'Bearer ' + window.__ORBIT_BRIDGE_BEARER__;
    }
    return fetch('/chat', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) {
          throw new Error('orbitChat failed: ' + res.status + ' ' + text);
        }
        try { return JSON.parse(text); } catch (_) { return { ok: true, raw: text }; }
      });
    });
  }

  window.orbitChat = orbitChat;

  // Convenience: always start a fresh chat session.
  //   JS window orbitStartChat: 'New topic'
  //   JS window orbitStartChat: 'Summarize' with: 'sidebar'
  window.orbitStartChat = function (query, mode) {
    return orbitChat(query, mode, true);
  };

  // ---- session enumeration / search ----------------------------------
  // All of these resolve to plain objects parsed from the bridge's
  // JSON responses. They reflect on-disk Copilot Chat session files for
  // the current workspace (`workspaceStorage/<hash>/chatSessions/`), so
  // the data is workspace-scoped and read-only.

  function authHeaders() {
    var h = {};
    if (typeof window.__ORBIT_BRIDGE_BEARER__ === 'string') {
      h.authorization = 'Bearer ' + window.__ORBIT_BRIDGE_BEARER__;
    }
    return h;
  }

  function fetchJson(url) {
    return fetch(url, { headers: authHeaders() }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) {
          throw new Error('orbit-chat ' + url + ' failed: ' + res.status + ' ' + text);
        }
        try { return JSON.parse(text); } catch (_) { return { raw: text }; }
      });
    });
  }

  // List all chat sessions for the current workspace.
  // Resolves to { ok, sessions: [{ id, title, createdAt, location,
  //                                requestCount, modifiedAt, sizeBytes }, …] }.
  window.orbitChatSessions = function () {
    return fetchJson('/chat/sessions');
  };

  // Substring-search session contents (case-insensitive). Returns
  // { ok, query, matches: [<session-header with .snippet>, …] }.
  // `limit` caps results (default 50, max 500).
  window.orbitChatSearch = function (query, limit) {
    var qs = new URLSearchParams();
    qs.set('q', String(query == null ? '' : query));
    if (limit != null) qs.set('limit', String(limit));
    return fetchJson('/chat/search?' + qs.toString());
  };

  // Fetch the raw JSONL of one session by id. Resolves to a string
  // (one JSON object per line; the first line is the session header).
  window.orbitChatSession = function (id) {
    var url = '/chat/sessions/' + encodeURIComponent(String(id || ''));
    return fetch(url, { headers: authHeaders() }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) throw new Error('orbitChatSession failed: ' + res.status + ' ' + text);
        return text;
      });
    });
  };
})();
