# VisualWorks exception raising

- `anException signal` (no args) on a freshly-created instance is essentially a no-op — it does NOT raise the exception and on:do: won't catch it. Execution falls through.
- To raise: use `ExceptionClass raise` (class-side) or `anException raiseRequest` (instance-side).
- `signal:` (instance) expects a Signal object, not a string. Don't use it.
- `signal:` is NOT defined class-side on Error/Exception subclasses (Squeak-style).
- Symptom of using `signal` by mistake: handler never fires; code after the signal call continues; in compiler hooks (e.g. undeclaredStore:in:from:) `super emitStorePop:` then emits binding-based fallback bytecode instead of the intended retry.

## Every DNU/Error in an `evaluate` call posts a real alarm
- `LamMCPEvaluateTool`'s forked Error handler posts each unhandled exception
  from MCP `evaluate` (and `compile`) into the alarm system as an
  `UnhandledException` alarm (FatalError severity). The red alarm bar at the
  top of the 2300-ui shows the MOST RECENT alarm, so every careless DNU
  overwrites the banner with my own noise.
- ⇒ Do NOT blind-probe the image with speculative `evaluate` expressions
  (`instVarNamed:`, guessed selectors, `{...}` literals, `Array with:` >5 args,
  `Set>>#,`, etc.). Each failed probe self-pollutes the alarm queue. Read the
  class source first (`getClass`/`getMethodSource`) and only evaluate code I'm
  confident compiles and runs.

## Clearing my own alarms (low collateral)
- The alarm handler instance is `LamAlarmHandler allInstances first`
  (NOT `LamAlarmManager` — that one's `activeAlarms` often reads empty; the
  handler holds the posted set in `localAlarmsSet`).
- Recipe (clears ONLY my exception alarms, leaves legitimate ones):
  ```smalltalk
  | h |
  h := LamAlarmHandler allInstances first.
  [h clearAlarmsNamed: #UnhandledException] on: Error do: [:e | e messageText].
  ```
- `h localAlarmsSet size` before/after confirms how many were removed.
- After clearing, the banner reverts to the most-recent REAL alarm/warning.
  Do NOT assume which one — READ the banner (screenshot the 2300 UI) before
  claiming what it shows.
- The banner is driven by the handler's `alarmDisplay`, which is SEPARATE
  from `localAlarmsSet`. Warnings (severity Warning) like
  `AirLock1, AirLock is offline` show in the banner but are NOT in
  `localAlarmsSet`, so `clearAlarmsNamed:`/`clearLocalAlarmsMatching:` won't
  touch them. `localAlarmsSet` holds the FatalError-class alarms
  (e.g. `#UnhandledException`, `#ActionSequenceError`, datalogger alarms).
- Genuine standing conditions in this sim (leave them; they're not mine):
  the load locks are OFFLINE (visible as `Offline` labels in the tool
  diagram), which drives the `AirLock is offline` warning. (An earlier note
  here wrongly claimed a 14:17 `MachineServiceClient` MQTT failure was the
  standing alarm — that was stale; always read the live banner instead.)
- Useful `Alarm` accessors (DON'T guess others — `alarmName` is NOT one,
  it DNUs): `fullName`, `imageName`, `issuerName`, `timeStamp`,
  `internationalCompleteDescription`. Group `localAlarmsSet` by `fullName`
  to see what's posted.
- `clearAlarmsNamed:` takes a Symbol (the alarm name); my exceptions are named
  `#UnhandledException`.
