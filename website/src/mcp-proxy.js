// MCP reverse-proxy for TCP backends.
//
// Each TCP backend (2300-backend, 2300-ui, etc.) exposes its own MCP
// endpoint on a remote port. These servers may report the same
// serverInfo.name in their initialize response, causing VS Code to
// generate identical tool prefixes (name collisions). This module
// spawns one tiny HTTP proxy server per backend on a distinct local
// port. Each proxy forwards ALL traffic transparently (including
// OAuth discovery, 401 challenges, tokens, SSE) to the upstream,
// rewriting only serverInfo.name in a successful initialize response.
//
// Because each proxy has its own origin, OAuth flows work
// independently per backend — VSCode's per-origin OAuth discovery
// hits the proxy, which forwards to the upstream's well-known
// endpoints, and auth tokens are scoped correctly.
//
// Usage:
//   const { startProxies, stopProxies } = require('./mcp-proxy');
//   const proxies = await startProxies(backends, { mcpHost, log, error });
//   // proxies: Map<name, { port, server }>
//   // mcpUrlFor a backend: `http://localhost:${proxies.get(name).port}/mcpservice/v1/mcp`
//   stopProxies(proxies);

'use strict';

const http = require('http');
const net  = require('net');

// Try to listen on a specific port; resolve with that port on success,
// or fall back to an OS-assigned port if the preferred one is busy.
function listenOnPort(server, preferredPort, log) {
    return new Promise((resolve, reject) => {
        const onError = (e) => {
            if (e.code === 'EADDRINUSE' && preferredPort) {
                log(`port ${preferredPort} busy; falling back to random port`);
                server.removeListener('error', onError);
                server.listen(0, '127.0.0.1', () => resolve(server.address().port));
                server.on('error', reject);
            } else {
                reject(e);
            }
        };
        server.on('error', onError);
        const port = preferredPort || 0;
        server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', onError);
            resolve(server.address().port);
        });
    });
}

// Start one proxy server per TCP backend. Returns a Map<name, {port, server}>.
// Each backend may specify a stable `proxyPort`; using a fixed port ensures
// VS Code's per-origin OAuth token cache survives across extension restarts.
async function startProxies(backends, opts) {
    opts = opts || {};
    const log   = opts.log   || ((...a) => console.log('[mcp-proxy]', ...a));
    const error = opts.error || ((...a) => console.error('[mcp-proxy]', ...a));
    const mcpHost = opts.mcpHost || 'localhost';

    const proxies = new Map();

    for (const b of backends) {
        if (b.kind !== 'tcp') continue;
        const { server, self } = createProxyServer(b, mcpHost, log, error);
        const port = await listenOnPort(server, b.proxyPort, log);
        self.proxyPort = port;
        log(`proxy for ${b.name} listening on 127.0.0.1:${port} → ${mcpHost}:${b.mcpPort}`);
        proxies.set(b.name, { port, server });
    }

    return proxies;
}

function stopProxies(proxies) {
    if (!proxies) return;
    for (const [name, { server }] of proxies) {
        try { server.close(); } catch (_) {}
    }
    proxies.clear();
}

function createProxyServer(backend, mcpHost, log, error) {
    // The actual proxy port is set after listen(); we update it via
    // a mutable ref so the rewrite logic always has the current port.
    const self = { proxyPort: backend.proxyPort || 0 };

    const server = http.createServer((clientReq, clientRes) => {
        // Forward the request to the upstream, path and all.
        // This covers:
        //   /mcpservice/v1/mcp (the MCP endpoint)
        //   /.well-known/oauth-protected-resource (OAuth discovery)
        //   /.well-known/oauth-authorization-server (OAuth metadata)
        //   /oauth/* (token, authorize, register endpoints)
        //   Everything else the upstream serves.

        const isPost = clientReq.method === 'POST';
        // Only forward semantically relevant headers to upstream.
        // Spreading all client headers can forward hop-by-hop headers
        // (connection, transfer-encoding, etc.) that confuse the
        // upstream server.
        const upHeaders = {
            'host': `${mcpHost}:${backend.mcpPort}`
        };
        if (clientReq.headers['content-type']) {
            upHeaders['content-type'] = clientReq.headers['content-type'];
        }
        if (clientReq.headers['authorization']) {
            upHeaders['authorization'] = clientReq.headers['authorization'];
        }
        if (clientReq.headers['accept']) {
            upHeaders['accept'] = clientReq.headers['accept'];
        }
        if (clientReq.headers['mcp-session-id']) {
            upHeaders['mcp-session-id'] = clientReq.headers['mcp-session-id'];
        }

        // For POST requests we need to buffer the body to potentially
        // inspect the method for serverInfo rewriting.
        if (isPost) {
            const chunks = [];
            clientReq.on('data', (c) => chunks.push(c));
            clientReq.on('end', () => {
                const rawBody = Buffer.concat(chunks);
                upHeaders['content-length'] = rawBody.length;
                doProxy(backend, mcpHost, self, clientReq, clientRes,
                    rawBody, upHeaders, log, error);
            });
            clientReq.on('error', (e) => {
                error('client request error', backend.name, e && e.message);
                if (!clientRes.headersSent) {
                    clientRes.writeHead(502);
                    clientRes.end();
                }
            });
        } else {
            // GET, DELETE, etc. — forward with no body
            doProxy(backend, mcpHost, self, clientReq, clientRes,
                null, upHeaders, log, error);
        }
    });

    return { server, self };
}

