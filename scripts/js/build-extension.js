#!/usr/bin/env node
// build-extension.js — bump version, package a fresh VSIX, install it into
// VS Code (Stable + Insiders if present), replace selected installed files
// with symlinks for livecoding, then push the VSIX to any live tunnel peers.
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const WEBSITE = path.join(PROJECT_ROOT, 'website');
const { symlinkExtension } = require('./symlink-extension.js');

// ─── Repack caffeine image ──────────────────────────────────────────────────

// If a fresh caffeine.image and caffeine.changes have been dropped into
// website/public/memories, rebuild caffeine.zip from them and remove the loose
// files so the new memory ships inside the VSIX.
function repackCaffeineImage() {
    const memoriesDir = path.join(WEBSITE, 'public', 'memories');
    const imagePath = path.join(memoriesDir, 'caffeine.image');
    const changesPath = path.join(memoriesDir, 'caffeine.changes');
    const zipPath = path.join(memoriesDir, 'caffeine.zip');

    if (!fs.existsSync(imagePath) || !fs.existsSync(changesPath)) return;

    console.log('=== Repacking caffeine.zip from caffeine.image + caffeine.changes ===');
    fs.rmSync(zipPath, { force: true });
    execSync('zip -X "caffeine.zip" "caffeine.image" "caffeine.changes"', {
        cwd: memoriesDir,
        stdio: 'inherit'
    });
    fs.rmSync(imagePath, { force: true });
    fs.rmSync(changesPath, { force: true });
    console.log('Repacked caffeine.zip and removed loose image/changes files');
}

// ─── Version bump ───────────────────────────────────────────────────────────

function bumpVersion() {
    if (process.env.SKIP_VERSION_BUMP) return;
    const pkgPath = path.join(WEBSITE, 'package.json');
    const src = fs.readFileSync(pkgPath, 'utf8');
    const m = src.match(/("version"\s*:\s*")(\d+)\.(\d+)\.(\d+)(")/);
    if (!m) throw new Error('version field not found in package.json');
    const oldVersion = `${m[2]}.${m[3]}.${m[4]}`;
    const newVersion = `${m[2]}.${Number(m[3]) + 1}.0`;
    fs.writeFileSync(pkgPath, src.replace(m[0], m[1] + newVersion + m[5]));
    console.log(`Bumped version to ${newVersion} (was ${oldVersion})`);
}

// ─── Package info ───────────────────────────────────────────────────────────

function getPkg() {
    const pkg = require(path.join(WEBSITE, 'package.json'));
    return {
        version: pkg.version,
        publisher: pkg.publisher.toLowerCase(),
        name: pkg.name,
        extensionId: `${pkg.publisher.toLowerCase()}.${pkg.name}`
    };
}

// ─── Cleanup stale VSIXes ───────────────────────────────────────────────────

function cleanStaleVsix(name, vsixPath) {
    for (const dir of [PROJECT_ROOT, WEBSITE]) {
        for (const f of fs.readdirSync(dir)) {
            if (f.startsWith(`${name}-`) && f.endsWith('.vsix')) {
                const full = path.join(dir, f);
                if (full !== vsixPath) {
                    fs.unlinkSync(full);
                    console.log(`removed stale ${full}`);
                }
            }
        }
    }
}

// ─── Package VSIX ───────────────────────────────────────────────────────────

function packageVsix(name, version) {
    const vsixPath = path.join(PROJECT_ROOT, `${name}-${version}.vsix`);
    console.log(`=== Packaging ${name}-${version} ===`);
    execSync(`npx --yes vsce package --allow-missing-repository --out "${vsixPath}"`, {
        cwd: WEBSITE,
        stdio: 'inherit'
    });
    return vsixPath;
}

// ─── Install for a VS Code variant ─────────────────────────────────────────

function installFor(label, codeBin, extRoot, pkg, vsixPath) {
    if (!fs.existsSync(codeBin)) {
        console.log(`Skipping ${label}: ${codeBin} not found`);
        return;
    }

    console.log(`=== Installing for ${label} ===`);
    // Uninstall prior version (ignore failure)
    spawnSync(codeBin, ['--uninstall-extension', pkg.extensionId], { stdio: 'ignore' });
    execSync(`"${codeBin}" --install-extension "${vsixPath}" --force`, { stdio: 'inherit' });

    const extDir = path.join(extRoot, `${pkg.extensionId}-${pkg.version}`);
    symlinkExtension(extDir, WEBSITE);

    // Remove older installed versions
    for (const d of fs.readdirSync(extRoot)) {
        const full = path.join(extRoot, d);
        if (d.startsWith(`${pkg.extensionId}-`) && full !== extDir) {
            fs.rmSync(full, { recursive: true });
            console.log(`removed stale ${full}`);
        }
    }
}

// ─── Push VSIX to tunnel peers ──────────────────────────────────────────────

function pushVsixToPeers(vsixPath) {
    const result = spawnSync(process.execPath, [
        path.join(__dirname, 'push-extension.js'),
        vsixPath
    ], { stdio: 'inherit', encoding: 'utf8' });
    if (result.status !== 0) {
        console.log('  Push to peers failed (non-fatal)');
    }
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
    bumpVersion();

    const pkg = getPkg();
    const vsixPath = path.join(PROJECT_ROOT, `${pkg.name}-${pkg.version}.vsix`);

    cleanStaleVsix(pkg.name, vsixPath);
    // Repack the fresh Caffeine image into caffeine.zip and delete the loose
    // caffeine.image/caffeine.changes BEFORE packaging, so the VSIX ships only
    // the compressed zip (avoids the first-build bloat of shipping the loose
    // uncompressed image alongside the zip).
    repackCaffeineImage();
    packageVsix(pkg.name, pkg.version);

    const home = require('os').homedir();

    installFor('VS Code',
        '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
        path.join(home, '.vscode/extensions'),
        pkg, vsixPath);

    installFor('VS Code Insiders',
        '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code',
        path.join(home, '.vscode-insiders/extensions'),
        pkg, vsixPath);

    pushVsixToPeers(vsixPath);

    console.log('\nDone. Reload the VS Code window(s) to pick up changes.');
}

main();
