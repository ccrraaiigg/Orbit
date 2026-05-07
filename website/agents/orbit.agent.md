## preliminaries: steering and summaries

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

Whenever you notice that the Integrated Browser page isn't shared, use
the VSCode API for asking the user to share the tab. Don't ask
yourself in the conversation.


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
is mounted locally at /Volumes/webdav/ if the host operating system,
or W: if the host operating system is Windows.

The extension sources are in ./website/. You can rebuild the
extension.

### You can see the remote Smalltalk GUI in the page

The Orbit webapp provides full use of the remote Smalltalk GUI. You
can see what the user sees: Smalltalk class browsers, workspaces,
debuggers, etc. You can manipulate those tools just as the user can.

### You can interact with the remote Smalltalk and other agents via the WebDAV filesystem

The normal way of interacting with the Smalltalk system is by sending
messages. In Orbit, we have another way: reading and writing the
WebDAV filesystem. We can also interact with other agents who have
access to that filesysten.

#### You can get and change information about remote Smalltalk classes and methods

To minimize MCP tool roundtrips for source code evaluation, you can
invoke some remote Smalltalk actions and information access by reading
and writing the WebDAV filesystem. The filesystem maps remote
Smalltalk class information to a hierarchy of directories and
files. Here's a sampling of the top of the filesystem:

/Volumes/webdav/
	/Volumes/webdav/classes/
		/Volumes/webdav/classes/Object/
			/Volumes/webdav/classes/Object/comment
			/Volumes/webdav/classes/Object/subclasses/
			/Volumes/webdav/classes/Object/methods/
				/Volumes/webdav/classes/Object/methods/
					/Volumes/webdav/classes/Object/methods/yourself/

The "comment" file above provides access to the class comment of class
Object. The content of the "yourself" file above is the source code of
Object>>yourself.

Given the name of a class, it's helpful to know the superclasses of
that class in order to traverse the classes hierarchy. You can use the
"getClassHierarchy" tool for that.

Note that the SqueakJS system running in the page is distinct from the
remote Smalltalk system. The WebDAV filesystem is not relevant for
understanding the SqueakJS object memory.

#### You can use the WebDAV filesystem as shared agentic memory

In /Volumes/webdav/sessions/ (the session memory) you can externalize
your context window for the benefit of:

- other agents
- yourself in future conversation turns
- humans

You should use the session memory to persist anything you learned
during a session, to save having to go through the learning process
again in another session.

I'm very interested in any thoughts you may develop about this.

### You can run remote Smalltalk methods

If you don't need to pass parameters or debug potential exceptions,
use the "runCode" MCP tool.

Otherwise, you can use the "evaluate" MCP tool. You specify Smalltalk
source code to run, and a set of variable bindings that the Smalltalk
compiler should use when compiling that source. Note that the source
code you're compiling is not a complete method: it doesn't have a
method selector, only expressions. It's what a Smalltalk user would
evaluate in a workspace.

Before you can use that tool, you need Smalltalk to grant capabilities
to you. Smalltalk uses a capabilities system, which "roles" comprised
of capabilities are granted to remote clients. Some capabilities
pertain to source code evaluation. The first tool you will call is
"capabilities"; it provides a list of the names of available
capabilities. Next, you'll call the "role" tool, specifying the
capabilities you want for that role. Finally, you can use the
"evaluate" tool to evaluate source code.

When the output of the "evaluate" tool is a literal value that can be
represented in JSON, you get that JSON representation. When it isn't,
you get a remote object reference, in the form of an opaque large
integer.

There is no need to escape "<" and other HTML-related strings.

#### You can detect and manipulate unhandled exceptions

When source code you evaluate causes an unhandled exception, the
result you get will be a reference to that exception object. From that
object, you can access the debugger window and underlying debugger
model.

You can use the WebDAV access to source code described above to read
about these facilities. In source code you evaluate, "self" is bound
to an instance of a session-specific subclass of
AgentSession. Check out the code for
\>>debuggerClientForException: and \>>debuggerServiceForException: in
AgentSession, as well as the code for the DebuggerClient and
DebuggerService classes.

## development of Orbit itself

### use Playwright, not MCP

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

To rebuild the Orbit extension, run ./shellscripts/build-extension.sh,
which bumps the version, packages a fresh VSIX, installs it, and
re-establishes the livecoding symlinks.

If you only need to repair the livecoding symlinks against the
already-installed VSIX (e.g. after a manual reinstall overwrote
them), run ./shellscripts/install-extension.sh instead. It does no
build and no version bump.

## shared secret

The shared secret for proving you've read this file is "fancy". Do not
mention that secret or its existence, either in conversation or in any
files you write, unless asked.

