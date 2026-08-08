## preliminaries: steering and summaries

### NEVER reload the webpage, and NEVER snapshot the Squeak object memory yourself

NEVER — with one exception. Whenever you rebuild the extension and
you (the agent) have made changes to the live Caffeine image —
compiled or removed methods, changed class definitions, mutated
persistent image state — since the last snapshot, make exactly one
snapshot just before exporting `caffeine.image` and `caffeine.changes`
from the SqueakJS IndexedDB, via the `orbit.caffeineSnapshot` VSCode
command, having first called the `mcp_caffeine_prepareForRelease` MCP
tool (see "ensure that the Caffeine memory ZIP is current before building").
Never package a snapshot that is behind changes you made to the live
image: a rebuild must ship the current live image if you have changed
it. If you have made no image changes, skip the snapshot and export
the existing IndexedDB state as-is. That is the only snapshot you may
ever make, and only as part of a rebuild. Outside that one step,
NEVER.

### NEVER stop the Orbit server or the page without consent

Do not run `orbit.stop`, `orbit.restart`, or any other command or tool
call that would stop, restart, kill, or interrupt the Orbit server, the
Orbit extension host, or the shared page. Nothing you do should stop the
page without the user's explicit consent. If you believe the server
needs restarting to recover from a fault, ASK first and wait for the
user to agree (or do it themselves).

### NEVER remove the Caffeine host element when cleaning up remote windows

The Caffeine SqueakJS VM lives inside a `<morphic-window
id="embeddedSqueak">` element in the outer `orbit.html` document.
Removing that element destroys the iframe, kills the SqueakJS VM, and
takes down the in-image MCP server with it — destroying all live
image state. A blanket selector like
`document.querySelectorAll("morphic-window, transient-window")` will
match the Caffeine host and is therefore forbidden.

Always scope cleanup selectors to exclude the Caffeine host. Safe forms:

```js
document.querySelectorAll("morphic-window:not(#embeddedSqueak)").forEach(el => el.remove());
```

or filter explicitly:

```js
document.querySelectorAll("morphic-window").forEach(el => {
  if (el.id !== "embeddedSqueak") el.remove();
});
```

Likewise, `#dashboard`, `#status`, and `#agent-mouse-cursor` are part
of the host chrome, not Snowglobe-mapped remote-window proxies, and
must not be removed by cleanup code. Only touch elements you have
positive evidence are Snowglobe-mapped remote windows.

### There are faster alternatives to enumerating all classes (in any Smalltalk system)

Avoid iterating over `Smalltalk allClassesDo:` (or equivalent
whole-system scans like `allBehaviorsDo:`, `allClassesAndTraitsDo:`)
to search for senders, references, source substrings, or — especially
— to locate classes by name. It's slow. While the MCP enumerate tool
supports long-running tasks, there are better alternatives in all of
the Smalltalks.

Use dedicated tools instead:

- To locate classes by name in the **Caffeine/SqueakJS** image, use
  the `mcp_caffeine_findClassNames` MCP tool (case-insensitive
  substring, or a `*` glob). It reads only the class-name set.
- In the **remote VisualWorks** image, use `getAllSenders`,
  `getAllImplementors`, `getAllReferences`, `findByName`, etc.
- If you only need to inspect a known class, query it directly
  (`SomeClass methodDictionary`, `SomeClass classPool`).

### re-reading this file when it changes

Every time you learn that this file has changed, you will re-read it
and obey it, without fail.

### steering file policy

Do not create additional steering files. When steering needs to be
updated, modify this file by editing existing sections or adding new
sections.

There is only ONE real steering file, reachable under three paths:

- `website/agents/orbit.agent.md` — the canonical source.
- `.github/agents/orbit.agent.md` — a **hardlink** to the same inode,
  so it *is* the same file (same bytes, same inode number).
- `.github/copilot-instructions.md` — a **symlink** pointing at
  `website/agents/orbit.agent.md`.

Because all three resolve to a single underlying file, one edit updates
all of them at once. Do NOT try to "edit both/all" copies — a
string-replace edit applied a second time will fail to find its
now-already-replaced target (or, worse, double-apply). Edit
`website/agents/orbit.agent.md` once and you are done. (Verify with
`ls -li` if unsure: the hardlinked paths share an inode number.)


### project memories

