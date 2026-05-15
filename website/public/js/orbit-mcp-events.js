// Subscribes to the Orbit extension's MCP server state stream and
// dispatches each event to window.mcpServerNotification(payload) in
// the top window AND in every same-origin iframe (in particular the
// Caffeine SqueakJS iframe). Payload shape:
//   { name: string, running: boolean }.
// Define window.mcpServerNotification before this script runs (or
// lazily); if it's undefined when an event arrives, the event is
// silently dropped for that window.
(function () {
    if (typeof window === 'undefined') return;
    if (window.__orbitMcpEventsInstalled) return;
    window.__orbitMcpEventsInstalled = true;

    function dispatchToWindow(win, payload) {
        if (!win) return;
        try {
            const fn = win.mcpServerNotification;
            if (typeof fn === 'function') fn.call(win, payload);
        } catch (e) {
            try { console.error('[orbit] mcpServerNotification threw:', e); } catch (_) {}
        }
    }

    function dispatch(payload) {
        dispatchToWindow(window, payload);
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
            let cw = null;
            try { cw = iframes[i].contentWindow; } catch (_) {}
            dispatchToWindow(cw, payload);
        }
    }

    function open() {
        let es;
        try {
            es = new EventSource('/mcp-events');
        } catch (e) {
            console.warn('[orbit] EventSource open failed:', e);
            setTimeout(open, 5000);
            return;
        }
        es.onmessage = function (ev) {
            let payload;
            try { payload = JSON.parse(ev.data); }
            catch (e) {
                console.warn('[orbit] mcp-events: bad payload', ev.data);
                return;
            }
            dispatch(payload);
        };
        es.onerror = function () {
            // EventSource auto-reconnects; nothing to do.
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', open, { once: true });
    } else {
        open();
    }
})();
