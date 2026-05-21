// Orbit version-check: detects a new extension version by comparing the
// uncompressed sizes of caffeine.image and caffeine.changes inside
// memories/caffeine.zip against sizes recorded on the previous run.
//
// On a fresh page (no record): records sizes silently; the squeak IDB is
// either empty or about to be populated by SqueakJS.
// On a load where sizes match: does nothing.
// On a load where sizes differ: shows an in-page modal asking whether to
// erase the local "squeak" IndexedDB. On confirm, deletes the DB and
// records the new sizes. On decline, leaves both alone (so the user is
// asked again next reload).

(function () {
  const ZIP_URL = 'memories/caffeine.zip';
  const DB_NAME = 'squeak';
  const TRACKED = ['caffeine.image', 'caffeine.changes'];
  const STORAGE_KEY = 'orbit:caffeineZipSizes';

  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'js/squeakjs/lib/jszip.js';
      s.onload = () => resolve(window.JSZip);
      s.onerror = () => reject(new Error('Failed to load JSZip'));
      document.head.appendChild(s);
    });
  }

  async function readZipSizes() {
    const JSZip = await loadJSZip();
    const resp = await fetch(ZIP_URL, { cache: 'no-cache' });
    if (!resp.ok) throw new Error('Cannot fetch ' + ZIP_URL + ': ' + resp.status);
    const buf = await resp.arrayBuffer();
    const zip = await JSZip().loadAsync(buf);
    const sizes = {};
    for (const name of TRACKED) {
      const entry = zip.file(name);
      if (!entry) throw new Error('Missing entry in zip: ' + name);
      let size = entry._data && entry._data.uncompressedSize;
      if (size == null) {
        // Fallback: actually decompress to measure.
        const ab = await entry.async('arraybuffer');
        size = ab.byteLength;
      }
      sizes[name] = size;
    }
    return sizes;
  }

  function deleteIDB(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('deleteDatabase error'));
      req.onblocked = () => reject(new Error('IndexedDB delete blocked: ' + name));
    });
  }

  function showModal() {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;' +
        'display:flex;align-items:center;justify-content:center;' +
        'font-family:sans-serif;';
      const box = document.createElement('div');
      box.style.cssText =
        'background:#222;color:#eee;padding:20px 24px;border-radius:8px;' +
        'max-width:560px;box-shadow:0 4px 24px rgba(0,0,0,0.5);';
      const msg = document.createElement('div');
      msg.style.cssText = 'margin-bottom:16px;line-height:1.4;';
      msg.textContent =
        "The Orbit extension has been updated, and you've made changes " +
        "to its webapp. Would you like to keep them?";
      const btnBar = document.createElement('div');
      btnBar.style.cssText = 'text-align:right;';
      const no = document.createElement('button');
      no.textContent = 'No';
      no.style.cssText =
        'margin-left:8px;padding:6px 14px;background:#c33;color:white;' +
        'border:0;border-radius:4px;cursor:pointer;';
      const yes = document.createElement('button');
      yes.textContent = 'Yes';
      yes.style.cssText =
        'margin-left:8px;padding:6px 14px;background:#444;color:white;' +
        'border:0;border-radius:4px;cursor:pointer;';
      // "keep" === true means user wants to keep their local changes.
      yes.onclick = () => { overlay.remove(); resolve(true); };
      no.onclick = () => { overlay.remove(); resolve(false); };
      btnBar.append(no, yes);
      box.append(msg, btnBar);
      overlay.append(box);
      document.body.append(overlay);
      yes.focus();
    });
  }

  async function check() {
    let newSizes;
    try {
      newSizes = await readZipSizes();
    } catch (e) {
      console.warn('[orbit-version-check] zip probe failed; skipping', e);
      return;
    }

    let recorded = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) recorded = JSON.parse(raw);
    } catch (_) { /* corrupt record: treat as missing */ }

    if (!recorded) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newSizes));
      console.log('[orbit-version-check] first run; recorded sizes', newSizes);
      return;
    }

    const changed = TRACKED.some(n => recorded[n] !== newSizes[n]);
    if (!changed) return;

    const keep = await showModal();

    if (keep) {
      // Record the new sizes so we don't re-prompt on every reload after
      // the user has chosen to keep their local image. The next time the
      // zip sizes change (i.e. another extension update), we'll prompt
      // again.
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(newSizes));
      } catch (e) {
        console.warn('[orbit-version-check] could not record sizes', e);
      }
      console.log('[orbit-version-check] user kept local changes; leaving DB intact, recorded new sizes', newSizes);
      try {
        window.open('http://localhost:8089/files.html', '_blank');
      } catch (e) {
        console.warn('[orbit-version-check] could not open files.html', e);
      }
      return;
    }

    try {
      await deleteIDB(DB_NAME);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newSizes));
      console.log('[orbit-version-check] erased', DB_NAME,
                  '; recorded new sizes', newSizes);
    } catch (e) {
      console.error('[orbit-version-check] failed to erase DB', e);
    }
  }

  window.orbitCheckCaffeineZipVersion = check;
})();
