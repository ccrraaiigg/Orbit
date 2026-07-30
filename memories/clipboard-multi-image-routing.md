# Remote VW clipboard: two images, one page

## The page mirrors two VW images at once

- `lamBackend` — `c:\Lam\Install\Backend\lamBackend`, Snowglobe
  `ws://192.168.1.140:19072/snowglobe`, tether `…:19072/tether`.
- `lamCTC` — `c:\Lam\Install\UI\lamCTC`, Snowglobe
  `ws://192.168.1.140:19070/snowglobe`, tether `…:19070/tether`.

**Window keys collide between the images** (both have a window 13), so
a key never identifies which image owns a window. Anything routing
per-window traffic must carry the connection's identity explicitly.

## Routing contract: `data-tether-url`

- `Snowglobe>>tetherURL` (Caffeine) derives the tether URL from its own
  connection: the websocket URL with `/snowglobe` replaced by `/tether`.
- `Snowglobe>>mapWindow:` stamps `data-tether-url` on each
  `morphic-window` / `transient-window` element as it creates it.
- `IconManager._tetherForCanvas(canvas)` reads it off
  `canvas.closest('morphic-window, transient-window')` and resolves a
  per-URL cached `VWBrowserTether` (`_tetherForUrl`). `im.tether` is
  still the default 19070 tether, kept because
  `vw-system-browser-launcher.js` uses it.

Windows already open when this shipped were retrofitted with the
attribute by hand; anything opened since gets it at map time.

## Don't trust the Windows platform clipboard for cross-image transfer

`Screen default getExternalSelection` sometimes returns the *other*
image's text and sometimes `''`. `ParagraphEditor class>>currentSelection:`
clears the external selection when its write fails, after which each
image reads its own private `PreviousSelections`. Route explicitly;
don't rely on sharing.

## Line separators

Host clipboard = LF/CRLF; VW text = CR. Without normalization a
multi-line paste appears as a single line. Fixed in **both** images:
`Tether>>setClipboard:` converts CRLF/LF → CR, `Tether>>getClipboard`
converts CR → LF.

## The `variables` parameter of the evaluate tool was broken

Two independent defects, both fixed in lamBackend *and* lamCTC:

1. `LamMCPEvaluateTool>>handleCall` passed every JSON value to
   `Agent>>objectForReference:`, which does `reference >= OtherMarkerTagBase`.
   With a String receiver that dispatches `String>>>=` → collation
   against a LargePositiveInteger → `shouldNotImplement`. Now guarded
   with `reference isInteger`; non-integers bind as themselves.
2. `AgentSession>>bindVariableNamed:to:` still carried debug
   instrumentation doing `(Smalltalk at: #OrbitTrace) add: …` for a
   global that no longer exists, so *every* variable raised
   `KeyNotFoundError #OrbitTrace`. Removed.

Verified: `{"text":"…","flag":true,"nothing":null,"count":42}` binds as
ByteString / true / nil / SmallInteger, and integer object references
still resolve.

## Gotchas hit along the way

- VW `String` has `includesSubstring:` but **not** `occurrencesOfString:`
  or `indexOfSubCollection:`.
- VW `Behavior` has `compile:classified:` but **not** `>>` or
  `sourceString`; use `compiledMethodAt:` and `getSource asString`.
- Patch large methods by in-image source substitution
  (`copyReplaceAll:` + `compile:classified:`) rather than retyping.
  Verify uniqueness by checking `patched size - src size` equals
  `new size - old size`.
- Recompiling `handleCall` while it is servicing the very evaluate that
  patches it is safe; the running activation keeps the old method.
