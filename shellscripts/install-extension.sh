#!/bin/sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEBSITE="$SCRIPT_DIR/../website"
VERSION="$(node -p "require('$WEBSITE/package.json').version")"
PUBLISHER="$(node -p "require('$WEBSITE/package.json').publisher.toLowerCase()")"
NAME="$(node -p "require('$WEBSITE/package.json').name")"
VSIX="$WEBSITE/orbit-$VERSION.vsix"
SRC_COMPONENTS="$WEBSITE/public/js/components"
SRC_SQUEAKJS="$WEBSITE/public/js/squeakjs"
SRC_CSS="$WEBSITE/public/css"

install_for() {
  LABEL="$1"
  CODE_BIN="$2"
  EXT_ROOT="$3"

  if [ ! -x "$CODE_BIN" ]; then
    echo "Skipping $LABEL: $CODE_BIN not found"
    return 0
  fi

  echo "=== Installing for $LABEL ==="
  "$CODE_BIN" --install-extension "$VSIX" --force

  EXT_DIR="$EXT_ROOT/$PUBLISHER.$NAME-$VERSION"
  DST_COMPONENTS="$EXT_DIR/public/js/components"
  DST_SQUEAKJS="$EXT_DIR/public/js/squeakjs"
  DST_CSS="$EXT_DIR/public/css"

  # Replace installed component files with symlinks to workspace source
  for f in morphic-window.js icon-manager.js transient-window.js; do
    rm -f "$DST_COMPONENTS/$f"
    ln -s "$SRC_COMPONENTS/$f" "$DST_COMPONENTS/$f"
    echo "symlinked components/$f"
  done

  # Symlink lam.html
  rm -f "$EXT_DIR/public/lam.html"
  ln -s "$WEBSITE/public/lam.html" "$EXT_DIR/public/lam.html"
  echo "symlinked lam.html"

  # Symlink vm.js
  rm -f "$DST_SQUEAKJS/vm.js"
  ln -s "$SRC_SQUEAKJS/vm.js" "$DST_SQUEAKJS/vm.js"
  echo "symlinked squeakjs/vm.js"

  rm -f "$DST_SQUEAKJS/squeak.js"
  ln -s "$SRC_SQUEAKJS/squeak.js" "$DST_SQUEAKJS/squeak.js"
  echo "symlinked squeakjs/squeak.js"

  rm -f "$DST_SQUEAKJS/plugins/BitBltPlugin.js"
  ln -s "$SRC_SQUEAKJS/plugins/BitBltPlugin.js" "$DST_SQUEAKJS/plugins/BitBltPlugin.js"
  echo "symlinked squeakjs/plugins/BitBltPlugin.js"

  # Symlink caffeine.css
  rm -f "$DST_CSS/caffeine.css"
  ln -s "$SRC_CSS/caffeine.css" "$DST_CSS/caffeine.css"
  echo "symlinked css/caffeine.css"
}

install_for "VS Code" \
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  "$HOME/.vscode/extensions"

install_for "VS Code Insiders" \
  "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" \
  "$HOME/.vscode-insiders/extensions"

echo "Done. Reload the VS Code window(s) to pick up changes."
