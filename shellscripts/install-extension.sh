#!/bin/sh
# install-extension.sh — re-establish the livecoding symlinks inside the
# already-installed Orbit extension directory, without bumping the version
# or building a fresh VSIX. Use this when symlinks have been overwritten
# (e.g. by a manual --install-extension), or after pulling source changes
# that add new files needing symlinks.
#
# To bump the version, build a VSIX, and install it, use build-extension.sh.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEBSITE="$SCRIPT_DIR/../website"

. "$SCRIPT_DIR/_symlink-extension.sh"

VERSION="$(node -p "require('$WEBSITE/package.json').version")"
PUBLISHER="$(node -p "require('$WEBSITE/package.json').publisher.toLowerCase()")"
NAME="$(node -p "require('$WEBSITE/package.json').name")"

relink_for() {
  LABEL="$1"
  EXT_ROOT="$2"

  EXT_DIR="$EXT_ROOT/$PUBLISHER.$NAME-$VERSION"
  if [ ! -d "$EXT_DIR" ]; then
    echo "Skipping $LABEL: $EXT_DIR not found (run build-extension.sh first)"
    return 0
  fi

  echo "=== Relinking for $LABEL ==="
  symlink_extension "$EXT_DIR" "$WEBSITE"
}

relink_for "VS Code"          "$HOME/.vscode/extensions"
relink_for "VS Code Insiders" "$HOME/.vscode-insiders/extensions"

echo "Done. Reload the VS Code window(s) to pick up changes."
