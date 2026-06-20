# MCP Apps UI resources (ui:// scheme)

VS Code (and Claude/Goose/ChatGPT) support **MCP Apps** (official MCP
extension, Jan 2026), gated by `chat.mcp.apps.enabled`. A tool renders
an inline sandboxed-iframe UI by:

1. Declaring `_meta.ui.resourceUri` (a `ui://` URI) on the **tool
   definition** in `tools/list`.
2. Serving that `ui://` resource over the MCP channel (`resources/read`)
   with `mimeType: text/html`.

An `http://localhost/...` URL does NOT work — the host fetches `ui://`
resources via the MCP channel, not arbitrary HTTP.

## Verified against VS Code source (main, June 2026)

- Setting key: `mcpAppsEnabledConfig = 'chat.mcp.apps.enabled'`
  (`src/vs/platform/mcp/common/mcpManagement.ts`). Registered in
  `chat.shared.contribution.ts` as `type: boolean`, **`default: true`**,
  tag `experimental`. So it's on unless explicitly disabled.
- Tool `_meta` parse: `mcpServer.ts._normalizeTool` does
  `const uiMeta = originalTool._meta?.ui; ... uiResourceUri: uiMeta?.resourceUri`
  — reads the **nested** `_meta.ui.resourceUri`. Our emitted shape
  matches exactly.
- Mount gate: `mcpLanguageModelToolContribution.ts`
  `McpToolImplementation.prepareToolInvocation` builds
  `mcpAppData: mcpUiEnabled && tool.uiResourceUri ? {...} : undefined`
  where `mcpUiEnabled = getValue('chat.mcp.apps.enabled')`. The
  `resources/read` fires lazily only when the App sub-part mounts
  (`mcpToolCallUI.ts loadResource`).
- No apps-specific server `initialize` capability is required — the
  `ui/*` JSON-RPC methods are a host↔guest-iframe protocol, separate
  from the MCP server. Existing resources/tools capabilities suffice.
- **Why our AccessLog stayed empty**: the native mount path lives in
  VS Code's LM-tools tool-invocation renderer. In the GitHub Copilot
  Chat / agent-host (Copilot SDK) surface there's a known SDK gap —
  `_meta.ui.resourceUri` isn't surfaced at `tool.execution_start`, so
  the App webview isn't mounted at call time and no `resources/read`
  is issued. Server is correct; the limitation is client-side in this
  surface. The same tool invoked from VS Code's native chat agent
  would fetch the resource and render.
- Cross-host robustness: `LamMCPEvaluateTool class>>toolMeta` now emits
  BOTH the nested `ui: {resourceUri}` (VS Code) AND the flat
  `'ui/resourceUri'` key (ext-apps canonical wire form for
  Claude/Goose/ChatGPT). Verified JSON:
  `{"ui":{"resourceUri":"ui://orbit/progress"},"ui/resourceUri":"ui://orbit/progress"}`.

## DECISIVE: two client mount paths in VS Code 1.125.0 (verified in the installed bundle)

Confirmed `chat.mcp.apps.enabled`, `mcpAppData`, `uiResourceUri`, and the
mount UI all EXIST in 1.125.0 stable (`workbench.desktop.main.js`). The
server descriptor is correct end-to-end (bridge forwards `_meta`
verbatim; `_normalizeTool` reads nested `e._meta?.ui.resourceUri` into
`uiResourceUri`). Yet the AccessLog stays empty because there are TWO
mount paths and this surface uses the one we can't satisfy:

- **Path 1 — native LM-tools** (`McpToolImplementation.prepareToolInvocation`):
  `mcpAppData = getValue('chat.mcp.apps.enabled') && tool.uiResourceUri
  ? {kind:'local', resourceUri, ...} : undefined`. Needs ONLY the
  setting + our descriptor's `uiResourceUri`. Our server already
  satisfies this. Used by VS Code's built-in chat agent.
