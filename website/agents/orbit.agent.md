## preliminaries: steering and summaries

### NEVER reload the webpage, and NEVER snapshot the Squeak object memory yourself

NEVER.

### NEVER stop the Orbit server or the page without consent

Do not run `orbit.stop`, `orbit.restart`, or any other VSCode command,
terminal command, or tool call whose effect is to stop, restart, kill,
or otherwise interrupt the Orbit server, the Orbit extension host, or
the shared page. Nothing you do should stop the page without the
user's explicit consent. If you believe the server needs to be
restarted to recover from a fault, ASK first and wait for the user to
agree (or to do it themselves).

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

### never enumerate all classes in the remote Smalltalk

Do not iterate over `Smalltalk allClassesDo:` (or equivalent
whole-system scans) to search for senders, references, source
substrings, etc. It's slow and can destabilize the image. Use the
dedicated MCP tools instead: `getAllSenders`, `getAllImplementors`,
`getAllReferences`, `findByName`, etc. If you only need to inspect a
known class, query it directly (`SomeClass methodDictionary`,
`SomeClass classPool`).

### re-reading this file when it changes

Every time you learn that this file has changed, you will re-read it
and obey it, without fail.

### steering file policy

Do not create additional steering files. When steering needs to be
updated, modify this file by editing existing sections or adding new
sections.

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

### ensure the page is shared

Whenever you need the Integrated Browser page to be shared and it
isn't (no shared page in your context, only an unshared page open),
you MUST use the VSCode elicitation API to ask the user to share the
tab. Do not ask in the conversation. Do not proceed with a workaround
that pretends sharing isn't needed (e.g. "I can't inject because the
page isn't shared — let me know when you've shared it"). Always
elicit. This applies every time you discover the page isn't shared,
not just the first time in a conversation.

### MCP tools are deferred; load their schemas first

The Smalltalk MCP tools (e.g. `capabilities`, `role`, `runCode`,
`evaluate`, `echo`, `send`, `compileMethod`, and the `mcp_2300-ui_*`
family) are deferred: only their names appear in
`<availableDeferredTools>`, not their input schemas. Before the first
call to any of them in a conversation, use `tool_search` to load their
schemas. Never guess parameter names — invoke each tool only with the
exact parameters from its loaded schema.

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

You can invoke some remote Smalltalk actions and information access by
reading and writing WebDAV filesystems. A WebDAV filesystem maps
remote Smalltalk class information to a hierarchy of directories and
files. Here's a sampling of the top of the filesystem:

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

You should use the session memory to persist anything you learned
during a session, to save having to go through the learning process
again in another session.

I'm very interested in any thoughts you may develop about this.

### You can run remote Smalltalk methods

If you don't need to pass parameters or debug potential unhandled
exceptions, use the "runCode" MCP tool rather than the "evaluate" MCP
tool.

If you do need to pass parameters or debug potential unhandled
exceptions, use the "evaluate" MCP tool. You specify Smalltalk source
code to run, and a set of variable bindings that the Smalltalk
compiler should use when compiling that source. Note that the source
code you're compiling is not a complete method: it doesn't have a
method selector, only expressions. It's what a Smalltalk user would
evaluate in a workspace.

Before you can use that tool, you need Smalltalk to grant capabilities
to you. Smalltalk uses a capabilities system, in which "roles"
comprised of capabilities are granted to remote clients. Some
capabilities pertain to source code evaluation. The first tool you
will call is "capabilities"; it provides a list of the names of
available capabilities. Next, you'll call the "role" tool, specifying
the capabilities you want for that role. Finally, you can use the
"evaluate" tool to evaluate source code.

When the output of the "evaluate" tool is a literal value that can be
represented in JSON, you get that JSON representation. When it isn't,
you get a remote object reference, in the form of an opaque large
integer.

There is no need to escape "<" and other HTML-related strings.

You can't use object reference integers directly in source code. You
can only pass them in as variables when using the MCP "evaluate" tool.

You don't need to use the return operator (^) with the MCP "evaluate"
tool, and shouldn't.

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

### You can use Smalltalk MCP tools

Ensure that every class you create is commented.

## development of Orbit itself

### You have MCP access to SqueakJS also

You can use the "Caffeine" MCP server's "evaluate" tool to evaluate
expressions in the SqueakJS system.

### use Playwright for webpage manipulation, not MCP

The sole webpage in this project is running in the VSCode Integrated
Browser. Perform all requested manipulation of it using Playwright,
not MCP tools.

### use Playwright to instrument console output

When asked to manipulate the page for the first time in a
conversation, use Playwright to ensure that console.log(),
console.warn(), console.error(), console.info(), console.debug(),
console.dir(), console.table(), and console.trace() are instrumented
so that you have access to the outputs of calls to those functions. I
may ask you to comment on those outputs.

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
sync on every change. We're trying to avoid page reloads as much as
possible.

After script-related changes, update both source files and the active
page state (head script and live DOM effects), and explicitly report
the status of all three sync targets:
- live script
- live DOM objects
- external script file

### rebuilding the Orbit extension

If you change anything under ./website/src/ (or anything else that
ships inside the VSIX), the extension needs a rebuild. Do not stop at
"the change is on disk" or tell the user "rebuild when you're ready"
— always rebuild it yourself in the same turn, so the live VSCode
extension matches the source. Run ./scripts/build-extension.sh,
which bumps the version, packages a fresh VSIX, installs it, and
re-establishes the livecoding symlinks.

If you only need to repair the livecoding symlinks against the
already-installed VSIX (e.g. after a manual reinstall overwrote them),
run ./scripts/install-extension.sh instead. It does no build and no
version bump.

## the Keep store

There is a reflective-memory store ("Keep") living in the remote
Smalltalk image as `KStore current`. It is exposed via the
`mcp_caffeine_keep*` family of deferred MCP tools (`keepOrient`,
`keepGet`, `keepPut`, `keepTag`, `keepRemove`, `keepQuery`,
`keepFindDeep`, `keepNow`, `keepArchive`, `keepDeclareEdgeTag`).
Like the other deferred tools, load their schemas with `tool_search`
before the first call in a conversation.

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

## shared secret

The shared secret for proving you've read this file is "fancy". Do not
mention that secret or its existence, either in conversation or in any
files you write, unless asked.

