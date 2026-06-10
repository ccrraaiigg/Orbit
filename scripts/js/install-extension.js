#!/usr/bin/env node
// install-extension.js — re-establish the livecoding symlinks inside the
// already-installed Orbit extension directory, without bumping the version
// or building a fresh VSIX. Use this when symlinks have been overwritten
// (e.g. by a manual --install-extension), or after pulling source changes
// that add new files needing symlinks.
//
// To bump the version, build a VSIX, and install it, use build-extension.js.
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const WEBSITE = path.join(PROJECT_ROOT, 'website');

// Import symlinkExtension from the shared module
const { symlinkExtension } = require('./symlink-extension.js');

function getPkg() {
    const pkg = require(path.join(WEBSITE, 'package.json'));
    return {
        version: pkg.version,
        publisher: pkg.publisher.toLowerCase(),
        name: pkg.name,
        extensionId: `${pkg.publisher.toLowerCase()}.${pkg.name}`
    };
}

function relinkFor(label, extRoot, pkg) {
    const extDir = path.join(extRoot, `${pkg.extensionId}-${pkg.version}`);
    if (!fs.existsSync(extDir)) {
        console.log(`Skipping ${label}: ${extDir} not found (run build-extension.js first)`);
        return;
    }
    console.log(`=== Relinking for ${label} ===`);
    symlinkExtension(extDir, WEBSITE);
}

const pkg = getPkg();
const home = require('os').homedir();

relinkFor('VS Code', path.join(home, '.vscode/extensions'), pkg);
relinkFor('VS Code Insiders', path.join(home, '.vscode-insiders/extensions'), pkg);

console.log('\nDone. Reload the VS Code window(s) to pick up changes.');
