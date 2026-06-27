#!/bin/sh
# paste — native macOS clipboard manager. One-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/leeguooooo/paste/main/install.sh | sh
#
# Installs the latest release to /Applications and launches it. Fetching with
# curl avoids the com.apple.quarantine flag a browser download adds, so macOS
# won't hard-block this ad-hoc-signed build. You grant Accessibility + Input
# Monitoring once (for the global hotkey + paste).
set -eu

REPO="leeguooooo/paste"
APP="/Applications/paste.app"

[ "$(uname -s)" = "Darwin" ] || { echo "paste is macOS-only."; exit 1; }

case "$(uname -m)" in
  arm64) ASSET="paste-macos-arm64.tar.gz" ;;
  *) echo "Only Apple Silicon (arm64) is published right now."; exit 1 ;;
esac

echo "→ Finding the latest release…"
LATEST_URL="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest")"
TAG="${LATEST_URL##*/}"
[ -n "$TAG" ] && [ "$TAG" != "releases" ] || { echo "✗ could not resolve latest release"; exit 1; }
BASE="https://github.com/${REPO}/releases/download/${TAG}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ Downloading paste ${TAG}…"
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
  rm -rf "$APP"; tar -xzf "${TMP}/${ASSET}" -C /Applications
else
  echo "  (/Applications needs admin — you may be asked for your password)"
  sudo rm -rf "$APP"; sudo tar -xzf "${TMP}/${ASSET}" -C /Applications
fi

xattr -dr com.apple.quarantine "$APP" >/dev/null 2>&1 || true
open "$APP"

echo ""
echo "✓ Installed paste (${TAG}) to ${APP} and launched it."
echo "  • Grant Accessibility + Input Monitoring when prompted (System Settings)."
echo "  • Press ⌘⇧V to summon the clipboard, ⌘, for settings."
