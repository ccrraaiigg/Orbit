// Exported as a factory so the installed extension's <ext>/app.js shim can
// require('vscode') from within the extension directory and pass it in.
// See website/src/extension.js for the analogous explanation.
module.exports = function (_vscode) {
var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
var orbitRouter = require('./routes/orbit');

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/users', usersRouter);
app.use('/orbit', orbitRouter);

// Clipboard bridge: the VS Code Integrated Browser swallows native Cmd+V
// and refuses navigator.clipboard.readText permission. The Orbit
// extension exposes vscode.env.clipboard via a tiny in-process HTTP
// server bound to a random localhost port; it writes that port number
// to a well-known file in the OS temp dir. We proxy requests to it
// here so the page can still GET/POST `/clipboard` against the public
// Orbit origin. When no extension is running (the user is browsing the
// Orbit webapp from a normal browser with VS Code closed), the bridge
// is absent and we return 503.
const os = require('os');
const fsmod = require('fs');
const httpmod = require('http');
const cryptomod = require('crypto');

const { readBearer, isLoopback, bearerHeaderMatches } = require('./src/bearer');

// Two bearer tokens gate the clipboard and workspace-fs proxies for
// non-loopback callers (the extension binds 0.0.0.0:8089 in dev-host
// mode so LAN browsers can load the page):
//
//   - `mcpBearer`: the shared Orbit MCP grant token (same one the
//     MCP bridge accepts). High-privilege; identifies CLI subagents
//     and external MCP clients.
//   - `pageBearer`: a per-process random token, minted at module
//     load and served to the Orbit webapp via /orbit-bridge-config.js.
//     Scoped to /clipboard and /workspace-fs/* only. Compromise of
//     this token does not grant MCP access.
//
// The page uses `pageBearer`; either token is accepted.
const mcpBearer  = readBearer(__dirname);
const pageBearer = cryptomod.randomBytes(32).toString('hex');

// Gate that allows loopback callers unconditionally and requires a
// matching Bearer token (either the MCP grant or the per-process
// page token) from any other origin. Returns true if the request
// should be allowed; otherwise writes a 401 response and returns
// false.
function allowBridgeAccess(req, res) {
    if (isLoopback(req)) return true;
    const auth = req.headers && req.headers['authorization'] || '';
    if (bearerHeaderMatches(auth, pageBearer)) return true;
    if (bearerHeaderMatches(auth, mcpBearer)) return true;
    res.status(401).json({ error: 'bridge access requires a Bearer token' });
    return false;
}

// Served to the Orbit webapp on startup. The page reads
// window.__ORBIT_BRIDGE_BEARER__ from this script and attaches it
// as `Authorization: Bearer …` to /clipboard and /workspace-fs/*
// requests. Mounted before the 404 catchall.
app.get('/orbit-bridge-config.js', (req, res) => {
    res.type('application/javascript')
       .set('Cache-Control', 'no-store')
       .send('window.__ORBIT_BRIDGE_BEARER__ = '
           + JSON.stringify(pageBearer) + ';\n');
});

// Exported so the extension (and tests) can read these without
// re-deriving them. The page never sees `mcpBearer`.
app.pageBearer = pageBearer;
app.mcpBearer  = mcpBearer;

const CLIPBOARD_PORT_FILE = path.join(os.tmpdir(), 'orbit-clipboard.port');
const WORKSPACE_FS_PORT_FILE = path.join(os.tmpdir(), 'orbit-workspace-fs.port');
const CHAT_PORT_FILE = path.join(os.tmpdir(), 'orbit-chat.port');

function readPortFile(file) {
  try {
    if (!fsmod.existsSync(file)) return null;
    const raw = fsmod.readFileSync(file, 'utf8').trim();
    const port = parseInt(raw, 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch (_) {
    return null;
  }
}

function readClipboardBridgePort() {
  return readPortFile(CLIPBOARD_PORT_FILE);
}

function proxyToBridge(method, body) {
  return new Promise((resolve, reject) => {
    const port = readClipboardBridgePort();
    if (!port) {
      const err = new Error('clipboard bridge unavailable');
      err.code = 'NO_BRIDGE';
      return reject(err);
    }
    const req = httpmod.request({
      method,
      host: '127.0.0.1',
      port,
      path: '/clipboard',
      headers: body
        ? { 'content-type': 'application/json',
            'content-length': Buffer.byteLength(body) }
        : {}
    }, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

app.get('/clipboard', async (req, res) => {
  if (!allowBridgeAccess(req, res)) return;
  try {
    const r = await proxyToBridge('GET');
    res.status(r.status).type('application/json').send(r.body);
  } catch (err) {
    if (err.code === 'NO_BRIDGE') {
      return res.status(503).json({ error: 'clipboard bridge unavailable (VS Code not running?)' });
    }
    res.status(500).json({ error: err.message });
  }
});
app.post('/clipboard', async (req, res) => {
  if (!allowBridgeAccess(req, res)) return;
  try {
    const text = (req.body && typeof req.body.text === 'string') ? req.body.text : '';
    const r = await proxyToBridge('POST', JSON.stringify({ text }));
    res.status(r.status).type('application/json').send(r.body);
  } catch (err) {
    if (err.code === 'NO_BRIDGE') {
      return res.status(503).json({ error: 'clipboard bridge unavailable (VS Code not running?)' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Chat bridge: lets the page open a VS Code Copilot Chat session by
// POSTing { query?, mode? } to /chat. Proxied to a private loopback
// server started by the extension, which dispatches to
// workbench.action.chat.open. Loopback-only on the bridge side; this
// proxy is gated by the standard bridge bearer/loopback check.
app.post('/chat', async (req, res) => {
  if (!allowBridgeAccess(req, res)) return;
  const port = readPortFile(CHAT_PORT_FILE);
  if (!port) {
    return res.status(503).json({ error: 'chat bridge unavailable (VS Code not running?)' });
  }
  const query = (req.body && typeof req.body.query === 'string') ? req.body.query : '';
  const mode  = (req.body && typeof req.body.mode  === 'string') ? req.body.mode  : 'panel';
  const newSession = !!(req.body && req.body.newSession);
  const body  = JSON.stringify({ query, mode, newSession });
  const upstream = httpmod.request({
    method: 'POST',
    host: '127.0.0.1',
    port,
    path: '/chat',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    }
  }, (upRes) => {
    let chunks = '';
    upRes.setEncoding('utf8');
    upRes.on('data', (c) => { chunks += c; });
    upRes.on('end', () => {
      res.status(upRes.statusCode).type('application/json').send(chunks);
    });
  });
  upstream.on('error', (err) => {
    res.status(502).json({ error: err.message });
  });
  upstream.write(body);
  upstream.end();
});

// Read-only chat session inspection. Proxied straight through to the
// same private bridge as POST /chat.
function proxyChatGet(req, res, path) {
  const port = readPortFile(CHAT_PORT_FILE);
  if (!port) {
    return res.status(503).json({ error: 'chat bridge unavailable (VS Code not running?)' });
  }
  const upstream = httpmod.request({
    method: 'GET', host: '127.0.0.1', port, path
  }, (upRes) => {
    res.status(upRes.statusCode);
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (k === 'connection' || k === 'transfer-encoding') continue;
      res.setHeader(k, v);
    }
    upRes.pipe(res);
  });
  upstream.on('error', (err) => { res.status(502).json({ error: err.message }); });
  upstream.end();
}
app.get('/chat/sessions', (req, res) => {
  if (!allowBridgeAccess(req, res)) return;
  proxyChatGet(req, res, '/chat/sessions');
});
app.get('/chat/sessions/:id', (req, res) => {
  if (!allowBridgeAccess(req, res)) return;
  proxyChatGet(req, res, '/chat/sessions/' + encodeURIComponent(req.params.id));
});
app.get('/chat/search', (req, res) => {
  if (!allowBridgeAccess(req, res)) return;
  const qs = new URLSearchParams();
  if (typeof req.query.q === 'string') qs.set('q', req.query.q);
  if (typeof req.query.limit === 'string') qs.set('limit', req.query.limit);
  proxyChatGet(req, res, '/chat/search?' + qs.toString());
});

// Workspace FS bridge: pass GETs through to the private workspace-fs
// bridge started by the Orbit extension. The bridge gates URIs by
// scheme and exposes vscode.workspace.fs (every registered
// FileSystemProvider). Body is streamed verbatim, including binary
// payloads from /workspace-fs/read.
app.get('/workspace-fs/*', (req, res) => {
  if (!allowBridgeAccess(req, res)) return;
  const port = readPortFile(WORKSPACE_FS_PORT_FILE);
  if (!port) {
    return res.status(503).json({ error: 'workspace-fs bridge unavailable (VS Code not running?)' });
  }
  const upstream = httpmod.request({
    method: 'GET',
    host: '127.0.0.1',
    port,
    path: req.originalUrl
  }, (upRes) => {
    res.status(upRes.statusCode);
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (k === 'connection' || k === 'transfer-encoding') continue;
      res.setHeader(k, v);
    }
    upRes.pipe(res);
  });
  upstream.on('error', (err) => {
    res.status(502).json({ error: err.message });
  });
  upstream.end();
});

// MCP bridge: proxies HTTP MCP JSON-RPC traffic to an MCP server
// hosted in the Orbit webapp page. The page registers itself by
// connecting a WebSocket to /orbit-tether and announcing its
// endpoint over the Tether protocol; see src/mcp-bridge.js.
// bin/www calls app.attachMcpBridge(server) after the http.Server is
// created so the bridge can install its `upgrade` listener.
const { McpBridge } = require('./src/mcp-bridge');
const mcpBridge = new McpBridge({ extensionPath: __dirname });
app.use(mcpBridge.middleware());
app.attachMcpBridge = function (server) {
  mcpBridge.attachToHttpServer(server);
};
app.mcpBridge = mcpBridge;

// Snowglobe server: accepts the in-page Caffeine Snowglobe client at
// /snowglobe and speaks the same wire protocol VW Snowglobe servers
// do. See src/snowglobe-server.js.
const { SnowglobeServer } = require('./src/snowglobe-server');
const snowglobeServer = new SnowglobeServer();
app.attachSnowglobeServer = function (server) {
  snowglobeServer.attachToHttpServer(server);
};
app.snowglobeServer = snowglobeServer;

// Caffeine window bounds persistence: the page PUTs its bounds here
// so they survive a reload. Served back by express.static as a plain
// JSON file at /caffeine-bounds.json.
const BOUNDS_FILE = path.join(__dirname, 'public', 'caffeine-bounds.json');
app.put('/caffeine-bounds.json', (req, res) => {
  const b = req.body;
  if (!b || typeof b !== 'object') {
    return res.status(400).json({ error: 'expected JSON object' });
  }
  // Only allow the four expected string keys
  const clean = {};
  for (const k of ['top', 'left', 'width', 'height']) {
    if (typeof b[k] === 'string') clean[k] = b[k];
  }
  try {
    fsmod.writeFileSync(BOUNDS_FILE, JSON.stringify(clean, null, 2) + '\n');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mount point for routes registered later by the Orbit extension
// (e.g. /mcp-events SSE). Mounted before the 404 catchall so
// late-added routes still match.
const extensionRoutes = express.Router();
app.use(extensionRoutes);
app.extensionRoutes = extensionRoutes;

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

return app;
};