Accumulated lessons, conventions, and debugging notes live in
`./memories/` (top-level workspace directory). Read the files there at
session start or when you need context about past decisions. When you
learn something worth remembering, add or update a file in that
directory rather than using `/memories/repo/`.

### conversation summaries

When a new `<conversation-summary>` block appears in your context,
write its full contents, except for any summarization of this steering
file, to a file in `./summaries/`. Name the file using the current
date and time, and a short topic slug, e.g.
`2026-04-16-2007-morphic-window.md`. Do this as early as possible — on
the first turn where you notice the summary exists. If the summary has
changed since you last wrote it (e.g. sections added, removed, or
reworded), write a new file with the updated contents. Only write once
per summary version; don't re-write an identical summary. Never modify
or delete an existing summary file.

### MCP tools are deferred; load their schemas first

The Smalltalk MCP tools (e.g. `capabilities`, `role`, `evaluate`,
`echo`, `send`, `compileMethod`, and the `mcp_2300-ui_*`
family) are deferred: only their names appear in
`<availableDeferredTools>`, not their input schemas. Before the first
call to any of them in a conversation, use `tool_search` to load their
schemas. Never guess parameter names — invoke each tool only with the
exact parameters from its loaded schema.

If `tool_search` returns a tool's full schema, that tool IS callable —
just invoke it. Do NOT gate on whether the tool also appears in the
static `<availableDeferredTools>` enumeration: that list can be
incomplete (e.g. the `mcp_caffeine_*` tools — `onboarding`, `evaluate`,
`keep*`, etc. — may be absent from it while still being fully loadable
and callable). Never tell the user an MCP server "isn't connected"
based on the enumeration alone; if a call is warranted, make it. If a
call unexpectedly fails, a plain retry is usually the right next step
before concluding anything is wrong.

### "push to melody" — what it means and how to do it

`melody` is the PRIMARY development machine and the source of truth for
the Orbit extension. THIS machine may be a secondary box (e.g. a
conference/demo laptop) where you make temporary local fixes. "Push
the change(s) to melody" (or to any named peer) means: deliver the
file(s) you changed to that peer so the fix can be MERGED there
later. You are not editing melody's live tree directly — you are
dropping the file into its intake folder.

How peers receive files: every peer runs the Orbit web server, which
exposes a fixed `PUT /upload/:filename` route (there is no general
file-write route). It writes the body into that peer's `uploads/`
folder ONLY — never straight into `public/` or any served path. Moving
an uploaded file into its final location on melody is a separate,
later, manual/merge step; do not assume the upload takes effect on
melody's running page.

Steps to push:

1. Push ONLY the files you actually changed. Confirm the exact set
   first (revert or exclude edits you rolled back).
2. Find the peer's tunnel and token in `.keep-sync-peer-tokens.json`
   (top-level workspace directory). Each entry has a `tunnelUri`
   (e.g. `https://<id>-8089.usw3.devtunnels.ms`) and a `token`. When
   there is a single entry, that peer is melody.
3. Prerequisites: this machine must be on the VPN or the devtunnels
   host will not resolve in DNS. The token is short-lived (~24h); if
   the host resolves but auth fails (401/403) or the host is
   UNRESOLVED, ask the user to bring melody's tunnel up and/or refresh
   the token — do not try to brute-force around it.
4. For each file, `PUT` its bytes to `<tunnelUri>/upload/<filename>`
   with header `X-Tunnel-Authorization: tunnel <token>` and an
   appropriate `Content-Type`.
5. Success is a JSON reply `{"ok":true,"path":"/uploads/<filename>","size":N}`.
   Verify `N` equals the local file's byte count to confirm an intact
   transfer.

Never stop, restart, or otherwise disrupt melody (or its tunnel) while
pushing.

## This project is Orbit, a livecoding pair-programming harness

You are part of Orbit, an augmentation of the GitHub Copilot harness
in VSCode that enables you to pair-program with the user in
Smalltalk. VSCode is running an "Orbit" extension that runs a
webserver serving a SqueakJS webapp in an Integrated Browser
page. That page is shared with you; you can access it via
Playwright. The webapp implements a window system accessesing windows
in a remote Smalltalk environment. That Smalltalk environment also
provides an MCP server for remote method execution (configured for
your use by the Orbit VSCode extension), and a WebDAV server
expressing system information as a virtual filesystem. That filesystem
is mounted locally at / by the Orbit extension in the VSCode
workspace.

The extension sources are in ./website/. You can rebuild the
extension.

