# Orbit release notes

_Current version: 1.277.0_

## Changes since 1.263.0

- The **MCP servers** list in the Orbit panel now starts empty and
  shows each server only once it has actually connected, so you no
  longer see rows for servers that are still connecting or that never
  connect. A server that connects and later drops (or that you stop
  by hand) stays listed so you can restart it.
- Orbit now backs up your stored object memories automatically. On
  every boot, before anything can touch Orbit files in the VSCode
  browser's cache, each stored file (images, changes, etc.)  is copied
  to a timestamped directory under `backups/` in the workspace. If the
  browser's storage is ever lost or corrupted, the latest backup
  restores your work; the backup never blocks or delays a boot that
  would otherwise succeed.
- Extension builds no longer need a separate helper process to export
  the live Caffeine object memory: the Orbit webserver itself now
  accepts the export, so the pre-build memory refresh is simpler and
  more reliable.
- Boot-time backups now conserve disk space: files whose size hasn't
  changed since the previous backup are stored as symlinks to the
  original backed-up copy instead of full duplicates, so repeated
  boots of an unchanged object memory cost almost nothing.
- Fixed: boot-time backups now land in the open workspace's `backups/`
  folder as documented. On a normal (non-development) install they
  were written next to the installed extension instead — check
  `.vscode/extensions/backups/` in your home directory for any strays.
- Fixed: backup deduplication now works on Windows. Unchanged files
  are stored as hard links (which need no special privileges) instead
  of symlinks, falling back to a plain copy on filesystems without
  hard links. Every backup folder is now fully self-contained: deleting
  older backups never breaks newer ones. If deduplication fails for
  a file, it is re-sent in full rather than aborting the backup.
- After an extension update, Orbit no longer asks whether to keep your
  locally-modified object memory before installing the new one — the
  boot-time backup has already saved it to the workspace `backups/`
  folder, so the update just proceeds.
- New page function `orbitBackupSqueakImage(basename)` backs up just
  one object memory's `.image` and `.changes` files on demand, using
  the same deduplicating backup sink as the boot-time backup.
- Backup deduplication now looks through all previous backups, newest
  first, so a file only re-uploads when it has really changed — even
  if the most recent backup didn't include it. On macOS and Linux,
  deduplicated files are symlinks again (readable pointers to the
  original copy); hard links remain the mechanism on Windows.

## Changes since 1.258.0

- If none of the known MCP backends can be reached within one minute
  of Orbit starting, they are now dropped from the **MCP servers**
  list in the Orbit panel and Orbit stops trying to connect to them.
  Starting Orbit again gives them a fresh one-minute window.
- Orbit no longer auto-boots `caffeine.image` when more than one
  `.image` file is stored in the browser's local memory, so an extra
  object memory you dropped in won't be clobbered by an automatic
  Caffeine boot. Any explicitly-named image still boots normally.
- The **Stop Orbit** button now sits at the top of the Orbit panel,
  just above the **MCP servers** section, with dividing lines above
  and below it.
- The **agentic memory** section's **view** button now has a "memory
  graph" label, clarifying what it opens.
- New **release notes** section in the Orbit panel. Its **view**
  button opens these notes in a Markdown preview.
- Each build now ships release notes describing the changes since the
  last version published on the Visual Studio Marketplace.
- These release notes now show the current extension version as a
  subtitle at the top, kept in sync automatically on every build.
