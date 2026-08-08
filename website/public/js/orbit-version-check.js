// Orbit version-check: detects a new extension version by comparing the
// uncompressed sizes of caffeine.image and caffeine.changes inside
// memories/caffeine.zip against sizes recorded on the previous run.
//
// On a fresh page (no record): records sizes silently; the squeak IDB is
// either empty or about to be populated by SqueakJS.
// On a load where sizes match: does nothing.
// On a load where sizes differ: erases the local "squeak" IndexedDB and
// records the new sizes, so the updated extension's image boots. No
// prompt: any user-modified image was already saved by the boot-time
// backup (js/orbit-idb-backup.js), which squeak.html runs before this
// check.

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

    // Any user-modified image was already saved by the boot-time backup.
    try {
      await deleteIDB(DB_NAME);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newSizes));
      console.log('[orbit-version-check] extension updated: erased', DB_NAME,
                  '(previous contents are in the latest workspace backup)',
                  '; recorded new sizes', newSizes);
    } catch (e) {
      console.error('[orbit-version-check] failed to erase DB', e);
    }
  }

  window.orbitCheckCaffeineZipVersion = check;
})();
