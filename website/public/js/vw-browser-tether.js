// vw-browser-tether.js
//
// HTTP+SSE connection from the page to the VW BrowserWebComponentAdapter.
// Uses a JSON-RPC-style HTTP endpoint on the Orbit bridge to send
// selection messages to VW and receive push notifications via SSE.
//
// This avoids re-implementing the full binary tether protocol in JS.
// The bridge routes calls through its existing tether to VW.
//
// Usage:
//   const conn = new VWBrowserTether();
//   await conn.connect();
//   const result = await conn.send('selectCategory:', ['Tether']);
//   // result is a parsed JSON object: {classes: [...]}

'use strict';

class VWBrowserTether {

  constructor() {
    this._adapterHash = null;
    this._connected = false;
    this._onPush = null;
    this._eventSource = null;
  }

  // ---- public API ----

  /**
   * Connect: create the VW-side adapter and (optionally) open an
   * SSE stream for push notifications.
   */
  async connect() {
    // Ask the bridge to create a BrowserWebComponentAdapter in VW
    const resp = await fetch('/orbit-browser-rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'createAdapter', params: [] })
    });
    if (!resp.ok) throw new Error('Failed to create adapter: ' + resp.status);
    const result = await resp.json();
    this._adapterHash = result.exposureHash;
    this._connected = true;

    // Open SSE for push notifications
    this._openSSE();

    return result;
  }

  get adapterHash() { return this._adapterHash; }

  /**
   * Send a message to the VW adapter. Returns a promise resolving
   * to the parsed JSON response.
   */
  async send(selector, args) {
    if (!this._connected) throw new Error('Not connected');

    const resp = await fetch('/orbit-browser-rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'send',
        params: {
          adapterHash: this._adapterHash,
          selector: selector,
          arguments: args || []
        }
      })
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`RPC error (${resp.status}): ${text}`);
    }
    return resp.json();
  }

  /**
   * Register a callback for push notifications from VW.
   */
  onPush(callback) {
    this._onPush = callback;
  }

  /**
   * Close the connection.
   */
  disconnect() {
    this._connected = false;
    if (this._eventSource) {
      this._eventSource.close();
      this._eventSource = null;
    }
  }

  // ---- SSE for push notifications ----

  _openSSE() {
    if (!this._adapterHash) return;
    this._eventSource = new EventSource(
      `/orbit-browser-events?adapter=${this._adapterHash}`);
    this._eventSource.onmessage = (event) => {
      if (!this._onPush) return;
      try {
        const msg = JSON.parse(event.data);
        this._onPush(msg.selector, msg.args);
      } catch (_) {}
    };
    this._eventSource.onerror = () => {
      // Will auto-reconnect
    };
  }
}

window.VWBrowserTether = VWBrowserTether;
