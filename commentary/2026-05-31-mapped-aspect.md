User:

As I read about MappedAspect, it seems like it's recapitulating a method
dictionary, with a concerning potential for a lack of traceability. The way
the values are interpreted, for example in CWUIApplicationModel>>actionFor:,
is quite a mess.

Agent:

You're right on both counts. Here's what the code reveals:

The shadow method dictionary. `mappedAspectDict` is a plain Dictionary on
each instance, populated at init time by methods like `initMappedAspect` or
the even more opaque `initMap:sub:resource:`. It maps symbolic widget keys
(#pressure, #currentStep) to encoded composite strings like 'measurable
PressureReading' or 'controllable StepType'. There are 3,064 senders of
`mappedAspectDict` in the image — that's the size of this parallel dispatch
table spread across the system.

Traceability is effectively destroyed. Because the targets are concatenated
strings built at runtime (sometimes from $?-tokenized config data, sometimes
conditionally based on isFocusAPM / isFocusTopi / isFocusSRDi), you can't
use standard tooling — getAllSenders, getAllImplementors — to answer "what
does this button actually talk to?" The binding is invisible to the compiler
and reflective tools.

`actionFor:` specifically layers on:
1. The space-character heuristic (includes: Character space) to distinguish
   "composite" from "simple" keys — an in-band signal in a string
2. A duck-type check (respondsTo: #altActionFor:) that conditionally
   intercepts the dispatch within what should be a known hierarchy
3. A side-effect on an unrelated model (computeOnSet:) smuggled in as part
   of action resolution
4. A blanket Object errorSignal handler that swallows all errors and returns
   a no-op block [:m | ] — meaning binding failures are silently invisible
   at runtime

The 1994/1996 comments show this accreted over time. What started as a
simple indirection became a stringly-typed, error-swallowing, multi-dispatch
mini-framework that defeats both static analysis and runtime debugging. When
something goes wrong, you get a dead button with no diagnostic, and you
can't trace backwards from the symptom to the cause without manually walking
the init code for that specific subclass.

It's the kind of pattern that makes sense when you have 50 nearly-identical
UI panels differing only in which resource variables they bind to — but the
cost is that the system becomes opaque to anyone who isn't already holding
the full mental model of the composite-key encoding in their head.
