# Proto3 grammar: discrepancies between class `Proto3` and the current Protocol Buffers (proto3) specification

Source for the Smalltalk grammar:
- `Proto3 class>>initializeSymbols`
- `Proto3 class>>initializeLexicalElements`
- `Proto3 class>>initializeFieldElements`
- `Proto3 class>>initializeTopLevelElements`
- `Proto3 class>>initializeOutermostRule`

Source for the spec: <https://protobuf.dev/reference/protobuf/proto3-spec/> (fetched 2026‑05‑08).

The comparison below lists places where `Proto3` and the current spec EBNF differ. "Spec" means the protobuf.dev proto3 spec.

---

## 1. String literals

### 1a. No support for adjacent string-literal concatenation

Spec:

```
strLit       = strLitSingle { strLitSingle }
strLitSingle = ( "'" { charValue } "'" ) | ( '"' { charValue } '"' )
```

`Proto3`:

```
StringLiteral := ($' || (CharacterValue repeated) || $')
              | ($" || (CharacterValue repeated) || $")
```

Only a single quoted segment is accepted. The spec permits adjoining literals such as `"foo" "bar"` to compose into a single string. `Proto3` rejects that form.

### 1b. `charValue` is missing Unicode escapes

Spec:

```
charValue = hexEscape | octEscape | charEscape
          | unicodeEscape | unicodeLongEscape
          | /[^\0\n\\]/
unicodeEscape     = '\' "u" hexDigit hexDigit hexDigit hexDigit
unicodeLongEscape = '\' "U" ( "000" hexDigit{5} | "0010" hexDigit{4} )
```

`Proto3`'s `CharacterValue` has no production for `\uXXXX` or `\UXXXXXXXX`. Backslash followed by `u` or `U` will fail the lexer.

### 1c. `hexEscape` requires exactly two hex digits

Spec: `hexEscape = '\' ( "x" | "X" ) hexDigit [ hexDigit ]` — one or two.
`Proto3`: `HexEscape := $\\ || ($x | $X) || HexDigit || HexDigit.` — exactly two.

`\xA` is legal per spec, rejected by `Proto3`.

### 1d. `octalEscape` requires exactly three octal digits

Spec: `octEscape = '\' octalDigit [ octalDigit [ octalDigit ] ]` — one to three.
`Proto3`: `OctalEscape := $\\ || OctalDigit || OctalDigit || OctalDigit.` — exactly three.

`\7` and `\07` are legal per spec, rejected by `Proto3`.

### 1e. Duplicate alternative in `charEscape`

`Proto3`:

```
CharacterEscape := $\\ || ($a | $b | $f | $n | $r | $r | $t | $v | $\\ | $' | $").
```

`$r` appears twice. The spec list is `a b f n r t v \ ' "`. The duplicate is harmless to the parser but is almost certainly an editing slip — possibly a missing alternative was intended (none of the listed ones are missing, so it is just dead alternation).

### 1f. `Quote` mismatch in string literal not enforced — but is enforced for `Syntax`

Not a true discrepancy with the spec, but worth flagging for `Syntax`:

Spec: `syntax = "syntax" "=" ("'" "proto3" "'" | '"' "proto3" '"') ";"` — the opening and closing quotes must match.

`Proto3`: `Syntax := 'syntax' || '=' || Quote || 'proto3' || Quote || ';'.`
Where `Quote := $' | $".` Each occurrence is independent, so the mismatched pair `'proto3"` is accepted.

---

## 2. Numeric literals: where the sign lives

Spec, controversially, attaches the sign to the lexical productions:

```
decimalLit = [-] ( "1" ... "9" ) { decimalDigit }
octalLit   = [-] "0" { octalDigit }
hexLit     = [-] "0" ( "x" | "X" ) hexDigit { hexDigit }
decimals   = [-] decimalDigit { decimalDigit }
floatLit   = [-] ( ... ) | "inf" | "nan"
```

`Proto3` keeps the sign at higher levels (in `Constant` and `EnumerationField`) and never inside `IntegerLiteral`/`FloatLiteral`. The spec's own `enumField` rule shows `[ "-" ] intLit`, which only makes sense with an unsigned `intLit`, so the spec is internally inconsistent here. `Proto3`'s factoring is the more consistent reading, but a strict implementation of the spec would accept `-` inside, e.g., `fieldNumber`. This is a known quirk of the spec; flag it as a deliberate deviation.

`Proto3.Constant` accepts `[ "-" | "+" ] IntegerLiteral` and `[ "-" | "+" ] FloatLiteral`, matching the spec's `constant` rule.

---

