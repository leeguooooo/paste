#!/bin/sh
# paste — native macOS clipboard manager. One-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/leeguooooo/paste/native-rewrite/install.sh | sh
#
# Downloads the latest native build from GitHub Releases, installs it to
# /Applications, and launches it. curl-downloaded apps carry no quarantine flag,
# so macOS won't hard-block this ad-hoc-signed build — but you'll still grant
# Accessibility + Input Monitoring once (needed for the global hotkey + paste).
set -eu

REPO="leeguooooo/paste"
TAG="${PASTE_TAG:-v0.4.0-native}"
ASSET="paste-macos-arm64.tar.gz"
BASE="https://github.com/${REPO}/releases/download/${TAG}"
APP="/Applications/paste.app"

case "$(uname -s)" in
  Darwin) ;;
  *) echo "paste is macOS-only."; exit 1 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ Downloading paste (${TAG})…"
curl -fsSL "${BASE}/${ASSET}" -o "${TMP}/${ASSET}"
if curl -fsSL "${BASE}/${ASSET}.sha256" -o "${TMP}/${ASSET}.sha256" 2>/dev/null; then
  echo "→ Verifying checksum…"
  ( cd "$TMP" && shasum -a 256 -c "${ASSET}.sha256" >/dev/null ) || { echo "✗ checksum mismatch"; exit 1; }
fi

echo "→ Closing any running instance…"
osascript -e 'tell application "paste" to quit' >/dev/null 2>&1 || true
pkill -x paste >/dev/null 2>&1 || true
sleep 1

echo "→ Installing to ${APP}…"
if [ -w /Applications ]; then
  rm -rf "$APP"
  tar -xzf "${TMP}/${ASSET}" -C /Applications
else
  echo "  (/Applications needs admin — you may be asked for your password)"
  sudo rm -rf "$APP"
  sudo tar -xzf "${TMP}/${ASSET}" -C /Applications
fi

# Strip quarantine just in case, then launch.
xattr -dr com.apple.quarantine "$APP" >/dev/null 2>&1 || true
open "$APP"

echo ""
echo "✓ Installed paste to ${APP} and launched it."
echo "  • Grant Accessibility + Input Monitoring when prompted (System Settings)."
echo "  • Press ⌘⇧V to summon the clipboard, ⌘, for settings."
