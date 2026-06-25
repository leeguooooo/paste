#!/usr/bin/env bash
# Build Pastyx with SwiftPM and assemble Pastyx.app (an LSUIElement agent app).
#
# Usage:
#   scripts/make-app.sh            # release build -> .build/Pastyx.app
#   CONFIGURATION=debug scripts/make-app.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIGURATION="${CONFIGURATION:-release}"
# PRODUCT = the SwiftPM executable target name; APP_NAME = the user-visible app name.
PRODUCT="Pastyx"
APP_NAME="paste"
BUNDLE_ID="com.paste.native"

echo "==> swift build ($CONFIGURATION)"
swift build -c "$CONFIGURATION"

BIN_PATH="$(swift build -c "$CONFIGURATION" --show-bin-path)"
EXE="$BIN_PATH/$PRODUCT"
if [[ ! -x "$EXE" ]]; then
  echo "error: built executable not found at $EXE" >&2
  exit 1
fi

APP_DIR="$BIN_PATH/$APP_NAME.app"
CONTENTS="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RES_DIR="$CONTENTS/Resources"

echo "==> assembling $APP_DIR"
rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RES_DIR"
# CFBundleExecutable must match this file name.
cp "$EXE" "$MACOS_DIR/$APP_NAME"

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundleDisplayName</key>
  <string>$APP_NAME</string>
  <key>CFBundleExecutable</key>
  <string>$APP_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>26.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>paste restores your previously active app and pastes your selected clip into it.</string>
  <key>NSAccessibilityUsageDescription</key>
  <string>paste needs Accessibility access to paste clips into the app you were just using.</string>
  <key>NSHumanReadableCopyright</key>
  <string>paste</string>
</dict>
</plist>
PLIST

# Optional: ad-hoc sign so the app launches without quarantine prompts on the dev box.
if command -v codesign >/dev/null 2>&1; then
  echo "==> ad-hoc codesign"
  codesign --force --deep --sign - "$APP_DIR" >/dev/null 2>&1 || \
    echo "   (ad-hoc sign failed; app still runnable from Finder after a right-click > Open)"
fi

echo "==> done: $APP_DIR"
echo "    run: open \"$APP_DIR\"   (agent app, no Dock icon; look for the menu-bar item)"
