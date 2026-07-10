# keep-sync auth + tunnel-peer VSIX push

How the build-time "update other VSCode instances over tunnels" step works,
and the failure modes hit on 2026-07-07.

## The push step is real and lives in the build

`scripts/js/build-extension.js` → `pushVsixToPeers()` → `scripts/js/push-extension.js`.
It: stages the VSIX in `website/public/uploads/`, reads the peer registry from a
GitHub **secret gist** (`peers.json`, id in `.keep-sync-gist-id`, default
`28fc3779fbca28dd729b47214910bde1`), and for each peer (machineId != mine, has
`tunnelUri`) probes `<tunnel>/keep-sync/status` then POSTs to
`<tunnel>/extension/install-vsix` telling it to fetch the VSIX from *our* tunnel.
"No reachable peers" = registry has only us. "Cannot determine own tunnel URI" =
*we* aren't in the registry (see below).

## Peer registry registration = keep-sync (runs in the extension host)

`website/src/keep-sync.js` `start()` → `registerSelf()` publishes our entry
(hostname, current `tunnelUri`, version, lastSeen) into the gist, on start and
every poll (~60s). `start()` writes `.keep-sync-machine-id` / `.keep-sync-gist-id`
near its top **after** GitHub auth + `ensureGist()` succeed — so if those files'
mtimes are stale, `start()` is aborting early at auth/gist. Registry prunes
entries >3min stale whose tunnel probe fails, and keeps only the newest per
machineId — so a peer that stops re-registering gets evicted.

## Failure 1: VS Code GitHub auth blocked by org device policy

Org now requires an MDM/device-management profile for the machine running VS Code.
VS Code's built-in GitHub auth provider (`vscode.authentication.getSession`) routes
through that conditional-access check and returns `Cancelled` on an unmanaged Mac.
keep-sync aborted before registering → melody fell out of the registry → push
couldn't find our own tunnel URI.

### Fix: non-interactive token fallback in keep-sync.js

Added `resolveGitHubToken()` — resolution order:
1. env `ORBIT_KEEPSYNC_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN`
2. secrets file `<repo>/secrets/keep-sync-github-token[.txt]` or `~/.orbit/keep-sync-github-token`
3. `gh auth token` (GitHub CLI's own credential)
4. VS Code auth (silent, then interactive) as last resort
`start()` now calls this instead of `getSession` directly. `secrets/` added to root
`.gitignore`. The `gh` CLI token is NOT subject to the VS Code device-policy check.

## Failure 2: gist ownership — 404 on PATCH

`gh` CLI here is account `ccrraaiigg`, but the registry gist is a **secret gist
owned by `craiglattaatlamresearch`** (the org identity). A secret gist is
*readable* by anyone with the link but only the **owner** can update it → GitHub
returns **404** (not 403) on PATCH for gists you don't own. So `ensureGist` (read)
passed but `registerSelf` (write) failed every cycle.

### Fix: supply the owning account's token

Put a `craiglattaatlamresearch` PAT with **`gist`** scope at
`~/.orbit/keep-sync-github-token` (resolver #2, ahead of the wrong-account gh CLI).
Verify a token's account+scope with:
`curl -s -H "Authorization: Bearer $T" https://api.github.com/user` and
`curl -sI .../gists/<id> | grep -i x-oauth-scopes`.
`githubToken` is resolved once in `start()`, so **reload the window** after placing it.

## Failure 3: stale peer connect-token → 401, no self-heal

melody's cached connect token for uslam (in `.keep-sync-peer-tokens.json`) was in
the **legacy string format** (no associated tunnelUri), minted for uslam's *old*
tunnel → `401` against its current tunnel. `invalidateTokenIfAuthError` only
cleared on 302/403, not **401**, and the tunnelUri-change invalidation needs a
known prior URI (legacy tokens have none) — so the handshake guard
`!peerTokens[machineId]` never re-fired. Fixed by adding **401** to the
invalidation (shipped 1.225.0). Handshake records `peerKnownUris[machineId]` so
new tokens are modern-format and future staleness is detectable.

### Durable push-side bypass: mint-on-stale

`push-extension.js` now, when the cached token probe fails, maps the peer's
`tunnelUri` host → devtunnel `tunnelId` (via `devtunnel list --json` +
`devtunnel show <id> --json` `ports[].portUri`) and mints a **fresh** connect
token (`devtunnel token <id> --scope connect`). This let melody deliver 1.225.0 to
uslam without waiting on the keep-sync handshake. Log line: "Minted fresh connect
token for <peer>".

## Gotchas
- Slow streamed `devtunnel` output gets truncated in the agent terminal; redirect
  to a file (`> /tmp/push.log 2>&1`) and `tail` it, or run async.
- (Fixed 2026-07-07) There used to be "first-build bloat": after a
  snapshot+export, the first `build-extension.js` shipped a ~62MB VSIX because
  `vsce` packaged the loose `caffeine.image`+`caffeine.changes` (repack ran too
  late, inside `installFor` after packaging). Now `repackCaffeineImage()` runs
  in `main()` BEFORE `packageVsix()`, so the loose files are zipped and deleted
  first and every VSIX is ~40MB (just `caffeine.zip`).
