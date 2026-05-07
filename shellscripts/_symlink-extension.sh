# Shared helper: defines symlink_extension(), which replaces a subset of
# files inside an installed extension directory with symlinks back to the
# workspace source so livecoding edits take effect without reinstall.
# Sourced by build-extension.sh and install-extension.sh.

symlink_extension() {
  EXT_DIR="$1"
  WEBSITE="$2"

  SRC_JS="$WEBSITE/public/js"
  SRC_COMPONENTS="$WEBSITE/public/js/components"
  SRC_SQUEAKJS="$WEBSITE/public/js/squeakjs"
  SRC_CSS="$WEBSITE/public/css"
  DST_JS="$EXT_DIR/public/js"
  DST_COMPONENTS="$EXT_DIR/public/js/components"
  DST_SQUEAKJS="$EXT_DIR/public/js/squeakjs"
  DST_CSS="$EXT_DIR/public/css"

  for f in morphic-window.js icon-manager.js transient-window.js workbook-window.js spec-compiler.js; do
    rm -f "$DST_COMPONENTS/$f"
    ln -s "$SRC_COMPONENTS/$f" "$DST_COMPONENTS/$f"
    echo "symlinked components/$f"
  done

  for f in orbit-paste.js orbit-clipboard.js caffeine.js orbit-version-check.js; do
    rm -f "$DST_JS/$f"
    ln -s "$SRC_JS/$f" "$DST_JS/$f"
    echo "symlinked js/$f"
  done

  rm -f "$EXT_DIR/public/orbit.html"
  ln -s "$WEBSITE/public/orbit.html" "$EXT_DIR/public/orbit.html"
  echo "symlinked orbit.html"

  rm -f "$EXT_DIR/public/squeak.html"
  ln -s "$WEBSITE/public/squeak.html" "$EXT_DIR/public/squeak.html"
  echo "symlinked squeak.html"

  rm -f "$DST_SQUEAKJS/vm.js"
  ln -s "$SRC_SQUEAKJS/vm.js" "$DST_SQUEAKJS/vm.js"
  echo "symlinked squeakjs/vm.js"

  rm -f "$DST_SQUEAKJS/squeak.js"
  ln -s "$SRC_SQUEAKJS/squeak.js" "$DST_SQUEAKJS/squeak.js"
  echo "symlinked squeakjs/squeak.js"

  rm -f "$DST_SQUEAKJS/plugins/BitBltPlugin.js"
  ln -s "$SRC_SQUEAKJS/plugins/BitBltPlugin.js" "$DST_SQUEAKJS/plugins/BitBltPlugin.js"
  echo "symlinked squeakjs/plugins/BitBltPlugin.js"

  rm -f "$DST_CSS/caffeine.css"
  ln -s "$SRC_CSS/caffeine.css" "$DST_CSS/caffeine.css"
  echo "symlinked css/caffeine.css"

  # app.js and src/extension.js are NOT symlinked. They live as real files
  # inside the extension directory so their require('vscode') call
  # originates from a path VS Code can map to this extension. The workspace
  # files export factories that take vscode as a parameter; the shims load
  # them and pass vscode through.
  rm -f "$EXT_DIR/app.js"
  cat > "$EXT_DIR/app.js" <<EOF
// Auto-generated shim — see build-extension.sh / install-extension.sh.
let vscode = null;
try { vscode = require('vscode'); } catch (_) {}
module.exports = require('$WEBSITE/app-impl.js')(vscode);
EOF
  echo "wrote shim app.js"

  rm -f "$EXT_DIR/src/extension.js"
  cat > "$EXT_DIR/src/extension.js" <<EOF
// Auto-generated shim — see build-extension.sh / install-extension.sh.
const vscode = require('vscode');
module.exports = require('$WEBSITE/src/extension-impl.js')(vscode);
EOF
  echo "wrote shim src/extension.js"

  for f in index.js orbit.js secrets.js users.js; do
    rm -f "$EXT_DIR/routes/$f"
    ln -s "$WEBSITE/routes/$f" "$EXT_DIR/routes/$f"
    echo "symlinked routes/$f"
  done

  rm -rf "$EXT_DIR/bin"
  ln -s "$WEBSITE/bin" "$EXT_DIR/bin"
  echo "symlinked bin/"

  rm -rf "$EXT_DIR/secrets"
  ln -s "$WEBSITE/secrets" "$EXT_DIR/secrets"
  echo "symlinked secrets/"
}
