# 2026-06-20 Waferflow Exercise

## Knowledge check: clearing an alarm from the 2300-ui Alarm page

There are two distinct operations on the Alarm page, depending on what
"clear" means:

### 1. Recover (clear) an active alarm

This resolves the alarm condition and stamps its **Clear Time**:

1. Click the alarm row in the table to select it.
2. The **Recovery Options** list (bottom-left) populates with the
   recovery actions valid for that alarm.
3. Select a recovery option, then click **Execute**.

`Execute` (`LamUISTMAlarmAll>>executeButton`) calls
`alarmManager userRecoverAlarm: … with:`. Note it checks privilege
first — if the resource isn't locked by this UI you'll get *"Cannot
clear < … > alarm. Resource is not locked by this user interface."*
Some alarms have no recovery option and just need the underlying
condition fixed.

### 2. Remove already-cleared entries from the table

The **Remove Alarms** group (bottom-center-right) purges rows from the
display:

- **Recovered** — removes every alarm that is no longer active
  (already has a Clear Time). Implemented by `removeRecoveredAlarms`,
  which drops non-active rows via
  `alarmManager removeAlarmsByPostOrdinal:`.
- **Warning** — removes all warning-severity alarms regardless of
  focus (`removeAllWarningButtonPrivate` →
  `removeAllWarningsFromLists`).

### Summary

To genuinely *clear/recover* an alarm, select it → pick a Recovery
Option → **Execute**. To just *tidy the table* of ones that are
already resolved, use **Remove Alarms → Recovered** (or **Warning**
for warnings).

## Verification trail (source consulted in 2300-ui image)

- UI class: `LamUISTMAlarmAll` (package `LamUISTMAlarmPkg`); warning
  removal on superclass `LamUIAlarmAll` (package `LamUIAlarmApp`).
- `executeButton` → `selectedAlarm`, privilege check via
  `hasPrivilegeFor:`, then
  `alarmManager userRecoverAlarm: selAlarm portableAlarm with: recovery`.
- `recoveryOptionSelected:` enables/disables `#executeButton`.
- `removeRecoveredAlarmsButton` → `removeRecoveredAlarms` →
  `masterList removeAllSuchThat: [:each | each isHidden not and:
  [each isActiveAlarm not]]` then
  `alarmManager removeAlarmsByPostOrdinal: ordinals`.
- `removeClearedAlarms` (on `LamUIAlarmAll`) is a distinct method from
  `LamUISTMAlarmAll>>removeRecoveredAlarms` — they live on different
  classes. The live panel (`LamUIExpandableAlarmAll`) uses the
  `LamUIAlarmAll` `removeClearedAlarms…` family; see learnings below.
- `removeAllWarningButtonPrivate` → `removeAllWarningsFromLists`.

## Learnings: manipulating the Alarm page programmatically (2300-ui)

The **entire** simulation UI — including the Alarm page — lives in the
`2300-ui` image. There is no separate display/client image; the DUI
machinery (`DUIServerSessionAdaptor`, `LamServerSession DUISession1`,
`CTCUIAlarmSummary` proxy) is loopback within this one image. So drive
the page by sending messages to the live UI application-model
instances directly.

### Finding the live UI objects

- The main window's model is **`LamUIModel`**
  (`LamUIModel allInstances first`). Its `titlePanelModel` is a
  **`LamUIAlarmLauncher`** (the alarm banner/launcher; holds
  `alarmCount`, `alarmsUpdateQueue`, `alarmWindowSwitch`, etc.).
- The **live alarm table panel is a `LamUIExpandableAlarmAll`**
  instance (`LamUIExpandableAlarmAll allInstances first`), a subclass
  of `LamUIAlarmAll`. It is embedded directly in the `LamUIModel`
  window as a subcanvas — **not** a separate window.
- **Pitfall:** `LamUISTMAlarmAll` (which implements
  `removeRecoveredAlarms` / `removeRecoveredAlarmsButton`) has **0 live
  instances** in this simulation — it is the wrong class. The visible
  panel is its sibling `LamUIExpandableAlarmAll`, whose buttons route
  through different selectors (see below). Don't assume the class from
  `getAllImplementors`; confirm which class actually has a live
  instance (walk `UserUIApplicationModel allSubclasses` filtered by
  name, checking `allInstances size`).

### Pressing the buttons programmatically

Send the button's action selector to the live
`LamUIExpandableAlarmAll` instance — this is exactly what a UI click
does:

- **Recovered** button → `removeClearedAlarmsButton`
  (→ `removeClearedAlarmsButtonPrivate` → `removeClearedAlarms`).
  Removes every row with a non-nil `clearTime` from `alarmDataSet`,
  `saveList`, `backupAllList`, reapplies focus/severity/issuer filters,
  and refreshes the widget. Pure UI-side state; does not touch the host
  `alarmQueue`. Verified: `alarmList` size went 72 → 8 (cleared rows
  gone, Recovered button auto-disabled via
  `enableDisableClearedButton`).
- **Warning** button → `removeAllWarningButton`
  (→ `removeAllWarningButtonPrivate` → `removeAllWarningsFromLists`).

Example:

```smalltalk
LamUIExpandableAlarmAll allInstances first removeClearedAlarmsButton
```

### VW evaluation gotchas hit during this exercise

- `Symbol = String` is **false** in VW, so
  `dependents detect: [:d | d class name = 'DUIServerSessionAdaptor']`
  raises notFound. Compare against a symbol: `d class name = #DUIServerSessionAdaptor`.
- `a or: [b] or: [c]` parses as a single `or:or:` keyword message
  (DNU). Nest explicitly: `(a or: [b]) or: [c]` or `a or: [b or: [c]]`.
- `allSubInstances` is DNU here; use `allSubclasses` then
  `allInstances` per class, or just `allInstances` on a known class.
- Every exploratory DNU posts an `UnhandledException` row into the
  alarm table under issuer `UIAlarmHandler` (expected debris).
