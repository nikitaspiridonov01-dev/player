#!/usr/bin/env bash
# Build the macOS app that carries the Safari extension, copy it to ~/Applications and open it,
# entirely from the terminal. Prerequisites: Xcode installed + licensed, Apple ID added once in
# Xcode → Settings → Accounts (for signing). Without a team the app is ad-hoc signed and Safari
# needs "Allow Unsigned Extensions" from its Develop menu (every Safari launch).
#
# Usage:
#   bash scripts/install-macos.sh
#   bash scripts/install-macos.sh --team ABCDE12345      (or TEAM_ID=ABCDE12345 …)
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="${APP_NAME:-AirPlay Any Video}"
BUNDLE_ID="${BUNDLE_ID:-dev.nikitaspiridonov.airplayany}"
OUT="${OUT:-build}"
CONFIGURATION="${CONFIGURATION:-Release}"
TEAM_ID="${TEAM_ID:-}"
DEST_DIR="${DEST_DIR:-$HOME/Applications}"
MACOS_MIN="${MACOS_MIN:-12.0}"   # the packager's 10.14 is below what current Xcode can build

while [[ $# -gt 0 ]]; do
  case "$1" in
    --team) TEAM_ID="${2:-}"; shift 2 ;;
    --bundle-id) BUNDLE_ID="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;34m→\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v xcrun >/dev/null 2>&1 || die "xcrun not found. Install Xcode, then: sudo xcode-select -s /Applications/Xcode.app"
DEV_DIR="$(xcode-select -p 2>/dev/null || true)"
[[ "$DEV_DIR" == *".app/Contents/Developer"* ]] || die "Command Line Tools alone are not enough. Run: sudo xcode-select -s /Applications/Xcode.app"
xcodebuild -version >/dev/null 2>&1 || die "run: sudo xcodebuild -license accept"

PROJECT="$OUT/$APP_NAME/$APP_NAME.xcodeproj"
TEAM_SOURCE="--team"
if [[ -z "$TEAM_ID" ]]; then
  # Same order as install-ios.sh: team chosen in the project, Xcode preferences, keychain certificate.
  if [[ -f "$PROJECT/project.pbxproj" ]]; then
    TEAM_ID="$(grep -o 'DEVELOPMENT_TEAM = [A-Z0-9]\{10\}' "$PROJECT/project.pbxproj" 2>/dev/null | head -1 | grep -o '[A-Z0-9]\{10\}$' || true)"
    [[ -n "$TEAM_ID" ]] && TEAM_SOURCE="project"
  fi
  if [[ -z "$TEAM_ID" ]]; then
    for key in IDEProvisioningTeamIdentifiers IDEProvisioningTeams; do
      TEAM_ID="$(defaults read com.apple.dt.Xcode "$key" 2>/dev/null | grep -oE '(^|[^A-Za-z0-9])[A-Z0-9]{10}([^A-Za-z0-9]|$)' | grep -oE '[A-Z0-9]{10}' | head -1 || true)"
      [[ -n "$TEAM_ID" ]] && { TEAM_SOURCE="xcode-preferences"; break; }
    done
  fi
  if [[ -z "$TEAM_ID" ]]; then
    TEAM_ID="$(security find-identity -v -p codesigning 2>/dev/null | grep -o 'Apple Development: [^"]*([A-Z0-9]\{10\})' | head -1 | grep -o '([A-Z0-9]\{10\})' | tr -d '()' || true)"
    [[ -n "$TEAM_ID" ]] && TEAM_SOURCE="keychain-certificate"
  fi
fi
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
  log "Signing team: $TEAM_ID (from $TEAM_SOURCE)"
  SIGN_ARGS=(-allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic)
else
  warn "no signing team found: building with ad-hoc signing. In Safari enable Develop → Allow Unsigned Extensions after each launch (or add your Apple ID in Xcode → Settings → Accounts and rerun)."
  SIGN_ARGS=(CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= CODE_SIGN_ENTITLEMENTS=)
fi
log "Building scheme '$SCHEME' ($CONFIGURATION). Log: $LOG"
run_build() {
  set +e
  xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration "$CONFIGURATION" -destination 'platform=macOS' \
    -derivedDataPath "$DERIVED" "${SIGN_ARGS[@]}" MACOSX_DEPLOYMENT_TARGET="$MACOS_MIN" build 2>&1 | tee "$LOG" | grep --line-buffered -E '(^\*\* |error:)'
  STATUS=${PIPESTATUS[0]}
  set -e
}
run_build
if [[ "$STATUS" != 0 ]] && grep -qiE 'cannot be found: .*\.(mobileprovision|provisionprofile)' "$LOG"; then
  log "The provisioning profile was created during this build; building again"
  run_build
fi
if [[ "$STATUS" != 0 ]]; then
  if grep -qiE 'No Account for Team|No signing certificate|requires a development team' "$LOG"; then
    die "signing failed for team ${TEAM_ID:-?} (source: $TEAM_SOURCE). Pass the right team: bash scripts/install-macos.sh --team <id> (see: bash scripts/install-ios.sh --list-teams), and make sure the Apple ID is signed in to Xcode → Settings → Accounts."
  fi
  die "build failed (exit $STATUS). See $LOG"
fi

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
