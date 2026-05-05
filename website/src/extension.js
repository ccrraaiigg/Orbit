// Real shim shipped inside the .vsix. Loads the factory implementation
// from a sibling file and passes vscode through. install-extension.sh
// overwrites this file in the installed extension directory with a
// shim that points at the workspace copy of extension-impl.js, so that
// edits in the workspace take effect without reinstall.
const vscode = require('vscode');
module.exports = require('./extension-impl')(vscode);