function doProxy(backend, mcpHost, self, clientReq, clientRes, body, headers, log, error) {
    // Determine if this POST might be an initialize request
    let jsonBody = null;
    if (body && body.length > 0 && clientReq.method === 'POST') {
        try { jsonBody = JSON.parse(body.toString()); } catch (_) {}
    }

    log(`→ ${clientReq.method} ${mcpHost}:${backend.mcpPort}${clientReq.url}`,
        jsonBody ? `method=${jsonBody.method}` : '');

    // URL rewriting: replace upstream origin with proxy origin in
    // response headers and bodies so OAuth discovery always routes
    // through the proxy. This ensures resource_metadata URLs,
    // token endpoints, authorization_servers, etc. all point at
    // localhost:proxyPort rather than the LAN backend address.
    const upOrigin = `http://${mcpHost}:${backend.mcpPort}`;
    function proxyOrigin() {
        return `http://localhost:${self.proxyPort}`;
    }
    function rewriteUrls(str) {
        if (!str || !str.includes(upOrigin)) return str;
        return str.split(upOrigin).join(proxyOrigin());
    }
    function rewriteHeaders(rawHeaders) {
        const out = { ...rawHeaders };
        if (out['www-authenticate']) {
            out['www-authenticate'] = rewriteUrls(out['www-authenticate']);
        }
        if (out['location']) {
            out['location'] = rewriteUrls(out['location']);
        }
        return out;
    }

    // Determine if the response body might contain upstream URLs that
    // need rewriting: OAuth discovery endpoints and 401 error bodies.
    const url = clientReq.url || '';
    const isOAuthDiscovery = url.includes('.well-known') || url.startsWith('/oauth');
    const needsBodyRewrite = isOAuthDiscovery;

    const upReq = http.request({
        hostname: mcpHost,
        port: backend.mcpPort,
        path: clientReq.url,  // preserves full path + query
        method: clientReq.method,
        headers
    }, (upRes) => {
        const needsInitRewrite = jsonBody
            && jsonBody.method === 'initialize'
            && upRes.statusCode === 200
            && (upRes.headers['content-type'] || '').includes('application/json');

        const isJson = (upRes.headers['content-type'] || '').includes('application/json');
        const shouldBuffer = needsInitRewrite || (needsBodyRewrite && isJson);

        if (!shouldBuffer && upRes.statusCode !== 401) {
            // Fully transparent pass-through: status, headers, body
            clientRes.writeHead(upRes.statusCode, rewriteHeaders(upRes.headers));
            upRes.pipe(clientRes);
            return;
        }

        if (upRes.statusCode === 401 && !isJson) {
            // 401 but not JSON — just rewrite headers (WWW-Authenticate)
            clientRes.writeHead(upRes.statusCode, rewriteHeaders(upRes.headers));
            upRes.pipe(clientRes);
            return;
        }

        // Buffer response for rewriting
        const resChunks = [];
        upRes.on('data', (c) => resChunks.push(c));
        upRes.on('end', () => {
            try {
                let raw = Buffer.concat(resChunks).toString();

                if (needsInitRewrite) {
                    const parsed = JSON.parse(raw);
                    if (parsed.result) {
                        if (!parsed.result.serverInfo) {
                            parsed.result.serverInfo = {};
                        }
                        parsed.result.serverInfo.name = backend.name;
                        log('rewrote serverInfo.name →', backend.name);
                    }
                    raw = JSON.stringify(parsed);
                }

                // Rewrite any upstream URLs in the body
                raw = rewriteUrls(raw);

                const out = Buffer.from(raw);
                const fwdHeaders = rewriteHeaders(upRes.headers);
                fwdHeaders['content-length'] = out.length;
                clientRes.writeHead(upRes.statusCode, fwdHeaders);
                clientRes.end(out);
            } catch (_) {
                // Parse/rewrite failed; forward raw with header rewrite
                const raw = Buffer.concat(resChunks);
                clientRes.writeHead(upRes.statusCode, rewriteHeaders(upRes.headers));
                clientRes.end(raw);
            }
        });
        upRes.on('error', (e) => {
            error('upstream response error', backend.name, e && e.message);
            if (!clientRes.headersSent) {
                clientRes.writeHead(502);
                clientRes.end();
            }
        });
    });

    upReq.on('error', (e) => {
        error(`upstream connect error ${backend.name}: ${e && e.code} ${e && e.message}`);
        if (!clientRes.headersSent) {
            clientRes.writeHead(502);
            clientRes.end();
        }
    });
    upReq.setTimeout(30000, () => {
        upReq.destroy(new Error('upstream timeout'));
    });

    if (body && body.length > 0) {
        upReq.write(body);
    }
    upReq.end();

    // Abort upstream if the *client socket* closes before we finish
    // responding. clientRes 'close' fires on socket teardown;
    // writableFinished tells us if we completed normally.
    clientRes.on('close', () => {
        if (!clientRes.writableFinished) {
            upReq.destroy();
        }
    });
}

module.exports = { startProxies, stopProxies };
