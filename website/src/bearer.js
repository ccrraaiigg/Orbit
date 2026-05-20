// Shared helper to read the Orbit MCP/WebDAV/clipboard/workspace-fs
// bearer token. Sources, in order of precedence:
//   1. ORBIT_MCP_BEARER environment variable
//   2. <extensionPath>/secrets/mcp-bearer.txt
//   3. ~/.orbit/mcp-bearer
//
// Returns the trimmed token, or '' if none is available.

const fs = require('fs');
const os = require('os');
const path = require('path');

function readBearer(extensionPath) {
    let bearer = (process.env.ORBIT_MCP_BEARER || '').trim();
    if (!bearer && extensionPath) {
        try {
            const p = path.join(extensionPath, 'secrets', 'mcp-bearer.txt');
            if (fs.existsSync(p)) bearer = fs.readFileSync(p, 'utf8').trim();
        } catch (_) {}
    }
    if (!bearer) {
        try {
            const p = path.join(os.homedir(), '.orbit', 'mcp-bearer');
            if (fs.existsSync(p)) bearer = fs.readFileSync(p, 'utf8').trim();
        } catch (_) {}
    }
    return bearer;
}

// True iff `req` arrived from a loopback address. Checks both
// `req.ip` (set by express when trust-proxy is off) and the raw
// socket remoteAddress.
function isLoopback(req) {
    const ips = [
        req && req.ip,
        req && req.socket && req.socket.remoteAddress,
    ];
    for (const ip of ips) {
        if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
            return true;
        }
    }
    return false;
}

// True iff `auth` is exactly the Bearer header for `bearer`.
// Uses a constant-time compare to discourage timing oracles, even
// though this token isn't normally exposed off loopback.
function bearerHeaderMatches(auth, bearer) {
    if (!auth || !bearer) return false;
    const prefix = 'Bearer ';
    if (!auth.startsWith(prefix)) return false;
    const got = auth.slice(prefix.length);
    if (got.length !== bearer.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) {
        diff |= got.charCodeAt(i) ^ bearer.charCodeAt(i);
    }
    return diff === 0;
}

module.exports = { readBearer, isLoopback, bearerHeaderMatches };