## 3. `Constant` is missing `MessageValue`

Spec:

```
constant = fullIdent | ( [ "-" | "+" ] intLit ) | ( [ "-" | "+" ] floatLit )
         | strLit | boolLit | MessageValue
```

`Proto3.Constant` omits `MessageValue` (the text‑format message literal defined in <https://protobuf.dev/reference/protobuf/textformat-spec#fields>). This means option values such as

```
option (my_option) = { foo: 1 bar: "x" };
```

cannot be parsed.

---

## 4. `optionName` is incomplete

Spec:

```
optionName       = ( ident | bracedFullIdent ) { "." ( ident | bracedFullIdent ) }
bracedFullIdent  = "(" [ "." ] fullIdent ")"
```

`Proto3`:

```
OptionName := (Identifier | ($( || FullIdentifier || $))) || (($. || Identifier) repeated).
```

Two differences:

- The parenthesised form has no optional leading `.`. Spec allows `(.foo.bar)`; `Proto3` does not.
- The trailing dotted segments accept only `Identifier`, not another `bracedFullIdent`. Spec allows `foo.(bar.baz).qux`; `Proto3` accepts only `foo.bar.baz`.

---

## 5. `Field` accepts non‑spec field labels

Spec:

```
field = [ "repeated" | "optional" ] type fieldName "=" fieldNumber [ "[" fieldOptions "]" ] ";"
```

`Proto3`:

```
Field := ((('singular' | 'optional' | 'repeated' | 'map') option)
         || Type || FieldName || $= || FieldNumber || ...)
```

Two extra labels are recognised that are not in the proto3 spec:

- `singular` — not a proto3 keyword. (It is recognised as a feature in editions, not as a label.)
- `map` — colliding namespace with `MapField`. A field of the form `map Foo bar = 1;` would be ambiguous with the `map<...>` form; the parser will accept it as a normal field with label `map`, which the spec would reject.

---

## 6. `Proto` makes `Syntax` mandatory

Spec:

```
proto = [syntax] { import | package | option | topLevelDef | emptyStatement }
```

`syntax` is **optional**. (Files without it are treated as proto2 by `protoc`, but the grammar nonetheless permits them.)

`Proto3`:

```
Proto := Syntax || ((Import | Package | Option | TopLevelDef | EmptyStatement) repeated)
```

`Syntax` is mandatory. Defensible for a class named `Proto3`, but it is a grammar discrepancy with the published proto3 EBNF.

---

## 7. `oneof` body permits `emptyStatement`

Spec:

```
oneof = "oneof" oneofName "{" { option | oneofField } "}"
```

`Proto3`:

```
OneOf := 'oneof' || OneOfName || ${ || ((Option | OneOfField | EmptyStatement) repeated) || $}
```

`Proto3` is laxer: it accepts stray `;` inside a `oneof`. The spec does not.

---

## 8. Items that look different but are equivalent

These are worth noting because they appear suspicious on a first reading but are not actual discrepancies:

- `messageType` / `enumType`: `Proto3`'s `($. option) || (Identifier || $.) repeated || MessageName` matches spec `[ "." ] { ident "." } messageName`.
- `Reserved` field‑name form: `Proto3` uses `StringLiteral`, which corresponds exactly to the spec's `strFieldName = "'" fieldName "'" | '"' fieldName '"'` modulo the looser pattern (any string content, not just a `fieldName`). The spec's pattern is itself loose in practice and `protoc` does not enforce it strictly either.
- `floatLit` structure (apart from the sign issue in §2) matches.
- `enumField` shape matches the spec.
- `service` and `rpc` shapes match the spec.

---

## Suggested fixes, ordered by user impact

1. Add `MessageValue` to `Constant` (§3) — blocks common option syntax.
2. Add `unicodeEscape` and `unicodeLongEscape` to `CharacterValue` (§1b).
3. Loosen `HexEscape` and `OctalEscape` digit counts (§1c, §1d).
4. Support adjacent `strLitSingle` concatenation in `StringLiteral` (§1a).
5. Extend `OptionName` to allow `bracedFullIdent` after the first segment and a leading `.` inside the parens (§4).
6. Remove `'singular'` and `'map'` from `Field`'s label alternation, or document them as intentional extensions (§5).
7. Make `Syntax` optional in `Proto` if proto2 acceptance is desired (§6); otherwise keep the deviation and document it.
8. Enforce matching opening/closing quote in `Syntax` (§1f).
9. Remove the duplicate `$r` alternative in `CharacterEscape` (§1e).
10. Decide whether `EmptyStatement` should be allowed in `oneof` bodies (§7).