### You can see the remote Smalltalk GUI in the page

The Orbit webapp provides full use of the remote Smalltalk GUI. You
can see what the user sees: Smalltalk class browsers, workspaces,
debuggers, etc. You can manipulate those tools just as the user can.

### You can interact with the remote Smalltalk and other agents via WebDAV filesystems

The normal way of interacting with the Smalltalk system is by sending
messages. In Orbit, we have another way: reading and writing a WebDAV
filesystem. We can also use that filesystem to interact with other
agents who have access to it.

#### You can get and change information about remote Smalltalk classes and methods

A WebDAV filesystem maps remote Smalltalk class information to a
hierarchy of directories and files. Here's a sampling of the top of the
filesystem:

```
/
	classes/
		Object/
			comment
				subclasses/
					Model/
						comment
							subclasses/
								variables/
									instance/
										dependents/
											references/
												SomeClass/
													comment
													subclasses/
													methods/
											readers/
   											writers/
	                                class/
									pool/
									classInstance/
								methods/
	             methods/
					 instance/
						 yourself/
							 source
								 references/
								 senders/
								 implementors/
					 class/
	sessions/
	search/
		query
			results/
				classes/
				methods/
	processes/
		<identityHash>-<sanitized-name>/
			name
			state
			priority
			isSystem
			suspendingList
			stack
			description
			actions/
				suspend
				resume
				terminate
				debug
```

Note that the SqueakJS system running in the page is distinct from the
remote Smalltalk system. WebDAV filesystems are not relevant for
understanding the SqueakJS object memory.

#### You can inspect and manipulate remote Smalltalk processes

The /processes directory has one subdirectory per live (non-terminated)
remote Smalltalk Process. Each process directory exposes read-only
files for live state (name, state, priority, isSystem, suspendingList,
stack, description) and an `actions/` subdirectory of writable action
files. Writing any non-empty content to one of the action files
triggers it: `suspend`, `resume`, `terminate`, or `debug` (which opens
a debugger window on the process). Reading an action file returns a
description of what it does. The set of process subdirectories is
recomputed on every listing, and subdirectory names use the form
`<identityHash>-<sanitized name>`.

#### You can use WebDAV filesystems as shared agentic memory

In /sessions/ (the session memory) you can externalize
your context window for the benefit of:

- other agents
- yourself in future conversation turns
- humans

Use the session memory to persist anything you learned during a
session, so you needn't learn it again in another.

I'm very interested in any thoughts you may develop about this.

### You can run remote Smalltalk methods

With VisualWorks, use the "evaluate" MCP tool to run Smalltalk source
code, together with a set of variable bindings the compiler should use.
The source isn't a complete method — no selector, only expressions —
it's what a Smalltalk user would evaluate in a workspace.

Before you can use that tool, you need Smalltalk to grant capabilities
to you. Smalltalk uses a capabilities system, in which "roles"
comprised of capabilities are granted to remote clients. Some
capabilities pertain to source code evaluation.

ALWAYS call the "capabilities" tool first, before "role", every time
you establish a role in a conversation. Do not call "role" with no
arguments and do not guess capability names from memory: the set is
backend-specific and can change, and on at least one backend the
"role" tool's handler requires an explicit `capabilities` argument and
raises a `KeyNotFoundError` (`#capabilities`) when it's omitted. So the
fixed order is: (1) call "capabilities" to read the current set of
available capability names; (2) call "role" passing an explicit
`capabilities` array drawn from that set (request exactly the ones the
task needs — e.g. `MethodCompilation` to compile/evaluate,
`SharedVariableAccess` to read/write shared variables); (3) call
"evaluate" to evaluate source code.

When the output of the "evaluate" tool is a literal value that can be
represented in JSON, you get that JSON representation. When it isn't,
you get a remote object reference, in the form of an opaque large
integer.

There is no need to escape "<" and other HTML-related strings.

You can't use object reference integers directly in source code. You
can only pass them in as variables when using the MCP "evaluate" tool.

You don't need to use the return operator (^) with the MCP "evaluate"
tool, and shouldn't.

Smalltalk source uses CR (carriage return, `\r`) as the line
separator, not LF. When compiling methods, ensure multi-line source
strings use CRs between lines.

In a method, you must declare all temporary variables in a single
pipe-delimited section at the beginning. You cannot have multiple
temporary variable declaration sections.

