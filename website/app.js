// Real shim shipped inside the .vsix. install-extension.sh overwrites
// this file in the installed extension dir with a shim pointing at the
// workspace copy of app-impl.js, so edits take effect without reinstall.
let vscode = null;
try { vscode = require('vscode'); } catch (_) {}
module.exports = require('./app-impl')(vscode);
