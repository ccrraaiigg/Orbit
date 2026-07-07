#!/usr/bin/env node
// symlink-extension.js — shared helper that replaces a subset of files
// inside an installed extension directory with symlinks back to the
// workspace source so livecoding edits take effect without reinstall.
'use strict';

const fs = require('fs');
const path = require('path');

function symlinkExtension(extDir, website) {
    const srcJs = path.join(website, 'public/js');
    const srcComponents = path.join(srcJs, 'components');
    const srcSqueakjs = path.join(srcJs, 'squeakjs');
    const srcCss = path.join(website, 'public/css');
    const dstJs = path.join(extDir, 'public/js');
    const dstComponents = path.join(dstJs, 'components');
    const dstSqueakjs = path.join(dstJs, 'squeakjs');
    const dstCss = path.join(extDir, 'public/css');

    function symlink(src, dst, label) {
        try { fs.unlinkSync(dst); } catch (_) {}
        fs.symlinkSync(src, dst);
        console.log(`symlinked ${label}`);
    }

    for (const f of ['morphic-window.js', 'icon-manager.js', 'transient-window.js', 'workbook-window.js', 'spec-compiler.js']) {
        symlink(path.join(srcComponents, f), path.join(dstComponents, f), `components/${f}`);
    }

    for (const f of ['orbit-paste.js', 'orbit-clipboard.js', 'orbit-mcp-events.js', 'caffeine.js', 'orbit-version-check.js']) {
        symlink(path.join(srcJs, f), path.join(dstJs, f), `js/${f}`);
    }

    symlink(path.join(srcJs, 'html/utilities.js'), path.join(dstJs, 'html/utilities.js'), 'js/html/utilities.js');

    symlink(path.join(website, 'public/orbit.html'), path.join(extDir, 'public/orbit.html'), 'orbit.html');
    symlink(path.join(website, 'public/squeak.html'), path.join(extDir, 'public/squeak.html'), 'squeak.html');
    symlink(path.join(srcSqueakjs, 'vm.js'), path.join(dstSqueakjs, 'vm.js'), 'squeakjs/vm.js');
    symlink(path.join(srcSqueakjs, 'squeak.js'), path.join(dstSqueakjs, 'squeak.js'), 'squeakjs/squeak.js');
    symlink(
        path.join(srcSqueakjs, 'plugins/BitBltPlugin.js'),
        path.join(dstSqueakjs, 'plugins/BitBltPlugin.js'),
        'squeakjs/plugins/BitBltPlugin.js'
    );
    symlink(path.join(srcCss, 'caffeine.css'), path.join(dstCss, 'caffeine.css'), 'css/caffeine.css');

    // Shim app.js
    const appShim = `// Auto-generated shim — see build-extension.js\nlet vscode = null;\ntry { vscode = require('vscode'); } catch (_) {}\nmodule.exports = require('${website}/app-impl.js')(vscode);\n`;
    fs.writeFileSync(path.join(extDir, 'app.js'), appShim);
    console.log('wrote shim app.js');

    // Shim src/extension.js
    const extShim = `// Auto-generated shim — see build-extension.js\nconst vscode = require('vscode');\nmodule.exports = require('${website}/src/extension-impl.js')(vscode);\n`;
    fs.writeFileSync(path.join(extDir, 'src/extension.js'), extShim);
    console.log('wrote shim src/extension.js');

    for (const f of ['index.js', 'orbit.js', 'secrets.js', 'users.js']) {
        symlink(path.join(website, 'routes', f), path.join(extDir, 'routes', f), `routes/${f}`);
    }

    // Symlink entire directories
    try { fs.rmSync(path.join(extDir, 'bin'), { recursive: true }); } catch (_) {}
    fs.symlinkSync(path.join(website, 'bin'), path.join(extDir, 'bin'));
    console.log('symlinked bin/');

    try { fs.rmSync(path.join(extDir, 'secrets'), { recursive: true }); } catch (_) {}
    fs.symlinkSync(path.join(website, 'secrets'), path.join(extDir, 'secrets'));
    console.log('symlinked secrets/');
}

module.exports = { symlinkExtension };
