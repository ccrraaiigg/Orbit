#!/bin/sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEBSITE="$SCRIPT_DIR/../website"

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
    const next = m[1] + m[2] + '.' + (Number(m[3]) + 1) + '.0' + m[5];
    fs.writeFileSync(path, src.replace(m[0], next));
    console.log('Bumped version to ' + (Number(m[3]) + 1) + '.0 (was ' + m[3] + '.' + m[4] + ')');
  "
fi

VERSION="$(node -p "require('$WEBSITE/package.json').version")"
PUBLISHER="$(node -p "require('$WEBSITE/package.json').publisher.toLowerCase()")"
NAME="$(node -p "require('$WEBSITE/package.json').name")"
VSIX="$WEBSITE/$NAME-$VERSION.vsix"

# Package the extension into a .vsix.
echo "=== Packaging $NAME-$VERSION ==="
(cd "$WEBSITE" && npx --yes vsce package --allow-missing-repository --no-dependencies --out "$VSIX")
SRC_JS="$WEBSITE/public/js"
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
  DST_JS="$EXT_DIR/public/js"
  DST_COMPONENTS="$EXT_DIR/public/js/components"
  DST_SQUEAKJS="$EXT_DIR/public/js/squeakjs"
  DST_CSS="$EXT_DIR/public/css"

  # Replace installed component files with symlinks to workspace source
  for f in morphic-window.js icon-manager.js transient-window.js; do
    rm -f "$DST_COMPONENTS/$f"
    ln -s "$SRC_COMPONENTS/$f" "$DST_COMPONENTS/$f"
    echo "symlinked components/$f"
  done

  # Symlink top-level js files
  for f in orbit-paste.js orbit-clipboard.js caffeine.js; do
    rm -f "$DST_JS/$f"
    ln -s "$SRC_JS/$f" "$DST_JS/$f"
    echo "symlinked js/$f"
  done

  # Symlink orbit.html
  rm -f "$EXT_DIR/public/orbit.html"
  ln -s "$WEBSITE/public/orbit.html" "$EXT_DIR/public/orbit.html"
  echo "symlinked orbit.html"

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

  # Symlink server-side files
  # Note: app.js and src/extension.js are NOT symlinked. They live as real
  # files inside the extension directory so that their require('vscode')
  # call originates from a path VS Code can map to this extension. The
  # workspace files export factories that take vscode as a parameter; the
  # shims load them and pass vscode through. This avoids the warning
  # "Could not identify extension for 'vscode' require call from ...".
  rm -f "$EXT_DIR/app.js"
  cat > "$EXT_DIR/app.js" <<EOF
// Auto-generated shim — see install-extension.sh.
let vscode = null;
try { vscode = require('vscode'); } catch (_) {}
module.exports = require('$WEBSITE/app-impl.js')(vscode);
EOF
  echo "wrote shim app.js"

  rm -f "$EXT_DIR/src/extension.js"
  cat > "$EXT_DIR/src/extension.js" <<EOF
// Auto-generated shim — see install-extension.sh.
const vscode = require('vscode');
module.exports = require('$WEBSITE/src/extension-impl.js')(vscode);
EOF
  echo "wrote shim src/extension.js"

  # Symlink routes directory so route source edits take effect without reinstall
  for f in index.js orbit.js secrets.js users.js; do
    rm -f "$EXT_DIR/routes/$f"
    ln -s "$WEBSITE/routes/$f" "$EXT_DIR/routes/$f"
    echo "symlinked routes/$f"
  done

  # Symlink secrets directory (excluded from vsix by .vscodeignore)
  rm -rf "$EXT_DIR/secrets"
  ln -s "$WEBSITE/secrets" "$EXT_DIR/secrets"
  echo "symlinked secrets/"
}

install_for "VS Code" \
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  "$HOME/.vscode/extensions"

install_for "VS Code Insiders" \
  "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" \
  "$HOME/.vscode-insiders/extensions"

echo "Done. Reload the VS Code window(s) to pick up changes."
