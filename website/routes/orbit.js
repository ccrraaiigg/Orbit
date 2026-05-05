// routes/orbit.js
//
// Self-describing endpoints for the Orbit harness, intended for consumption
// by the remote Smalltalk image. The image needs to know how to reach back
// to this Node webserver (e.g. to fetch the GitHub OAuth client secret),
// but the image cannot reliably learn that on its own. So we tell it.

var express = require('express');
var os = require('os');

var router = express.Router();

// Coarse private-IP guardrail (mirrors routes/secrets.js). Information here
// is not secret, but the endpoint exists for local development only.
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

// Pick the most useful LAN IPv4 address: external (not loopback), not
// link-local, IPv4. If multiple, prefer 192.168.* then 10.* then 172.16-31.*.
function selectLanAddress() {
  var ifaces = os.networkInterfaces();
  var candidates = [];
  Object.keys(ifaces).forEach(function (name) {
    (ifaces[name] || []).forEach(function (a) {
      if (a.family !== 'IPv4' && a.family !== 4) return;
      if (a.internal) return;
      if (a.address.startsWith('169.254.')) return; // link-local
      candidates.push({ iface: name, address: a.address });
    });
  });
  function score(c) {
    if (c.address.startsWith('192.168.')) return 3;
    if (c.address.startsWith('10.')) return 2;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(c.address)) return 1;
    return 0;
  }
  candidates.sort(function (a, b) { return score(b) - score(a); });
  return candidates[0] || null;
}

router.get('/host.json', function (req, res) {
  if (!isPrivateAddress(req.ip)) {
    return res.status(403).json({ error: 'forbidden', detail: 'private network only' });
  }
  var lan = selectLanAddress();
  var port = req.app.get('port') || (req.socket && req.socket.localPort) || null;
  res.json({
    address: lan ? lan.address : null,
    interface: lan ? lan.iface : null,
    port: port,
    hostHeader: req.headers.host || null
  });
});

module.exports = router;
