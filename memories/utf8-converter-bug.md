# UTF8TextConverter latin1 table chicken-and-egg

`TextConverter class>>initializeLatin1MapAndEncodings` runs `self new
nextPut: ch toStream:` to discover each byte's encoding. But
`UTF8TextConverter>>nextPut:toStream:` itself reads `latin1Encodings`,
which is still nil during the initial pass. The error is silently
swallowed and EVERY byte is marked "needs translation" with an empty
replacement string. Result: any string converted via
`s convertToWithConverter: UTF8TextConverter new` (used in
`Snowglobe.WebRequest>>send200Response:`) becomes empty, so plain-text
WebDAV responses ship with Content-Length: 0 and an empty body.
README reads via WebDAV came back blank because of this.

Fix (committed in image, package Snowglobe): override
`UTF8TextConverter class>>initializeLatin1MapAndEncodings` to compute
the table directly without invoking `nextPut:toStream:`. Bytes
0..127 are pass-through; 128..255 expand to the standard two-byte
UTF-8 sequence `0xC0+(i>>6), 0x80+(i&0x3F)`.

Verify: `(UTF8TextConverter encodeByteString: 'hello world') size`
should be 11 (was 0). After re-running
`UTF8TextConverter initializeLatin1MapAndEncodings`, the table is
healthy and the WebDAV plain-text path serves correct content.
