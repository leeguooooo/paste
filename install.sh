#!/bin/sh
# Pastyx (paste) installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/leeguooooo/paste/main/install.sh | sh
#
# Fetching with curl avoids the com.apple.quarantine attribute that a browser
# download adds, so macOS won't show the "Apple could not verify ... Move to
# Trash" prompt. We also clear any stray quarantine after install.
set -eu

REPO="leeguooooo/paste"
APP_NAME="Pastyx"

if [ "$(uname -s)" != "Darwin" ]; then
	echo "error: this installer is macOS only. For Windows, download the .exe from https://github.com/${REPO}/releases" >&2
	exit 1
fi

# Apple Silicon vs Intel
case "$(uname -m)" in
	arm64) ARCH_SUFFIX="-arm64" ;;
	*) ARCH_SUFFIX="" ;;
esac

echo "Finding the latest ${APP_NAME} release..."
LATEST_URL="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest")"
TAG="${LATEST_URL##*/}"        # e.g. v0.3.9
VERSION="${TAG#v}"             # e.g. 0.3.9
ASSET="${APP_NAME}-${VERSION}${ARCH_SUFFIX}.dmg"
DMG_URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"

TMP="$(mktemp -d)"
MNT=""
cleanup() {
	[ -n "$MNT" ] && hdiutil detach "$MNT" -quiet 2>/dev/null || true
	rm -rf "$TMP"
}
trap cleanup EXIT

DMG="${TMP}/${ASSET}"
echo "Downloading ${ASSET} ..."
curl -fL --progress-bar -o "$DMG" "$DMG_URL"

echo "Mounting disk image ..."
MNT="$(hdiutil attach -nobrowse -noautoopen -quiet "$DMG" | grep -o '/Volumes/.*' | head -1)"
SRC_APP="$(/usr/bin/find "$MNT" -maxdepth 1 -name '*.app' -print -quit)"
if [ -z "$SRC_APP" ]; then
	echo "error: no .app found inside the disk image." >&2
	exit 1
fi
APP_BUNDLE="$(basename "$SRC_APP")"

# Quit any running copy so the new build takes over cleanly.
pkill -x "${APP_BUNDLE%.app}" 2>/dev/null || true

echo "Installing to /Applications (you may be asked for your password) ..."
sudo rm -rf "/Applications/${APP_BUNDLE}"
sudo cp -R "$SRC_APP" "/Applications/${APP_BUNDLE}"
sudo xattr -cr "/Applications/${APP_BUNDLE}" 2>/dev/null || true

echo ""
echo "✅ ${APP_NAME} v${VERSION} installed to /Applications/${APP_BUNDLE}."
echo "   Launch it from Spotlight or the Applications folder."