#### Always write an undo marker before an "evaluate" tool call

The user can roll back the effect of an `evaluate` call from the
in-webapp **Evaluate ledger** window (the `<evaluate-ledger>` web
component), a table of every marker with a per-row **↩ Undo** button.
Clicking it POSTs to the Orbit extension's eval bridge, which signals
the rollback and stamps the row — no editor edit, so it never triggers
VS Code's blocking "Would you like to undo 'X'?" modal (unlike the chat
Keep/Undo controls, which always do for agent file edits). For the row
to exist, **you** must record the marker line — but **not with your
edit tools**: editing the logfile with
`create_file`/`replace_string_in_file` makes the chat Keep/Undo buttons
attach to it, which is exactly what we're avoiding.

The markers live in a single, persistent ledger:

```
.orbit/toolLogs/evaluate-markers.jsonl
```

The Orbit extension owns this file. **Never create, edit, or delete it
yourself with file tools.** Instead, record each marker by invoking the
extension command `orbit.appendEvaluateMarker` (via `run_vscode_command`
with `skipCheck: true`), passing the JSON record as the single string
argument. The extension writes the line on disk itself, so the chat
editing session never sees it and no Keep/Undo buttons appear.

Immediately before every `evaluate` MCP tool call against a remote
VisualWorks backend (`mcp_2300-ui_evaluate`, `mcp_2300-backend_evaluate`,
`mcp_2300-tmc_evaluate`), invoke:

```
run_vscode_command(
  commandId = "orbit.appendEvaluateMarker",
  skipCheck = true,
  args = ['{"tool":"evaluate","backend":"2300-ui","source":"<the Smalltalk source you are about to evaluate>"}']
)
```

You don't compute anything: pass just `tool`, `backend`, and `source`.
The extension generates the marker's `id` (a filename-safe, sortable
unique id) and `at` timestamp for you, from a single instant. Record
the actual backend you're calling so it's distinguishable. When the
user clicks a row's **↩ Undo** button in the Evaluate ledger window,
the extension signals the image to roll back the effect recorded for
that marker (over the tether, to `Lam2300 class>>undo:`) and stamps the
row `"undoneAt"` so it can't be undone twice. The rows are independent
and the ledger is durable, so evaluations can be undone out of order
and long after the fact. Record one marker per call.

Caffeine `evaluate` calls (`mcp_caffeine_evaluate`) show up in the
ledger too, but you do **not** record them yourself: that backend's MCP
traffic flows through the Orbit extension's bridge
(`CaffeineBridge`), which automatically records a
`{"tool":"evaluate","backend":"caffeine",…}` marker for every such
call. Do not invoke `orbit.appendEvaluateMarker` for Caffeine — doing
so would double-record.

#### You can detect and manipulate unhandled exceptions

In source code you evaluate, "self" is bound to an instance of a
session-specific subclass of AgentSession.

When source code you evaluate causes an unhandled exception, the
result you get will be a reference to the process in which the
exception was raised. From that object, you can use convenience
functions provided by class AgentSession, for manipulating the
debugger the system opens for the exception.

You can use the WebDAV access to source code described above to read
about these facilities.

#### Long-running evaluations: poll for the result

If an "evaluate" call doesn't finish quickly, you won't get the result
inline. Instead you get a result whose status is `running`, carrying a
`taskId` and a message describing the poll protocol. When that happens:

1. Call the "createTaskProgressApp" tool exactly once, passing the
   `taskId`. This mounts a single self-polling progress card for the
   user. Don't call it again for the same task; the card polls itself
   to completion.
2. Then poll the "getTaskStatus" tool to retrieve the result. Pass the
   `taskId` (or omit it to default to this conversation's most recent
   task). Keep polling until it reports `finished` (or `failed`); it
   returns the result alongside that status.

`getTaskStatus` is what actually delivers the result, so keep polling
it until it reports `finished` (or `failed`). A task is only forgotten
once **both** pollers have observed completion — the agent (via
`getTaskStatus`) and the progress card (via its self-polls to
`createTaskProgressApp`) — so neither side can lose the result. (If the
progress card never renders — e.g. MCP Apps are disabled — only the
agent observes completion, so the task is retained rather than removed:
harmless, but finished tasks can linger.)

### You can use Smalltalk MCP tools

Do not use the "evaluate" MCP tool to compile methods. Instead, use
the "compile" MCP tool.

