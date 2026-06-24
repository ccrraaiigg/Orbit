# Smalltalk grammar — recurring mistakes

Quick-reference for syntax errors I keep making. Applies to both the remote
VisualWorks images and Caffeine/SqueakJS unless noted.

## Temporary variables: ONE declaration block, at the very top

All temps for a method (or a block) must be declared in a single
`| a b c |` section that comes FIRST, before any statements. You CANNOT open a
second `| ... |` later, and you CANNOT introduce a temp mid-method the way you
would with `let`/`var` in other languages. There is no inline declaration.

WRONG (two declaration sections / a temp declared partway through):
```smalltalk
| a |
a := self foo.
| b |              "<-- parse error: temps must precede all statements"
b := a + 1.
```

RIGHT (hoist every temp to the top):
```smalltalk
| a b |
a := self foo.
b := a + 1.
```

When I realize partway through writing that I need another variable, I must go
back and add it to the leading `| ... |`, not declare it where I first use it.

### Block temps follow the same rule, after the block args
A block's own temps go in a `| ... |` immediately after the `:args |`, before
the block body — and again, only one such section per block:
```smalltalk
[:x :y | | sum | sum := x + y. sum * 2]
```
Block temps are separate from the enclosing method's temps; don't redeclare a
method temp inside a block (it shadows and is usually a mistake).

## Statements, cascades, returns
- Statements are separated by periods `.` (a trailing period is fine).
- Cascade messages to the SAME receiver are separated by `;` — the cascade
  re-sends to the receiver of the FIRST message in the cascade:
  `s nextPutAll: 'a'; nextPutAll: 'b'; flush`.
- `^expr` returns from the method. In the `evaluate` MCP tool do NOT use `^`
  (and it isn't needed — the last expression's value is returned).

## Literals vs runtime arrays
- `#(1 2 $a #sym 'str')` — compile-time LITERAL array; elements are literals,
  bare words become symbols, no expression evaluation.
- `{self foo. a + 1. x}` — BRACE array, evaluated at runtime. Works in
  `evaluate`. NOTE: the `compile` MCP tool has rejected brace-array literals in
  the past — there, build arrays with `Array with:` chains instead.
- `Array with:with:…` tops out at **5 args** in these images (6-arg is a DNU).
  For 6+: concatenate (`(Array with: a with: b with: c), (Array with: d …)`) or
  use a brace array where allowed.

## Misc syntax/line-ending gotchas
- Method source line separator is **CR (`\r`)**, not LF, when compiling.
- Keyword messages bind looser than binary, which bind looser than unary:
  `a foo + b bar baz` = `(a foo) + ((b bar) baz)`. Parenthesize keyword sends
  used as arguments: `coll add: (x foo: y)`.
- Symbols with colons: `#foo:bar:` (selector), keep the colons.
- Negative literals: `-3` ok; for `x - 3` keep the space so `-3` isn't read as
  a single negative literal argument.
- `:=` is assignment; `=` is equality (value), `==` is identity.

## Image-specific selector reminders (see shell-and-smalltalk-gotchas)
- VW String substring test: `includesSubstring:` (one word). Caffeine: use
  `(s indexOfSubCollection: 'x') > 0`.
- VW `Dictionary` has no `valuesDo:` — use `do:` / `keysAndValuesDo:`.
- `instVarNamed:` is unreliable on some classes (e.g. ApplicationWindow) —
  use `instVarAt: (cls allInstVarNames indexOf: 'name')`.
