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

const CLIPBOARD_PORT_FILE = path.join(os.tmpdir(), 'orbit-clipboard.port');
const WORKSPACE_FS_PORT_FILE = path.join(os.tmpdir(), 'orbit-workspace-fs.port');

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

// Workspace FS bridge: pass GETs through to the private workspace-fs
// bridge started by the Orbit extension. The bridge gates URIs by
// scheme and exposes vscode.workspace.fs (every registered
// FileSystemProvider). Body is streamed verbatim, including binary
// payloads from /workspace-fs/read.
app.get('/workspace-fs/*', (req, res) => {
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