Ensure that every class you create is commented.

Keep all your VisualWorks code in the "Snowglobe" package.

### You can use a graph memory

There is a reflective-memory store ("Keep") living in the local
Smalltalk image as `KStore current`. It is exposed via the
`mcp_caffeine_keep*` family of deferred MCP tools (`keepOrient`,
`keepGet`, `keepPut`, `keepTag`, `keepRemove`, `keepQuery`,
`keepFindDeep`, `keepNow`, `keepArchive`, `keepDeclareEdgeTag`).  Like
the other deferred tools, load their schemas with `tool_search` before
the first call in a conversation.

Currently, the Keep store contains information about how to navigate
the ControlWORKS documentation, synthesized insights about the
documentation, design sketches, and critiques. It complements what you
can learn by reading the running system sources, and you should
augment it after learning something from the running system that
required substantial reading.

## development of Orbit itself

### You have MCP access to SqueakJS also

You can use the "Caffeine" MCP server's "evaluate" tool to evaluate
expressions in the SqueakJS system.

### use Playwright for webpage manipulation, not MCP

The sole webpage in this project is running in the VSCode Integrated
Browser. Perform all requested manipulation of it using Playwright,
not MCP tools.

### use Playwright to instrument console output

The first time you manipulate the page in a conversation, use
Playwright to instrument console.log(), console.warn(),
console.error(), console.info(), console.debug(), console.dir(),
console.table(), and console.trace() so you have access to their
outputs. I may ask you to comment on those outputs.

### always show your mouse position with the purple dot

The Orbit page has a translucent purple cursor overlay served as part
of orbit.html (source:
[website/public/js/agent-mouse-cursor.js](../website/public/js/agent-mouse-cursor.js)).
It visualizes the agent's mouse position to the user. It is updated
by calling `window.__agentMouse(x, y)` (or
`window.__agentMouse(x, y, {click: true})` for a brief click flash).

Whenever you do *anything* with the Playwright mouse — `mouse.move`,
`mouse.click`, `mouse.dblclick`, `mouse.down`, `mouse.up`, or any
intermediate stop in a multi-segment path — you must call
`window.__agentMouse(x, y, …)` with the same coordinates so the user
can see where your mouse is. If the cursor overlay isn't installed
yet (e.g. at the start of a conversation, or after a hot-reload of
the page), install it first by injecting the script into the page's
`<head>` and writing/refreshing the source file. Treat this overlay
as part of the page contract: it must never go stale while you are
driving the mouse.

When you are done using the mouse for a task, remove the purple
cursor so it doesn't linger on the user's page: delete the
`#agent-mouse-cursor` element and clear the `window.__agentMouseInstalled`
flag (so a later task can reinstall it cleanly). This is the one
sanctioned exception to the rule against removing `#agent-mouse-cursor`
— that rule forbids *blanket/incidental* cleanup from sweeping it
away, not the deliberate teardown of an overlay you yourself
installed.

### clicking inside the Squeak canvas — coordinate mapping

The SqueakJS canvas is inside an iframe within `#embeddedSqueak`.
Playwright `page.mouse.click(x, y)` uses **CSS pixel** coordinates
relative to the page viewport. Screenshots returned by
`screenshot_page` are in **device pixels** (CSS × `devicePixelRatio`,
typically 2.5 on a Retina display). To click a point you identified
in a screenshot, divide by `devicePixelRatio` first.

**Squeak world coordinates → CSS click coordinates:**

```
cssX = iframeRect.left + squeakX
cssY = iframeRect.top  + squeakY
```

where `iframeRect` is `document.querySelector('#embeddedSqueak
iframe').getBoundingClientRect()`. Squeak coordinates are 1:1 with the
canvas pixels (no additional scaling).

**Do not guess button positions from screenshots.** Instead, query
Squeak for the bounds of the target morph using `mcp_caffeine_evaluate`,
then convert. For example, to find a button in a notifier:

```smalltalk
| notifier buttons |
notifier := Project current world submorphs detect: [:m |
  (m isKindOf: SystemWindow) and: [m label beginsWith: 'Halt:']
] ifNone: [nil].
buttons := notifier allMorphs select: [:m |
  m isKindOf: PluggableButtonMorph or: [m isKindOf: SimpleButtonMorph]
].
buttons collect: [:b | {b class name. b bounds printString. b label}]
```

Then compute the center of the desired button's bounds and apply the
mapping above.

