#!/bin/sh
# build-extension.sh — bump version, package a fresh VSIX, install it into
# VS Code (Stable + Insiders if present), then replace selected installed
# files with symlinks to the workspace source for livecoding.
#
# For symlink-only refresh against an existing VSIX install, use
# install-extension.sh instead.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WEBSITE="$PROJECT_ROOT/website"

. "$SCRIPT_DIR/_symlink-extension.sh"

# Bump the minor version (second number) in website/package.json before
# packaging, unless SKIP_VERSION_BUMP is set. Uses an in-place regex edit
# to preserve the file's existing formatting.
if [ -z "$SKIP_VERSION_BUMP" ]; then
  node -e "
    const fs = require('fs');
    const path = '$WEBSITE/package.json';
    const src = fs.readFileSync(path, 'utf8');
    const m = src.match(/(\"version\"\s*:\s*\")(\d+)\.(\d+)\.(\d+)(\")/);
    if (!m) { throw new Error('version field not found'); }
    const oldVersion = m[2] + '.' + m[3] + '.' + m[4];
    const newVersion = m[2] + '.' + (Number(m[3]) + 1) + '.0';
    fs.writeFileSync(path, src.replace(m[0], m[1] + newVersion + m[5]));
    console.log('Bumped version to ' + newVersion + ' (was ' + oldVersion + ')');
  "
fi

VERSION="$(node -p "require('$WEBSITE/package.json').version")"
PUBLISHER="$(node -p "require('$WEBSITE/package.json').publisher.toLowerCase()")"
NAME="$(node -p "require('$WEBSITE/package.json').name")"
VSIX="$PROJECT_ROOT/$NAME-$VERSION.vsix"

# Remove any older packaged VSIX files so the workspace doesn't accumulate
# stale builds. Check both the project root (current location) and the
# website directory (previous location) for cleanup.
for old in "$PROJECT_ROOT/$NAME-"*.vsix "$WEBSITE/$NAME-"*.vsix; do
  [ -f "$old" ] || continue
  [ "$old" = "$VSIX" ] && continue
  rm -f "$old"
  echo "removed stale $old"
done

# Package the extension into a .vsix.
echo "=== Packaging $NAME-$VERSION ==="
(cd "$WEBSITE" && npx --yes vsce package --allow-missing-repository --out "$VSIX")

install_for() {
  LABEL="$1"
  CODE_BIN="$2"
  EXT_ROOT="$3"

  if [ ! -x "$CODE_BIN" ]; then
    echo "Skipping $LABEL: $CODE_BIN not found"
    return 0
  fi

  echo "=== Installing for $LABEL ==="
  # Uninstall any prior version first so a pinned older entry in the
  # extensions registry can't shadow the freshly installed VSIX on the
  # next window reload. Ignore failures (e.g. nothing to uninstall).
  "$CODE_BIN" --uninstall-extension "$PUBLISHER.$NAME" >/dev/null 2>&1 || true
  "$CODE_BIN" --install-extension "$VSIX" --force

  EXT_DIR="$EXT_ROOT/$PUBLISHER.$NAME-$VERSION"
  symlink_extension "$EXT_DIR" "$WEBSITE"

  # Remove any older installed versions so VS Code can't fall back onto a
  # stale extension dir whose symlinks may point at moved sources.
  for d in "$EXT_ROOT/$PUBLISHER.$NAME-"*; do
    [ -d "$d" ] || continue
    [ "$d" = "$EXT_DIR" ] && continue
    rm -rf "$d"
    echo "removed stale $d"
  done
}

install_for "VS Code" \
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  "$HOME/.vscode/extensions"

install_for "VS Code Insiders" \
  "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" \
  "$HOME/.vscode-insiders/extensions"

echo "Done. Reload the VS Code window(s) to pick up changes."
