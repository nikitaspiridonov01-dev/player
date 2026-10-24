#!/usr/bin/env bash
# Build the macOS app that carries the Safari extension, copy it to ~/Applications and open it,
# entirely from the terminal. Prerequisites: Xcode installed + licensed, Apple ID added once in
# Xcode → Settings → Accounts (for signing). Without a team the app is ad-hoc signed and Safari
# needs "Allow Unsigned Extensions" from its Develop menu (every Safari launch).
#
# Usage:
#   bash scripts/install-macos.sh
#   TEAM_ID=ABCDE12345 bash scripts/install-macos.sh
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="${APP_NAME:-AirPlay Any Video}"
BUNDLE_ID="${BUNDLE_ID:-dev.nikitaspiridonov.airplayany}"
OUT="${OUT:-build}"
CONFIGURATION="${CONFIGURATION:-Release}"
TEAM_ID="${TEAM_ID:-}"
DEST_DIR="${DEST_DIR:-$HOME/Applications}"

log()  { printf '\033[1;34m→\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v xcrun >/dev/null 2>&1 || die "xcrun not found. Install Xcode, then: sudo xcode-select -s /Applications/Xcode.app"
DEV_DIR="$(xcode-select -p 2>/dev/null || true)"
[[ "$DEV_DIR" == *".app/Contents/Developer"* ]] || die "Command Line Tools alone are not enough. Run: sudo xcode-select -s /Applications/Xcode.app"
xcodebuild -version >/dev/null 2>&1 || die "run: sudo xcodebuild -license accept"

if [[ -z "$TEAM_ID" ]]; then
  TEAM_ID="$(defaults read com.apple.dt.Xcode IDEProvisioningTeams 2>/dev/null | grep -o 'teamID = "\{0,1\}[A-Z0-9]\{10\}' | head -1 | grep -o '[A-Z0-9]\{10\}$' || true)"
fi

PROJECT="$OUT/$APP_NAME/$APP_NAME.xcodeproj"
if [[ ! -d "$PROJECT" ]]; then
  log "Generating the Xcode project (first run)"
  QUIET=1 APP_NAME="$APP_NAME" BUNDLE_ID="$BUNDLE_ID" OUT="$OUT" bash scripts/make-xcode-project.sh both
fi
SCHEME="$(xcodebuild -list -json -project "$PROJECT" 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
s = (d.get("project") or d.get("workspace") or {}).get("schemes", [])
mac = [x for x in s if "(macOS)" in x] or [x for x in s if "iOS" not in x]
print(mac[0] if mac else "")')"
[[ -n "$SCHEME" ]] || die "no macOS scheme found in $PROJECT (regenerate with: bash scripts/make-xcode-project.sh)"

DERIVED="$OUT/DerivedData"
LOG="$OUT/xcodebuild-macos.log"
SIGN_ARGS=()
if [[ -n "$TEAM_ID" ]]; then
  log "Signing team: $TEAM_ID"
  SIGN_ARGS=(-allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic)
else
  warn "no signing team found: building with ad-hoc signing. In Safari enable Develop → Allow Unsigned Extensions after each launch (or add your Apple ID in Xcode → Settings → Accounts and rerun)."
  SIGN_ARGS=(CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= CODE_SIGN_ENTITLEMENTS=)
fi
log "Building scheme '$SCHEME' ($CONFIGURATION). Log: $LOG"
set +e
xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration "$CONFIGURATION" -destination 'platform=macOS' \
  -derivedDataPath "$DERIVED" "${SIGN_ARGS[@]}" build 2>&1 | tee "$LOG" | grep --line-buffered -E '(^\*\* |error:)'
STATUS=${PIPESTATUS[0]}
set -e
[[ "$STATUS" == 0 ]] || die "build failed (exit $STATUS). See $LOG"

APP="$DERIVED/Build/Products/$CONFIGURATION/$APP_NAME.app"
[[ -d "$APP" ]] || die "built app not found at $APP"
mkdir -p "$DEST_DIR"
rm -rf "${DEST_DIR:?}/${APP_NAME:?}.app"
cp -R "$APP" "$DEST_DIR/"
log "Installed to $DEST_DIR/$APP_NAME.app"
open "$DEST_DIR/$APP_NAME.app"
cat <<MSG

✅ The app is open; it registers the extension with Safari.
  Safari → Settings → Extensions → $APP_NAME → enable, then allow it for websites.
  (Ad-hoc build only: Safari → Develop → Allow Unsigned Extensions.)
MSG
