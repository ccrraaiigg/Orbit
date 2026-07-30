// <snowglobe-demo-widget> — a small, self-contained, canvas-backed
// interactive web component used as the "simple bespoke web component"
// demo for the Snowglobe broker (see designs/server-specs/snowglobe.md
// and website/src/snowglobe-server.js).
//
// It is an ordinary page web component: it draws to its own <canvas>
// and reacts to pointer input. The Snowglobe producer
// (orbit-snowglobe-producer.js) captures that canvas as a Snowglobe
// window and applies remote input back onto it via applyPointer(),
// so the same widget appears — and is interactive — inside a
// Caffeine-drawn <morphic-window> mirror.
//
// Nothing here knows about Snowglobe; that decoupling is the point.

(function () {
    'use strict';

    if (customElements.get('snowglobe-demo-widget')) return;

    const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231',
                     '#911eb4', '#42d4f4', '#f032e6', '#ffe119'];

    class SnowglobeDemoWidget extends HTMLElement {
        constructor() {
            super();
            this._w = 320;
            this._h = 220;
            this._canvas = document.createElement('canvas');
            this._canvas.width = this._w;
            this._canvas.height = this._h;
            this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });

            // Bouncing ball → continuous display updates.
            this._ball = { x: 60, y: 60, vx: 2.1, vy: 1.7, r: 16 };
            // Persistent dots dropped by clicks → visible input feedback.
            this._dots = [];
            // Live crosshair follows the last pointer position.
            this._pointer = { x: this._w / 2, y: this._h / 2, down: false };
            this._colorIndex = 0;
            this._raf = null;
        }

        connectedCallback() {
            this.style.display = 'inline-block';
            this.style.lineHeight = '0';
            this._canvas.style.width = this._w + 'px';
            this._canvas.style.height = this._h + 'px';
            this._canvas.style.cursor = 'crosshair';
            if (!this._canvas.isConnected) this.appendChild(this._canvas);

            // Local interaction (when the source widget itself is on screen).
            this._onMove = (e) => this._pointerFromEvent('mouseMove', e);
            this._onDown = (e) => this._pointerFromEvent('mouseDown', e);
            this._onUp   = (e) => this._pointerFromEvent('mouseUp', e);
            this._canvas.addEventListener('mousemove', this._onMove);
            this._canvas.addEventListener('mousedown', this._onDown);
            this._canvas.addEventListener('mouseup', this._onUp);

            this._loop();
        }

        disconnectedCallback() {
            if (this._raf) cancelAnimationFrame(this._raf);
            this._raf = null;
            this._canvas.removeEventListener('mousemove', this._onMove);
            this._canvas.removeEventListener('mousedown', this._onDown);
            this._canvas.removeEventListener('mouseup', this._onUp);
        }

        // The drawing surface the Snowglobe producer captures.
        get canvas() { return this._canvas; }
        get windowTitle() { return this.getAttribute('title') || 'Demo Widget'; }

        _pointerFromEvent(type, e) {
            const rect = this._canvas.getBoundingClientRect();
            const sx = this._w / rect.width;
            const sy = this._h / rect.height;
            this.applyPointer(type,
                (e.clientX - rect.left) * sx,
                (e.clientY - rect.top) * sy);
        }

        // Apply a pointer event in widget-local canvas coordinates. This
        // is the entry point the producer calls with remote input coming
        // back from the Snowglobe mirror, and it's also used by the
        // local DOM listeners above.
        applyPointer(type, x, y) {
            x = Math.max(0, Math.min(this._w, x | 0));
            y = Math.max(0, Math.min(this._h, y | 0));
            this._pointer.x = x;
            this._pointer.y = y;
            if (type === 'mouseDown' || type === 'doubleclick') {
                this._pointer.down = true;
                this._dots.push({ x, y, color: PALETTE[this._colorIndex % PALETTE.length] });
                this._colorIndex++;
                if (this._dots.length > 200) this._dots.shift();
            } else if (type === 'mouseUp') {
                this._pointer.down = false;
            }
        }

        applyKey() { /* no-op for this demo; present for parity */ }

        _loop() {
            this._step();
            this._draw();
            this._raf = requestAnimationFrame(() => this._loop());
        }

        _step() {
            const b = this._ball;
            b.x += b.vx; b.y += b.vy;
            if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); }
            if (b.x + b.r > this._w) { b.x = this._w - b.r; b.vx = -Math.abs(b.vx); }
            if (b.y - b.r < 0) { b.y = b.r; b.vy = Math.abs(b.vy); }
            if (b.y + b.r > this._h) { b.y = this._h - b.r; b.vy = -Math.abs(b.vy); }
        }

        _draw() {
            const ctx = this._ctx;
            ctx.fillStyle = '#101828';
            ctx.fillRect(0, 0, this._w, this._h);

            // Clock so remote viewers can see it is live.
            ctx.fillStyle = '#9aa4b2';
            ctx.font = '12px monospace';
            ctx.fillText(new Date().toLocaleTimeString(), 8, 16);
            ctx.fillText('Snowglobe demo — click to paint', 8, this._h - 8);

            for (const d of this._dots) {
                ctx.beginPath();
                ctx.fillStyle = d.color;
                ctx.arc(d.x, d.y, 5, 0, Math.PI * 2);
                ctx.fill();
            }

            const b = this._ball;
            const grad = ctx.createRadialGradient(b.x - 5, b.y - 5, 2, b.x, b.y, b.r);
            grad.addColorStop(0, '#ffffff');
            grad.addColorStop(1, '#4363d8');
            ctx.beginPath();
            ctx.fillStyle = grad;
            ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
            ctx.fill();

            // Crosshair at the last pointer position.
            const p = this._pointer;
            ctx.strokeStyle = p.down ? '#f58231' : '#42d4f4';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(p.x - 8, p.y); ctx.lineTo(p.x + 8, p.y);
            ctx.moveTo(p.x, p.y - 8); ctx.lineTo(p.x, p.y + 8);
            ctx.stroke();
        }
    }

    customElements.define('snowglobe-demo-widget', SnowglobeDemoWidget);
})();
