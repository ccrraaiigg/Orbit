// Reports the local object memories (*.image files) present in the
// page's SqueakJS IndexedDB to the Orbit extension, so the Orbit
// panel's "local object memories" section can list them.
//
// The extension (Node) can't read the browser's IndexedDB, so the
// page enumerates it and POSTs the derived memory names to the
// extension route POST /object-memories (see extension-impl.js). The
// report is idempotent and repeats on an interval so memories added
// or removed at runtime show up without a reload.

(function () {
  'use strict';

  const REPORT_URL = '/object-memories';
  const REPORT_INTERVAL_MS = 15000;

  function openSqueakDB() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open('squeak'); }
      catch (e) { reject(e); return; }
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function listMemories() {
    const db = await openSqueakDB();
    try {
      if (!db.objectStoreNames.contains('files')) return [];
      const keys = await new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readonly');
        const rq = tx.objectStore('files').getAllKeys();
        rq.onsuccess = () => resolve(rq.result || []);
        rq.onerror = () => reject(rq.error);
      });
      const names = [];
      for (const k of keys) {
        const m = /^\/(.+)\.image$/.exec(String(k));
        if (m && names.indexOf(m[1]) === -1) names.push(m[1]);
      }
      return names;
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  async function report() {
    try {
      const memories = await listMemories();
      await fetch(REPORT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memories })
      });
    } catch (e) {
      console.warn('[orbit-object-memories] report failed', e);
    }
  }

  // Exposed so other code (or the agent) can force a re-report.
  window.orbitReportObjectMemories = report;

  // The object memory this page is running (from ?image=, default the
  // primary "caffeine"). Used to obey close requests targeted at us.
  // Read from our own location: in the Integrated Browser `window.top`
  // is the cross-origin webview host, so touching its location throws.
  function thisMemory() {
    try {
      const p = new URLSearchParams(window.location.search);
      return p.get('image') || 'caffeine';
    } catch (_) { return 'caffeine'; }
  }

  // Listen for the extension's close-request broadcast (sent when the
  // user unchecks this memory in the Orbit panel) and close our own
  // browser tab.
  function listenForClose() {
    let es;
    try { es = new EventSource('/mcp-events'); }
    catch (_) { setTimeout(listenForClose, 5000); return; }
    es.onmessage = function (ev) {
      let payload;
      try { payload = JSON.parse(ev.data); } catch (_) { return; }
      if (payload && payload.closeMemory
          && payload.closeMemory === thisMemory()) {
        try { window.top.close(); } catch (_) {}
        try { window.close(); } catch (_) {}
      }
    };
    es.onerror = function () { /* auto-reconnects */ };
  }

  window.addEventListener('load', () => {
    report();
    setInterval(report, REPORT_INTERVAL_MS);
    listenForClose();
  });
})();
