// Self-contained WebDAV FileSystemProvider for the Orbit extension.
//
// Avoids the host OS WebDAV client entirely. The provider talks HTTP
// to the Orbit Smalltalk backend's WebDAV server using Node's built-in
// http module and surfaces the tree under a custom URI scheme so it
// can be added as a workspace folder via vscode.workspace
// updateWorkspaceFolders.
//
// Exported as a factory taking the vscode API.

'use strict';

const http = require('http');
const { URL } = require('url');

const SCHEME = 'orbit-webdav';

// --- tiny PROPFIND XML parser ------------------------------------------
// The Smalltalk WebDAV server emits straightforward multistatus
// documents. We extract one record per <response> element with the
// fields we care about: href, resourcetype, getcontentlength,
// getlastmodified, creationdate. No external XML dep.
function stripNs(tag) {
    const i = tag.indexOf(':');
    return i >= 0 ? tag.slice(i + 1) : tag;
}

function parseMultistatus(xml) {
    const out = [];
    const reResp = /<([A-Za-z0-9]+:)?response\b[^>]*>([\s\S]*?)<\/\1?response>/g;
    let m;
    while ((m = reResp.exec(xml)) !== null) {
        const body = m[2];
        const href = matchInner(body, 'href');
        const isCollection = /<([A-Za-z0-9]+:)?collection\b[^>]*\/?>/.test(body);
        const sizeStr = matchInner(body, 'getcontentlength');
        const mtimeStr = matchInner(body, 'getlastmodified');
        const ctimeStr = matchInner(body, 'creationdate');
        out.push({
            href: href ? decodeURIComponent(href.trim()) : '',
            isCollection,
            size: sizeStr ? parseInt(sizeStr, 10) || 0 : 0,
            mtime: mtimeStr ? Date.parse(mtimeStr) || 0 : 0,
            ctime: ctimeStr ? Date.parse(ctimeStr) || 0 : 0
        });
    }
    return out;
}

function matchInner(xml, localName) {
    const re = new RegExp(
        '<(?:[A-Za-z0-9]+:)?' + localName + '\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9]+:)?' + localName + '>',
        'i'
    );
    const m = re.exec(xml);
    return m ? m[1] : null;
}

// --- HTTP helper -------------------------------------------------------
function request(method, urlString, { headers, body, expectBody } = {}) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(urlString); } catch (e) { return reject(e); }
        const opts = {
            method,
            hostname: u.hostname,
            port: u.port || 80,
            path: u.pathname + u.search,
            headers: Object.assign(
                {
                    'User-Agent': 'orbit-webdav/1',
                    'Accept': '*/*'
                },
                headers || {}
            )
        };
        if (body !== undefined && body !== null) {
            const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
            opts.headers['Content-Length'] = String(buf.length);
            const req = http.request(opts, onResp);
            req.on('error', reject);
            req.write(buf);
            req.end();
        } else {
            const req = http.request(opts, onResp);
            req.on('error', reject);
            req.end();
        }
        function onResp(res) {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const data = Buffer.concat(chunks);
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: expectBody === false ? null : data
                });
            });
            res.on('error', reject);
        }
    });
}

