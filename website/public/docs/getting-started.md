# <img src="../pictures/icons/participant/orbit.jpg" alt="Orbit logo" height="48" style="vertical-align: middle; margin-right: 12px;" /> Getting Started with Orbit

With Orbit, you can pair-program in Smalltalk with VSCode GitHub
Copilot agents.

## You should already be connected

When the Orbit extension starts, it connects to preset remote
Smalltalks. It configures MCP access, and mounts each Smalltalk as a
network drive in your VSCode workspace. If you don't already see the
windows of your Smalltalk systems reproduced here, something went
wrong.

## Your first agent session

The Copilot agent has access to remote Smalltalks in three ways:

- Direct manipulation of the Smalltalk GUI, through this web browser.
- Execution of workspace methods in the remote Smalltalk, managed with
  capabilities.
- Reading and writing the Smalltalk system through the network drive.
  
You can discuss Smalltalk system tasks with the agent, just as you
would with a fellow Smalltalk programmer.

To see that the agent can access Smalltalk, try these prompts:

"@orbit How many classes are in the system?"

"@orbit Show me the source code for method 'do:' in class Collection."

"@orbit Evaluate '3 + 4'."

### Subagents

You can also ask the agent to orchestrate tasks with subagents, and
subagents can have subagents (for a total of three agent levels). You
can write [agent-specific steering
documents](https://code.visualstudio.com/docs/copilot/agents/overview)
("personas") that agents can use when creating subagents.

## Browsing the image as files

The network drive presents Smalltalk as a directory tree:

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
				  senders/
				  implementors/
		  class/
  sessions/
  search/
	  query
	  results/
		  classes/
		  methods/
```

- Read `classes/<Class>/methods/<selector>` to get source code without
  using an MCP roundtrip.
- Write to those same paths to compile methods.
- Drop notes into `sessions/` so the next session (yours or another
  agent's) picks up where this one left off.

### Searching the virtual filesystem

You can search the virtual filesystem by writing to
/Smalltalk/search/query. The results are available in
/Smalltalk/search/results/.

The format of the query can be one of:

- a pattern with wildcards, selecting classes with matching names
- a block closure of the form [:class | ] which selects matching
  classes
- a block closure of the form [:method :class | ] which selects
  matching methods

<br>

***Welcome to Orbit!***

If you have questions or comments, please contact Craig Latta at
[craig@blackpagedigital.com](mailto:craig@blackpagedigital.com).

