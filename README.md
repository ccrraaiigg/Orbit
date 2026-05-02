# Orbit

A livecoding pair-programming harness for Smalltalk in VS Code.

Orbit augments the GitHub Copilot Chat agent so it can pair-program
with you in a live Smalltalk image. The agent sees what you see,
manipulates the same tools you use, and can evaluate code, browse
classes, and handle exceptions in the running system.

## What you get

- **A VS Code extension** that runs a local web server and opens a
  SqueakJS-hosted webapp in the Integrated Browser. The webapp
  presents windows from a remote Smalltalk environment (class
  browsers, workspaces, debuggers, inspectors, etc.).
- **A Copilot chat participant** (`@orbit`) preloaded with steering
  instructions for working in this environment.
- **An MCP server registration** pointing at the remote Smalltalk
  backend, giving the agent a `evaluate` tool for running Smalltalk
  expressions, plus tools for class/method introspection and
  refactoring.
- **A WebDAV virtual filesystem** (mounted at `/Volumes/webdav/`) that
  exposes the remote Smalltalk system as files and directories — class
  comments, method source, senders, implementors, and a shared
  `sessions/` area usable as agentic memory.

## Repository layout

| Path | Purpose |
| --- | --- |
| [website/](website/) | The VS Code extension and its webapp (Express + SqueakJS). |
| [website/src/extension.js](website/src/extension.js) | Extension entry point: commands, chat participant, MCP provider. |
| [website/agents/orbit.agent.md](website/agents/orbit.agent.md) | Steering instructions for the `@orbit` chat participant. |
| [website/public/](website/public/) | Webapp assets: `orbit.html`, components, SqueakJS, icons. |
| [website/public/js/components/](website/public/js/components/) | Web Components (`morphic-window`, `transient-window`, `icon-manager`). |
| [shellscripts/install-extension.sh](shellscripts/install-extension.sh) | Packages and installs the VSIX, symlinking live source files. |
| [designs/](designs/) | Design notes. |
| [summaries/](summaries/) | Per-conversation summaries written by the agent. |

## Getting started

1. Install dependencies:
   ```sh
   cd website && npm install
   ```
2. Build and install the extension:
   ```sh
   ./shellscripts/install-extension.sh
   ```
   This packages the VSIX, installs it into VS Code, and symlinks the
   live component, SqueakJS, and CSS sources into the installed
   extension so edits take effect without re-packaging.
3. Reload VS Code, then run **Orbit: Start** from the command palette.
   The Integrated Browser will open `http://localhost:8089/orbit.html`.
4. In Copilot Chat, address the agent as `@orbit`. Share the browser
   page with the chat (the agent will offer to do this for you if you
   forget).

## Commands

- `Orbit: Start` — launch the web server and open the webapp.
- `Orbit: Stop` — shut down the web server.
- `Orbit: Open Steering` — open `agents/orbit.agent.md` for editing.

## Working with the agent

The `@orbit` participant reads
[website/agents/orbit.agent.md](website/agents/orbit.agent.md) on
every invocation. That file is the single source of truth for agent
behavior: page-sharing, Playwright instrumentation, MCP usage, WebDAV
conventions, and livecoding sync rules. Edit it to change how the
agent works; no rebuild of the extension is required.

## Rebuilding

After modifying the extension itself (anything that affects packaging,
not just live-symlinked assets), bump the minor version in
[website/package.json](website/package.json), rebuild the extension,
and re-run
[shellscripts/install-extension.sh](shellscripts/install-extension.sh).

## More

See [the architecture
notes](https://lamrc.atlassian.net.mcas.ms/wiki/spaces/2FD/pages/668663889/Orbit+a+visual+agentic+workspace)
for a deeper description of the design.