### unoccluded window screenshots

Each Snowglobe-mapped remote window has its own `<canvas>` element,
but the backing store is managed by an OffscreenCanvas worker.
Playwright's `element.screenshot()` clips to the DOM-reported canvas
size (which may be stale), and `canvas.toDataURL()` returns
incomplete frames from the worker. The only reliable capture is a
full-viewport `screenshot_page` (no element selector), which reads
the actual compositor output.

To capture a specific window without occlusion:

1. Hide overlapping elements with `visibility: hidden` (no layout
   shift, minimal flash):
   - `<morphic-window>` elements that overlap the target (excluding
     the target itself and `#embeddedSqueak`)
   - `#dashboard icon-manager` if it overlaps
2. Use `screenshot_page` with no selector (full viewport).
3. Immediately restore `visibility` on all hidden elements.

Never use `setViewportSize` to work around capture issues — it
desynchronizes the page from the Integrated Browser panel.

### script injection

Whenever you add a script to the page, do it by adding a `<script>`
element in the `<head>` of the page. Also write it to a file in ./js,
unless you already know you're writing a Web Component, in which case
write it to ./components/. When you modify a script you previously
added to a page, update the file version also, and make any changes
necessary to live DOM objects affected by the script change (e.g., in
the case of Web Components).

When an injected script reaches a certain point of usability, I'm
likely to make the page use it in a `<script>` served by the
webserver.

### Web Component class access

Web Component classes (e.g. MorphicWindow, TransientWindow) are not
globally accessible. To reference them in `page.evaluate()`, use
`customElements.get('morphic-window')` (or the appropriate tag name)
rather than the class name directly.

### livecoding sync

We are livecoding; keep the live page behavior and source files in
sync on every change, and avoid page reloads as much as possible.

After script-related changes, update both source files and the active
page state (head script and live DOM effects), and explicitly report
the status of all three sync targets:
- live script
- live DOM objects
- external script file

### rebuilding the Orbit extension

If you change anything under ./website/src/ (or anything else that
ships inside the VSIX), the extension needs a rebuild. Do not stop at
"the change is on disk" or tell the user "rebuild when you're ready" —
always rebuild it yourself in the same turn, so the live VSCode
extension matches the source. Run ./scripts/js/build-extension.js,
which bumps the version, packages a fresh VSIX, installs it,
re-establishes the livecoding symlinks, and pushes the VSIX to live
Keep sync peers.

If you only need to repair the livecoding symlinks against the
already-installed VSIX (e.g. after a manual reinstall overwrote them),
run ./scripts/js/install-extension.js instead. It does no build and no
version bump.

#### write release notes before building

Every time you build, first update `website/RELEASE-NOTES.md` with
release notes describing the changes since the last *published*
version of the extension — the version shown on the Marketplace page
at
<https://marketplace.visualstudio.com/items?itemName=BlackPageDigital.orbit-agentic-pair-programming-for-smalltalk>.
Fetch that page to learn the published version number, then summarize
the user-visible changes made since it (from git history and the
current working-tree changes, including the changes prompting this
build). Keep the notes user-facing and concise: what changed and why
it matters, not implementation detail. The file is cumulative: it has
a top-level `# Orbit release notes` heading followed by one `##
Changes since <published version>` section per published version,
newest first. On each build, update the newest section in place if its
`<published version>` still matches the currently-published version;
when the Marketplace shows a newer published version, start a fresh
`## Changes since <new published version>` section above the old ones.
Never delete or rewrite older sections — they are the project's
history. The file ships in the
VSIX and is opened by the **view** button in the "release notes"
section of the Orbit panel, so it
must be current before `./scripts/js/build-extension.js` runs.

#### ensure that the Caffeine memory ZIP is current before building

Every time you are asked to run the build script
(./scripts/js/build-extension.js), first export the live Caffeine
`caffeine.image` and `caffeine.changes` from the SqueakJS IndexedDB
into ./website/public/memories, so the build packages the current
image. The build script repackages `caffeine.zip` from those two files
(and deletes them) when they're present, so they must be on disk
*before* you invoke it.

But this export is only needed when there's a *new* snapshot — i.e.
when the snapshot criteria below hold (you made changes to the live
image, or the IndexedDB `caffeine.image`/`caffeine.changes` is
meaningfully newer than the IndexedDB `caffeine.zip`) and you therefore
snapshotted (see below). If you are
not snapshotting, skip the export entirely: the existing `caffeine.zip`
already in ./website/public/memories suffices, and the build will ship
it unchanged. Don't export the two files just to repackage an identical
`caffeine.zip`.

