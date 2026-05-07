# Getting Started with Orbit

Orbit is a livecoding pair-programming harness that lets you and an AI
agent collaborate inside a running Smalltalk image — through VSCode,
a web browser, and a shared filesystem.

## What Orbit gives you

- A **VSCode extension** that runs this Orbit webapp.
- Remote Smalltalk GUI access.
- An **MCP server** in the remote Smalltalk, so agents can evaluate
  code, browse classes, and run tests through structured tools.
- A **WebDAV virtual filesystem** mounted at `/Volumes/webdav/`
  (macOS) or `W:` (Windows) that exposes the Smalltalk image as files:
  classes, methods, comments, package contents, and a shared
  `sessions/` area for agentic memory.

## Your first agent session

The Copilot agent has access to the remote Smalltalk in three ways:

- Direct manipulation of the Smalltalk GUI, through Playwright.
- Execution of workspace methods in the remote Smalltalk, managed with
  capabilities.
- Reading and writing the Smalltalk system through the WebDAV
  filesystem.
  
You can discuss Smalltalk system tasks with the agent, just as you
would with a fellow Smalltalk programmer.

### Subagents

You can also ask the agent to orchestrate tasks with subagents, and
subagents can have subagents (for a total of three agent levels). You
can write [agent-specific steering
documents](https://code.visualstudio.com/docs/copilot/agents/overview)
that agents can use when creating subagents.

## Browsing the image as files

The WebDAV mount makes the image feel like a directory tree:

```
/Volumes/webdav/
  classes/
    Object/
      comment
      subclasses/
      methods/
        yourself
  sessions/        <- shared agentic memory
```

- Read `classes/<Class>/methods/<selector>` to get source code without
  burning an MCP roundtrip.
- Write to those same paths to install or patch methods.
- Drop notes into `sessions/` so the next session — yours or another
  agent's — picks up where this one left off.

<br>

***Welcome to Orbit!***

If you have questions or comments, please contact Craig Latta at
[craig@blackpagedigital.com](mailto:craig@blackpagedigital.com).

