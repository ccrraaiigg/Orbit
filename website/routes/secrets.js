// routes/secrets.js
//
// Local-development secret delivery for the remote Smalltalk image.
//
// The Orbit MCP server (running in the remote Smalltalk on a different host)
// needs the GitHub OAuth App client secret in order to act as a token-exchange
// proxy to GitHub. Rather than checking the secret into the image or storing
// it on the Windows host, we serve it from this Node webserver, which already
// runs on the developer's machine alongside the agent harness.
//
// SECURITY POSTURE
// ----------------
// This endpoint is intended ONLY for local development. It serves a plaintext
// secret to anyone who can reach this webserver's port. We restrict to private
// network address ranges as a coarse guardrail. Do not expose this webserver
// to the public internet.

var express = require('express');
var fs = require('fs');
var path = require('path');
var https = require('https');

var router = express.Router();

var SECRETS_DIR = path.join(__dirname, '..', 'secrets');

// Coarse private-IP guardrail.
function isPrivateAddress(addr) {
  if (!addr) return false;
  if (addr === '::1' || addr === '127.0.0.1') return true;
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (addr.startsWith('127.')) return true;
  if (addr.startsWith('10.')) return true;
  if (addr.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return true;
  return false;
}

router.get('/github-oauth-client.json', function (req, res) {
  if (!isPrivateAddress(req.ip)) {
    return res.status(403).json({ error: 'forbidden', detail: 'private network only' });
  }
  var p = path.join(SECRETS_DIR, 'github-oauth-client.json');
  fs.readFile(p, 'utf8', function (err, data) {
    if (err) {
      var status = err.code === 'ENOENT' ? 404 : 500;
      return res.status(status).json({
        error: err.code || 'read_failed',
        detail: 'Place the GitHub OAuth App client_id and client_secret in '
          + 'website/secrets/github-oauth-client.json (see the .example.json '
          + 'file alongside it).'
      });
    }
    res.type('application/json').send(data);
  });
});

// HTTPS proxy: exchange an OAuth authorization code for an access token at
// https://github.com/login/oauth/access_token. The remote VisualWorks image
// does not have HTTPS support loaded, so we forward the request through
// this Node process. Body must be application/x-www-form-urlencoded; we
// pass it to GitHub verbatim and return GitHub's response (status, content
// type, body) verbatim.
router.post('/github-token-exchange', function (req, res) {
  if (!isPrivateAddress(req.ip)) {
    return res.status(403).type('application/json')
      .send(JSON.stringify({ error: 'forbidden', detail: 'private network only' }));
  }
  // Reconstruct the form-encoded body. express.urlencoded already parsed
  // it into req.body, so re-encode rather than re-reading the raw stream.
  var body = req.body || {};
  var encoded = Object.keys(body)
    .map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(body[k]);
    })
    .join('&');
  var ghReq = https.request({
    method: 'POST',
    host: 'github.com',
    path: '/login/oauth/access_token',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(encoded),
      'Accept': 'application/json',
      'User-Agent': 'orbit-token-proxy'
    }
  }, function (ghRes) {
    var chunks = [];
    ghRes.on('data', function (c) { chunks.push(c); });
    ghRes.on('end', function () {
      var buf = Buffer.concat(chunks);
      res.status(ghRes.statusCode || 502);
      var ct = ghRes.headers['content-type'];
      if (ct) res.set('Content-Type', ct);
      res.send(buf);
    });
  });
  ghReq.on('error', function (err) {
    res.status(502).type('application/json')
      .send(JSON.stringify({ error: 'github_request_failed', detail: err.message }));
  });
  ghReq.write(encoded);
  ghReq.end();
});

// HTTPS proxy: verify a GitHub access token by calling
// https://api.github.com/user with it. The remote VisualWorks image
// has no HTTPS support, so it asks us to make this call. The token is
// passed as Authorization: Bearer <token> on this request and forwarded
// verbatim to GitHub. We return GitHub's status, content type, and body.
router.get('/github-user', function (req, res) {
  if (!isPrivateAddress(req.ip)) {
    return res.status(403).type('application/json')
      .send(JSON.stringify({ error: 'forbidden', detail: 'private network only' }));
  }
  var auth = req.get('Authorization') || '';
  var headerToken = req.get('X-Github-Token') || '';
  var token = '';
  if (headerToken) {
    token = headerToken.trim();
  } else if (/^bearer\s+/i.test(auth)) {
    token = auth.replace(/^bearer\s+/i, '').trim();
  }
  if (!token) {
    return res.status(400).type('application/json')
      .send(JSON.stringify({ error: 'missing_bearer', detail: 'Authorization: Bearer <token> or X-Github-Token: <token> required' }));
  }
  var ghReq = https.request({
    method: 'GET',
    host: 'api.github.com',
    path: '/user',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'orbit-token-verifier'
    }
  }, function (ghRes) {
    var chunks = [];
    ghRes.on('data', function (c) { chunks.push(c); });
    ghRes.on('end', function () {
      var buf = Buffer.concat(chunks);
      res.status(ghRes.statusCode || 502);
      var ct = ghRes.headers['content-type'];
      if (ct) res.set('Content-Type', ct);
      res.send(buf);
    });
  });
  ghReq.on('error', function (err) {
    res.status(502).type('application/json')
      .send(JSON.stringify({ error: 'github_request_failed', detail: err.message }));
  });
  ghReq.end();
});

module.exports = router;
