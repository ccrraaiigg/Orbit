# Orbit

A livecoding pair-programming harness for Smalltalk in VSCode.

Orbit augments the GitHub Copilot Chat agent so it can pair-program
with you in a live Smalltalk image. The agent sees what you see,
manipulates the same tools you use, and can evaluate code, browse
classes, and handle exceptions in the running system.

## What you get

- **A VSCode extension** that runs a local web server and opens a
  SqueakJS-hosted webapp in the Integrated Browser. The webapp
  presents windows from a remote Smalltalk environment (class
  browsers, workspaces, debuggers, inspectors, etc.).
- **A Copilot chat participant** (`@orbit`) preloaded with steering
  instructions for working in this environment.
- **An MCP server registration** pointing at the remote Smalltalk
  backend, giving the agent a `evaluate` tool for running Smalltalk
  expressions, plus tools for class/method introspection and
  refactoring.
- **A WebDAV virtual filesystem** that exposes the remote Smalltalk
  system as files and directories — class comments, method source,
  senders, implementors, and a shared `sessions/` area usable as
  agentic memory.

## Repository layout

| Path | Purpose |
| --- | --- |
| [website/](website/) | The VSCode extension and its webapp (Express + SqueakJS). |
| [website/src/extension.js](website/src/extension.js) | Extension entry point: commands, chat participant, MCP provider. |
| [website/agents/orbit.agent.md](website/agents/orbit.agent.md) | Steering instructions for the `@orbit` chat participant. |
| [website/public/](website/public/) | Webapp assets: `orbit.html`, components, SqueakJS, icons. |
| [website/public/js/components/](website/public/js/components/) | Web Components (`morphic-window`, `transient-window`, `icon-manager`). |
| [designs/](designs/) | Design notes. |
| [summaries/](summaries/) | Per-conversation summaries written by the agent. |

## Getting started

1. [Install the Orbit extension](https://marketplace.visualstudio.com/items?itemName=BlackPageDigital.orbit-agentic-pair-programming-for-smalltalk) from the VSCode extensions marketplace.

2. Run **Orbit: Start** from the VSCode command palette.

3. In Copilot Chat, address the agent as `@orbit`. Share the browser
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

### The `@orbit` participant is a quick-start, not a workhorse

The `@orbit` participant exists so you can try Orbit's steering with
**zero configuration** — install the extension, type `@orbit`, and the
steering is already loaded without touching your workspace. That makes
it ideal for a first look or a demo in an otherwise-empty directory.

It is **not** suitable for serious work. A VS Code chat participant
must run its own tool-calling loop, and the stable extension API gives
it no way to borrow the host's native agent loop. As a consequence,
`@orbit` does **not** get the agent-mode features you may rely on:

- **No checkpoints** and **no edit-review (Keep/Undo) UI** for the
  files it changes.
- **Session "Bypass Approvals" is ignored.** That toggle is part of the
  built-in agent's private machinery, so tools that normally prompt
  will still prompt under `@orbit`.
- **No host tool grouping / overflow management.** The participant
  forwards the full tool registry, so in a tool-heavy workspace it can
  hit the model's per-request tool cap.

For real work, install the steering into your workspace and use the
**default Copilot agent** (not a participant), which gives you the full
agent loop, checkpoints, edit review, and approval handling. The
simplest way is to copy Orbit's steering into your workspace's
`.github/copilot-instructions.md` (it is auto-loaded by the default
agent). Note that this **overrides/merges with your existing workspace
steering** — a deliberate disruption that the participant deliberately
avoids.

## More

See [the architecture
notes](https://lamrc.atlassian.net.mcas.ms/wiki/spaces/2FD/pages/668663889/Orbit+a+visual+agentic+workspace)
for a deeper description of the design.