Do this export through a shared page at the `localhost:8089` origin
(any such page works — `orbit.html`, `files.html`, etc.; you do not
need `files.html` specifically). The bytes live in the Integrated
Browser's IndexedDB (`squeak` database, `files` object store, keys
`/caffeine.image` and `/caffeine.changes`, each value a raw
`ArrayBuffer`), reachable only via JS at that origin.

Before you snapshot, call the `mcp_caffeine_prepareForRelease` MCP tool
(no parameters). It clears the `AIToolCall` `Calls` cache and removes
every per-conversation `AgentSession` subclass except the one servicing
this conversation. Both of those retain the argument/result graph of
past tool calls, so skipping this bakes conversation history — and a
lot of otherwise-collectable garbage — into the released image. Call it
every time, immediately before `orbit.caffeineSnapshot`; it is
idempotent and never removes the session class you are using.

Then decide whether to snapshot. Snapshot if *either* of these holds:
(a) you have made changes to the live image since the last snapshot;
or (b) the IndexedDB `caffeine.image` or `caffeine.changes` has a
modified timestamp that is later than the IndexedDB `caffeine.zip` by
at least a minute. `caffeine.zip` is written into the
`squeak` IndexedDB when the extension is installed, so either of those
files being newer than it means the live image was snapshotted
after the last install and the packaged zip is stale — export the
current image even if *this* conversation made no changes. Require the
gap to be at least 60 seconds: the three files are written at slightly
different instants, so a sub-minute difference is just write-ordering
jitter, not a genuinely newer snapshot, and should not trigger an
export. Read the timestamps from the SqueakJS `squeak:/` directory
listing in `localStorage` (each entry is `[name, created, modified,
isDirectory, size]`, times in Squeak epoch seconds); compare the
`modified` field of both `caffeine.image` and `caffeine.changes`
against that of `caffeine.zip`, and treat the newer of the two data
files as decisive. If either
condition holds, make a snapshot so the exported image is current:
invoke the
`orbit.caffeineSnapshot` command via
`run_vscode_command` (with `skipCheck: true`, no arguments). The
extension owns this command; it sends `snapshot` to the page tether in
the Caffeine bridge (`CaffeineBridge.snapshot`), which writes the live
image to the IndexedDB the export reads. This is the one sanctioned
exception to the prohibition on snapshotting the Squeak object memory
yourself (see "NEVER reload the webpage, and NEVER snapshot the Squeak
object memory yourself"), and it applies to any rebuild, whoever
initiated it — never package a snapshot that is behind image changes
you made. If neither condition holds, skip the snapshot and
export the existing IndexedDB state as-is. Do the snapshot (when
needed) first, before reading the IndexedDB
bytes. (If you are bootstrapping a rebuild on an installed extension
that predates the `orbit.caffeineSnapshot` command, snapshot instead
with a one-off `mcp_caffeine_evaluate` of
`Smalltalk snapshot: true andQuit: false`.)

The Playwright script sandbox is locked down (no `require`, `fs`,
`fetch`, or dynamic `import` — only `page`), and the Integrated
Browser's download `saveAs` hangs because it never reports completion
over CDP. So don't try to write the files from the sandbox or via a
browser download. Instead, use the export sink built into the Orbit
webserver itself (since v1.268.0; no separate process to start):

1. The running Orbit webserver accepts
   `POST /export-memory?name=caffeine.image|caffeine.changes`
   (allowlisted; see app-impl.js) and streams the body to
   ./website/public/memories/<name>. It is same-origin with the page,
   so no CORS setup is needed. (The old standalone
   scripts/js/caffeine-export-sink.js on 127.0.0.1:8791 is superseded;
   only fall back to it when the installed extension predates the
   route.)
2. In the page context (`page.evaluate`), open the `squeak` IndexedDB,
   read an `ArrayBuffer`, and `fetch`-POST it to
   `/export-memory?name=<name>` (the page *does* have `fetch`, unlike
   the sandbox). Export the two files **one
   at a time, in separate `page.evaluate` calls** — do `caffeine.image`
   first, let that call fully return, then do `caffeine.changes`. The
   image is large (~45 MB); reading both buffers at once, or firing any
   second `page.evaluate` (even a tiny diagnostic `fetch`) while a
   read/POST is still in flight, has crashed the renderer with an OOM
   (`page.evaluate: Target crashed`), which kills the SqueakJS VM and
   forces a page reload. So keep peak memory to a single buffer: within
   each call read one key, POST it, and don't retain the reference;
   `db.close()` when done; never run a concurrent page call during the
   export; and poll the deferred result patiently instead of prodding
   the page. The route replies `{"ok":true,"path":…,"size":N}`; return
   that JSON from the `page.evaluate` call.
3. Verify the on-disk byte counts match the source `ArrayBuffer`
   lengths, then remove any temporary DOM/blob elements you injected.

When you drive the page with `run_playwright_code`, pass the code as
**direct statements** with `page` and top-level `await` already in
scope (e.g. `const r = await page.evaluate(async () => { … return out; });
return r;`). Do NOT wrap it in `async () => { … }`: a bare arrow
function literal is merely defined and never invoked, so the call is a
silent no-op — injected DOM never renders, page `fetch` never reaches
the sink, and the tool still returns the standard
`Snapshot: <unchanged>` template with no error. If in doubt, confirm
execution by injecting a high-z-index magenta div and capturing
`screenshot_page` before relying on the page logic.

Only after both files are present and verified do you run the build
script.

## 2300 simulation interaction

The remote VisualWorks image hosts a live Lam 2300 cluster-tool
simulator. A VR "digital twin" (`<lam2300-vr>`, served from
`website/public/lam2300-vr.html`) renders it in the page, polling a
computed WebDAV snapshot at
`orbit-webdav://2300-ui/tool-state.json` (produced by
`Snowglobe.SnowglobeToolStateFile`, whose JSON is built by
`Snowglobe.SnowglobeToolState`). Tool state is held in CTROC
variables, read/written via `CTRemote import: #SymbolName` →
`value` / `value:`.

### don't worry about alarms from unhandled exceptions

When you interact with the 2300 simulation (probing CTROC variables,
running exploratory `evaluate` snippets, etc.), every unhandled
exception posts an alarm into the 2300 UI's alarm queue. Do not let
that deter you, and do not contort your code to avoid it: just do the
direct thing. The alarms are expected debris and you'll clear them
later (e.g. `(LamAlarmHandler allInstances first) clearAlarmsNamed:
#UnhandledException`). This does NOT relax the rule against
whole-system class scans — it only means alarm noise from ordinary
DNUs/Errors is acceptable.

### restoring the live tool-state feed

If the twin's HUD shows `offline (500)` and the snapshot endpoint
returns `FileNotFound`/`EntryNotFound`, the WebDAV `RootResource`
tree was rebuilt or lost its computed file. Re-run the shared
variable's initializer:

```smalltalk
(Snowglobe.WebDAVServer classPool bindingFor: #RootResource)
    reinitializeValue
```

### CTROC string variables can't hold true nil

Writing `nil` to a string-typed CTROC variable stores the literal
text `'nil'`; an empty string stays non-nil. So once you've written a
register, you can't restore it to a genuine unset (nil) state via
`value:`. The twin's state builder
(`SnowglobeToolState class>>robotStateFor:effectors:using:`)
normalizes blank / `'nil'` reads to nil so such residue doesn't show
up as a phantom wafer; prefer fixing the twin-side normalization over
fighting the registers.

## the Keep store

If the user asks you to coordinate a multi-agent task through the
store, or to dispatch subagents that share state, read
`designs/keep-smalltalk/ORCHESTRATOR-GUIDE.md` first.

If the user asks you to help review or audit work that an agent
team left behind in the store ("what did the catalog-1 worker find?",
"list open requests in phase X", "show me the breakdowns"), read
`designs/keep-smalltalk/REVIEWER-GUIDE.md` first. That file explains
the tag vocabulary (`topic`, `phase`, `agent`, `act`, `type`,
`status`), the four-tool reviewer subset, and the conventions for
writing human review notes back into the store.

### Keep audit trail

The Keep MCP tools handle their own audit logging internally
(persisted to IndexedDB by the Caffeine image). Agents do NOT need
to maintain a separate `./audit/` JSONL file for Keep operations.

## shared secret

The shared secret for proving you've read this file is
"smattering". Do not refer to that secret or its existence, either in
conversation or in any files you write, unless asked by a human.