- **Path 2 — agent-host / Copilot SDK** (minified `sjo`, builds
  `toolInvocationSerialized`): requires `a.contributor.kind==='mcp'`
  AND `a._meta.ui.resourceUri` AND a non-empty **`a._meta.ui.channel`**,
  returning `{kind:'agentHost', resourceUri, serverId, channel}`. The
  `channel` is an AHP transport handle the Copilot SDK/host attaches to
  the tool-EXECUTION event — NOT emitted by the MCP server. No server
  change can supply it.

This chat panel runs under the `GitHub.copilot-chat` extension. Both
paths read the **nested** descriptor `_meta.ui.resourceUri`; our server
emits it correctly (bridge forwards `_meta` verbatim).

## ACTUAL ROOT CAUSE (per the user): stale client tool list

The empty AccessLog was NOT a host-side gap and NOT a long-vs-short-eval
distinction (both of my earlier theories were wrong). The MCP client had
cached `tools/list` from *before* `toolMeta`/`_meta` was added this
session, so its `tool.uiResourceUri` was undefined and no app mounted.

The fix that actually worked: **restarting VS Code**. On restart the MCP
client reconnected to the server and re-fetched `tools/list`, becoming
aware of the `ui://orbit/progress` resource on the tool descriptor.
After that, `(Delay forSeconds: 10) wait` logged **two** reads of
`ui://orbit/progress` and the progress app rendered.

Key lesson: an in-session `LamMCPService>>notifyToolsChanged`
(`notifications/tools/list_changed`) did NOT cause this client to refresh
`uiResourceUri` — only a full reconnect (VS Code restart) did. So when
you add/change a tool's `_meta.ui.resourceUri`, expect to restart VS
Code (or otherwise force a client reconnect) before the App webview picks
it up.

## Why the notification didn't work: VERIFIED — no open SSE GET stream (NOT a VS Code bug, NOT a bridge)

VS Code 1.125.0 DOES respect the notification — its bundle has
`case "notifications/tools/list_changed": this._onDidChangeToolList.fire()`,
which drives a `tools/list` re-fetch via `onDidChangeTools`. So the
client is not ignoring it.

