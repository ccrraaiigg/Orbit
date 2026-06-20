# 2300-ui OAuth/DCR debugging notes

## DCR bug fixed 2026-05-12
`LamMCPRequestProcessingPolicy>>oauthregister_v1_post:` was reading the body
via `requestParameters request contents asString readStream` and feeding it to
JSONDecoder. The Swazoo framework had already consumed the body and parsed it
into `requestParameters arguments`, so the manual re-read got nothing, the
JSONDecoder threw, the rescue swallowed it as `Dictionary new`, and
`redirect_uris` defaulted to `#()`. RFC 7591 §3.2.1 requires the registration
response to echo back all client metadata; VS Code's MCP client validates this
echo and refused DCR when `redirect_uris` came back empty.

Fix: read fields from `requestParameters arguments` (same pattern as
`mcp_v1_post:`).

## Bearer enforcement toggle
`LamMCPRequestProcessingPolicy class>>bearerEnforcementEnabled:` controls
whether the policy short-circuits to the parent (no auth) or enforces
bearer tokens. Currently TRUE on 2300-ui after DCR fix.

## OAuth probe script
`/tmp/orbit_oauth_probe.py` — Python end-to-end probe (DCR → PKCE →
authorize → token → authenticated MCP initialize). Use this instead of
shell heredocs because tcsh mangles bash quoting.

## Endpoints (2300-ui at 192.168.1.140:15070)
- Issuer: `/mcpservice`
- AS metadata: `/mcpservice/.well-known/oauth-authorization-server`
- PRM: `/mcpservice/.well-known/oauth-protected-resource`
- DCR: `/mcpservice/v1/oauthregister`
- Authorize: `/mcpservice/v1/oauthauthorize`
- Token: `/mcpservice/v1/oauthtoken`
- MCP: `/mcpservice/v1/mcp`

Root-level `/.well-known/...` returns 404 (only issuer-path served). MCP
client falls back to issuer path via WWW-Authenticate `resource_metadata=`
hint, so root 404 is non-fatal warning.
