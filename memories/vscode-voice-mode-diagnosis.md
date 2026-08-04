# VS Code Voice Mode vs Dictation — troubleshooting notes (2026-08-02)

- Dictation and Voice Mode use different pipelines. Dictation can run locally
  ("nemo" backend); Voice Mode always streams over a WebSocket to the MAI
  voice service.
- Voice WS endpoint comes from product.json `voiceWsUrl`
  (`wss://falcon-caas.mai.microsoft.com/voice-code/api/v1/realtime/voice`),
  overridable via the `agents.voice.backendUrl` setting. Auth is the VS Code
  GitHub session token appended as `?token=...`.
- Failure signature in `~/Library/Application Support/Code/logs/<session>/window1/renderer.log`:
  `[voice] ws closed abnormally (code=1006)` reconnect loop, then
  `connect handshake timed out; resetting voice mode`.
- Browser WebSockets report an HTTP 403 handshake rejection as close code 1006.
  Diagnosed 2026-08-02 on melody: server returned 403 in ~0.45s (matching the
  loop cadence) both with and without a GitHub token → server-side
  auth/entitlement rejection, not network/mic/local config.
- Testing tip: curl WS handshakes need `--http1.1` (curl silently drops
  Upgrade headers on HTTP/2 and you get a misleading 404).
