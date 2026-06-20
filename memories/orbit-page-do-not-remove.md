# Never run a blanket `morphic-window`/`transient-window` remove on the Orbit page

The Caffeine SqueakJS VM lives inside a `<morphic-window id="embeddedSqueak">`
element in the outer `orbit.html` document. A naive cleanup like
`document.querySelectorAll("morphic-window, transient-window").forEach(el => el.remove())`
deletes that host element, which destroys the iframe, kills the SqueakJS VM,
and takes down the MCP server with it — losing all live image state.

When clearing remote-window proxies from the page, ALWAYS scope the selector
to exclude the Caffeine host. Examples that are safe:

```js
document.querySelectorAll("morphic-window:not(#embeddedSqueak)").forEach(el => el.remove());
```

Or filter explicitly:
```js
document.querySelectorAll("morphic-window").forEach(el => {
  if (el.id !== "embeddedSqueak") el.remove();
});
```

Also: the dashboard sidebar (`#dashboard`) and chrome elements (`#status`,
`#agent-mouse-cursor`) are part of the host UI, not remote windows. Touch only
elements that you have positive evidence are Snowglobe-mapped remote-window
proxies.