CORRECTION — the **2300-ui** server has NOTHING to do with `mcp-bridge.js`
or tethers (that's the Caffeine/SqueakJS page transport). VS Code reaches
2300-ui through `website/src/mcp-proxy.js`, a transparent local HTTP
proxy:
`VS Code → http://localhost:<proxyPort>/mcpservice/v1/mcp → (TCP pipe,
forwards SSE verbatim) → <LAN host>:<mcpPort>` = the VW image's own MCP
server. The proxy only rewrites `serverInfo.name` + OAuth origins.

So the notification transport IS the VW image's own SSE `tasks`:
`LamMCPRequestProcessingPolicy>>sendToolsListChangedNotification` writes
SSE `data:` frames to each `task connection stream`, and (via the
transparent pipe) those `tasks` ARE VS Code's connections.

VERIFIED cause: VS Code does NOT hold an open SSE GET stream. The policy
ivar `tasks` (a Dictionary, keyed by sessionID → task, the SSE session
registry) was measured **size 0 while VS Code was actively driving the
2300-ui server** (mid-conversation `evaluate` tool calls). So VS Code's
MCP client talks to this server via POST request/response only and never
opens the GET SSE channel the server's `initialize` asks for. With
`tasks` empty, `sendToolsListChangedNotification` (`tasks keysAndValuesDo:`,
logs "Sent ... to <tasks size> session(s)") delivers to 0 sessions and
the notification is silently dropped. A restart "fixes" it only because
reconnect re-runs `tools/list` over the POST request path.

How to measure: `instVarNamed:` is NOT understood in this VW image — use
`policy instVarAt: (policy class allInstVarNames indexOf: 'tasks')`.
`sseChannelMonitor` is just a cleanup Process, not a stream registry;
`resourceSubscriptions` was also size 0. Find the policy via
`(LamMCPService allInstances detect: [:s | s apiPolicies notEmpty])
apiPolicies detect: [:p | p isKindOf: LamMCPRequestProcessingPolicy]`.

## How it's wired in the Snowglobe VisualWorks image

- **`LamMCPProgressResource`** (subclass of `LamAbstractMCPResource`,
  Snowglobe pkg) is the progress app for the long-running `evaluate`
  tool. Class-side `uri`/`resourceName` both return
  `'ui://orbit/progress'` (resourceName == uri so
  `LamMCPService>>handleResourceRead:` finds it by *direct* dict lookup;
  `withURIPatternMatching:` would NOT match a ui:// uri otherwise).
  Class-side `progressHTML` holds the HTML; instance-side
  `handleRead:with:` returns `{uri, mimeType, text}`.
- Tool-declaration `_meta`: added a class-side `toolMeta` hook on
  `LamAbstractMCPTool` (returns nil by default); `addMetadata:` emits
  `_meta` only when `toolMeta` is non-nil.
- **The App is declared on `LamMCPEvaluateStatusTool class>>toolMeta`,
  NOT on `LamMCPEvaluateTool`.** Rationale: VS Code mounts the App
  card for EVERY call of a tool whose descriptor declares
  `uiResourceUri` — there is no per-call/per-result host gate, so
  attaching it to `evaluate` showed an (empty, black) card even for
  fast evaluations, which content-hiding inside the iframe could not
  remove (the card frame defaults to 300px and is VS Code chrome).
  The agent only calls `evaluateStatus` to poll an in-progress
  evaluation, so attaching the App there means a card appears ONLY for
  genuinely long-running evals. `evaluate`'s `toolMeta` was removed
  (inherits nil). `evaluateStatus`'s `toolMeta` returns both
  `{ui: {resourceUri: LamMCPProgressResource uri}}` (nested, for VS
  Code) and a flat `'ui/resourceUri'` key (for other hosts).
- The App controls its own card height: it sends
  `ui/notifications/size-changed` `{height: N}` and the host applies it
  (`_handleSizeChanged`; default height is `heightCache.get(...)??300`).
  `progressHTML` reports `#content offsetHeight` so the card is snug.
- `LamMCPEvaluateTool>>handleCall` timeout branch calls
  `meta: LamMCPProgressResource uri describedBy: '...'` (was the http URL).
- Resources auto-register on restart via
  `LamMCPSite class>>mcpSiteDefault` → `allResourceClasses`
  (`allConcreteClassesUnder: LamAbstractMCPResource`, leaf classes with
  non-nil resourceName). To register into the **live** service without a
  restart: `service addResource: LamMCPProgressResource new` (fires
  `resources/list_changed`). Find it via
  `LamMCPService allInstances detect: [:s | s apiPolicies notEmpty]`.
  The HTML lives solely in `LamMCPProgressResource class>>progressHTML`
  (served at `ui://orbit/progress`); there is no website mirror — the
  old `website/public/apps/progress.html` was unused and deleted.

## One card per evaluation: status tool (no card) + its card subclass

Because VS Code mounts a card for EVERY agent call of a tool whose
descriptor declares `uiResourceUri`, an agent that *polls* the
card-mounting status tool spawns a new card per poll. To keep exactly
one card per long-running evaluation, the work is split across two tools
that return the **identical** status payload (both via
`LamMCPEvaluateTool statusDictForTaskId:`). After a 2026-06-18 refactor
they form an inheritance pair (was two sibling classes
`LamMCPEvaluateProgressTool` / `LamMCPEvaluateStatusTool`):

- **`LamMCPTaskStatusTool`** — wire name **`evaluateProgress`**, the
  shared **base** and the **no-card** tool. Holds the common
  `handleCall`, `handleCall:with:`, `toolInputSchema`, `toolAnnotations`,
  plus `toolName`/`toolTitle`/`toolDescription`. Defines **no**
  `toolMeta` (inherits nil from `LamAbstractMCPTool` → no `uiResourceUri`
  → never a card). The agent polls this as often as it likes without
  adding cards.
- **`LamMCPCreateTaskProgressAppTool`** — wire name **`evaluateStatus`**,
  a **subclass of `LamMCPTaskStatusTool`**. Overrides only `toolName`,
  `toolTitle`, `toolDescription`, and adds **`toolMeta`** declaring the
  `ui://orbit/progress` App (both nested `ui:{resourceUri}` and flat
  `'ui/resourceUri'`). Invoking it surfaces the card. Call it EXACTLY
  ONCE per long-running eval; the card's iframe then polls
  `evaluateStatus` *internally* via host `tools/call` (App-originated
  sub-calls do NOT add conversation cards).

Refactor mechanics that bit us:
- Rename classes in-image with `aClass renameTo: #NewName` (proper
  namespace rename; `rename:` is the obsolete alias). Reparent by
  re-sending `Super subclass: #Name instanceVariableNames: '' ...`. Then
  `removeSelector:` the now-duplicated methods so they inherit.
- **`allToolClasses` leaf-only trap:** `mcpSiteDefault` registers tools
  via `LamMCPService allToolClasses`, which was
  `allConcreteClassesUnder: LamAbstractMCPTool` — and that returns ONLY
  **leaf** classes (convention: "non-leaf classes are never
  instantiated", e.g. abstract `LamMCPAddMethodBase`). Making a concrete
  tool (`LamMCPTaskStatusTool`) a non-leaf meant it would silently fail
  to auto-register on a cold rebuild. Fix: override `allToolClasses` to
  return every `LamAbstractMCPTool withAllSubclasses` whose `toolName` is
  non-nil, guarding `[c toolName notNil] on: Error do: [:e | false]`
  because abstract bases answer `toolName` with `subclassResponsibility`
  (it RAISES, not nil). Verified the new set == old set + exactly
  `LamMCPTaskStatusTool`.

As with any new tool / descriptor `_meta` change, VS Code needs a
reconnect (window reload) before the agent can call a newly-added tool,
and the user may need to enable it in the tool list.

## The in-progress evaluate result must NOT carry `_meta.ui` (empty-card regression)

`LamMCPEvaluateTool>>reportInProgressTaskId:` originally emitted a result
dict with `_meta.ui.resourceUri = ui://orbit/progress` (plus nested
`content`/`structuredContent`). This was vestigial once the card moved to
the `evaluateStatus` descriptor — and then turned actively harmful: once
the client knows the `ui://orbit/progress` resource, a tool *result*
carrying `_meta.ui.resourceUri` makes the host try to render an App card
for the **evaluate in-progress** response, which renders **empty**
(suppressing the "still in progress" text). The user then reverted
`LamMCPService>>handleToolCall:` to drop ALL `_meta` handling — it now
returns just `{content: contentCollection, isError:}`. With that revert,
`reportInProgressTaskId:` adding a raw dict via `results add:` produced a
malformed content item (keys `content`/`structuredContent`/`_meta`
instead of `type`/`text`) → still empty. Fix: rewrite
`reportInProgressTaskId:` to use `self result:` with a plain dict
`{status:'running', taskId:, message:}` and NO `_meta`/nested content, so
`self result:` wraps it as a proper `{type:text, text: <json>}` item.
Lesson: emit progress UI ONLY via the tool **descriptor** `toolMeta`,
never via per-call result `_meta`.

## Compile-tool gotchas (LamMCPCompileTool)

- It resolves `behavior` via `agent objectForReference:`, which is
  **tether-stateful**. `expose:` of any Behavior returns a reference; the
  decode depends on the agent tether holding the last-exposed object.
  Discipline: `evaluate "TheClass"` (instance side) or
  `evaluate "TheClass class"` (metaclass) **immediately before**
  compiling that side, with no intervening `evaluate` (each evaluate
  re-exposes its result and mutates the tether). Compile calls only
  `tether copy`, so multiple compiles after one expose stay on-target.
  Symptom of getting it wrong: an instance method lands class-side.
- The compile tool hardcodes `classified: 'generated'` and ignores the
  `category` param. Restore protocols afterward with
  `Class organization classify: #sel under: 'protocol'`.
- `evaluate` for class creation: VW uses
  `super subclass:#N instanceVariableNames:'' classVariableNames:''
  poolDictionaries:'' category:'...'` (no `package:` keyword — that
  DNUs). Then `moveClassToPackage` to 'Snowglobe'.