module.exports = function createWebdavFs(vscode, options) {
    const baseUrl = (options && options.baseUrl) || 'http://127.0.0.1:19073/webdav';
    const getAuthHeader = (options && options.getAuthHeader) || (() => null);

    // Map a vscode Uri (scheme=orbit-webdav, authority='', path=/x/y)
    // to a remote WebDAV URL. Authority is unused so multiple roots
    // share one connection.
    function uriToUrl(uri) {
        const path = uri.path || '/';
        // baseUrl already ends with /webdav (no trailing slash); join cleanly.
        const trimmed = baseUrl.replace(/\/+$/, '');
        const segs = path.split('/').filter(Boolean).map(encodeURIComponent);
        return trimmed + '/' + segs.join('/');
    }

    function authHeaders() {
        const h = {};
        const a = getAuthHeader();
        if (a) h['Authorization'] = a;
        return h;
    }

    function fileError(err, uri, operation) {
        // Map HTTP status codes to vscode.FileSystemError.
        const status = err && err.status;
        if (status === 404) return vscode.FileSystemError.FileNotFound(uri);
        if (status === 403 || status === 401) return vscode.FileSystemError.NoPermissions(uri);
        if (status === 405 || status === 409) return vscode.FileSystemError.Unavailable(uri);
        if (status === 412) return vscode.FileSystemError.FileExists(uri);
        const e = new Error(
            'WebDAV ' + operation + ' failed' +
            (status ? ' (' + status + ')' : '') +
            (err && err.message ? ': ' + err.message : '')
        );
        return e;
    }

    function hrefToPath(href) {
        // Server returns hrefs like "/webdav/classes/Object" or full URL.
        let p = href;
        try {
            if (/^https?:\/\//i.test(href)) p = new URL(href).pathname;
        } catch (_) {}
        const baseP = new URL(baseUrl).pathname.replace(/\/+$/, '');
        if (p.startsWith(baseP)) p = p.slice(baseP.length);
        if (!p.startsWith('/')) p = '/' + p;
        return p.replace(/\/+$/, '') || '/';
    }

    const FileType = vscode.FileType;

    class WebdavFs {
        constructor() {
            this._emitter = new vscode.EventEmitter();
            this.onDidChangeFile = this._emitter.event;
        }

        watch(_uri, _options) {
            // Server-push not implemented; refresh-on-demand only.
            return new vscode.Disposable(() => {});
        }

        async stat(uri) {
            const url = uriToUrl(uri);
            const res = await request('PROPFIND', url, {
                headers: Object.assign({
                    'Depth': '0',
                    'Content-Type': 'application/xml; charset=utf-8'
                }, authHeaders()),
                body: '<?xml version="1.0" encoding="utf-8" ?>\n<propfind xmlns="DAV:"><allprop/></propfind>'
            });
            if (res.status === 404) throw vscode.FileSystemError.FileNotFound(uri);
            if (res.status >= 400) throw fileError({ status: res.status }, uri, 'stat');
            const records = parseMultistatus(res.body.toString('utf8'));
            if (!records.length) throw vscode.FileSystemError.FileNotFound(uri);
            const rec = records[0];
            return {
                type: rec.isCollection ? FileType.Directory : FileType.File,
                ctime: rec.ctime,
                mtime: rec.mtime,
                size: rec.size
            };
        }

        async readDirectory(uri) {
            const url = uriToUrl(uri);
            const res = await request('PROPFIND', url, {
                headers: Object.assign({
                    'Depth': '1',
                    'Content-Type': 'application/xml; charset=utf-8'
                }, authHeaders()),
                body: '<?xml version="1.0" encoding="utf-8" ?>\n<propfind xmlns="DAV:"><allprop/></propfind>'
            });
            if (res.status === 404) throw vscode.FileSystemError.FileNotFound(uri);
            if (res.status >= 400) throw fileError({ status: res.status }, uri, 'readDirectory');
            const records = parseMultistatus(res.body.toString('utf8'));
            const selfPath = (uri.path || '/').replace(/\/+$/, '') || '/';
            const out = [];
            for (const rec of records) {
                const p = hrefToPath(rec.href);
                if (p === selfPath || p === selfPath + '/') continue;
                // Compute the basename relative to selfPath.
                let rel = p;
                if (selfPath !== '/' && rel.startsWith(selfPath + '/')) {
                    rel = rel.slice(selfPath.length + 1);
                } else if (selfPath === '/' && rel.startsWith('/')) {
                    rel = rel.slice(1);
                }
                if (!rel || rel.includes('/')) continue;
                out.push([rel, rec.isCollection ? FileType.Directory : FileType.File]);
            }
            return out;
        }

        async createDirectory(uri) {
            const url = uriToUrl(uri);
            const res = await request('MKCOL', url, {
                headers: authHeaders()
            });
            if (res.status >= 400 && res.status !== 405) {
                throw fileError({ status: res.status }, uri, 'createDirectory');
            }
        }

        async readFile(uri) {
            const url = uriToUrl(uri);
            const res = await request('GET', url, { headers: authHeaders() });
            if (res.status === 404) throw vscode.FileSystemError.FileNotFound(uri);
            if (res.status >= 400) throw fileError({ status: res.status }, uri, 'readFile');
            return new Uint8Array(res.body);
        }

        async writeFile(uri, content, options) {
            const url = uriToUrl(uri);
            const headers = Object.assign({
                'Content-Type': 'application/octet-stream'
            }, authHeaders());
            // Map create/overwrite flags to If-Match / If-None-Match
            // semantics where possible; otherwise leave to the server.
            if (options && options.create === false) {
                // require existing file: nothing standard, rely on server
            }
            if (options && options.overwrite === false) {
                headers['If-None-Match'] = '*';
            }
            const res = await request('PUT', url, {
                headers,
                body: Buffer.from(content)
            });
            if (res.status === 412) throw vscode.FileSystemError.FileExists(uri);
            if (res.status >= 400) throw fileError({ status: res.status }, uri, 'writeFile');
            this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        }

        async delete(uri, _options) {
            const url = uriToUrl(uri);
            const res = await request('DELETE', url, { headers: authHeaders() });
            if (res.status === 404) throw vscode.FileSystemError.FileNotFound(uri);
            if (res.status >= 400) throw fileError({ status: res.status }, uri, 'delete');
            this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
        }

        async rename(oldUri, newUri, options) {
            const fromUrl = uriToUrl(oldUri);
            const toUrl = uriToUrl(newUri);
            const headers = Object.assign({
                'Destination': toUrl,
                'Overwrite': options && options.overwrite ? 'T' : 'F'
            }, authHeaders());
            const res = await request('MOVE', fromUrl, { headers });
            if (res.status === 404) throw vscode.FileSystemError.FileNotFound(oldUri);
            if (res.status === 412) throw vscode.FileSystemError.FileExists(newUri);
            if (res.status >= 400) throw fileError({ status: res.status }, oldUri, 'rename');
            this._emitter.fire([
                { type: vscode.FileChangeType.Deleted, uri: oldUri },
                { type: vscode.FileChangeType.Created, uri: newUri }
            ]);
        }

        async copy(srcUri, dstUri, options) {
            const fromUrl = uriToUrl(srcUri);
            const toUrl = uriToUrl(dstUri);
            const headers = Object.assign({
                'Destination': toUrl,
                'Overwrite': options && options.overwrite ? 'T' : 'F'
            }, authHeaders());
            const res = await request('COPY', fromUrl, { headers });
            if (res.status === 404) throw vscode.FileSystemError.FileNotFound(srcUri);
            if (res.status === 412) throw vscode.FileSystemError.FileExists(dstUri);
            if (res.status >= 400) throw fileError({ status: res.status }, srcUri, 'copy');
            this._emitter.fire([{ type: vscode.FileChangeType.Created, uri: dstUri }]);
        }
    }

    return { provider: new WebdavFs(), scheme: SCHEME };
};

module.exports.SCHEME = SCHEME;
