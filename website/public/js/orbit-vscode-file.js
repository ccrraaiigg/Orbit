// Writes the "vscode" file into the page's SqueakJS file system, so a
// booting object memory can read the Orbit webserver's port from it
// (Lam2300>>connect uses it for the tether URL).
//
// The extension (Node) can't reach the browser's IndexedDB, so it
// publishes the port as window.__ORBIT_PORT__ (served by
// /orbit-bridge-config.js) and the page writes the file here, before
// SqueakJS boots the image.
//
// Written with Squeak.filePut rather than a raw IndexedDB put: the
// contents live in IndexedDB, but the directory entry Squeak consults
// lives in localStorage under "squeak:/", and the image needs both.

(function () {
  'use strict';

  const FILE_PATH = '/vscode';

  function orbitPort() {
    try {
      const p = window.top.__ORBIT_PORT__;
      if (Number.isFinite(p) && p > 0) return p;
    } catch (_) {}
    const p = parseInt(location.port, 10);
    return Number.isFinite(p) && p > 0 ? p : null;
  }

  function writeVSCodeFile() {
    return new Promise((resolve, reject) => {
      const port = orbitPort();
      if (!port) { reject(new Error('no Orbit webserver port available')); return; }
      if (typeof Squeak === 'undefined' || !Squeak.filePut) {
        reject(new Error('SqueakJS file system not loaded'));
        return;
      }
      const bytes = new TextEncoder().encode(JSON.stringify({ port: port }));
      const entry = Squeak.filePut(FILE_PATH, bytes.buffer, () => resolve(port));
      if (!entry) reject(new Error('could not write ' + FILE_PATH));
    });
  }

  window.orbitWriteVSCodeFile = writeVSCodeFile;
})();
