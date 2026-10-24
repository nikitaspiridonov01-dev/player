#!/usr/bin/env bash
# Build the iOS app that carries the Safari extension and install it on a connected iPhone/iPad
# entirely from the terminal (no clicking around in Xcode).
#
# One-time prerequisites (details in README):
#   1. Xcode 15+ installed, selected and licensed:
#        sudo xcode-select -s /Applications/Xcode.app && sudo xcodebuild -license accept
#   2. Your Apple ID added once in Xcode → Settings → Accounts (a free account is enough). This is the
#      only step Apple does not expose on the command line; afterwards xcodebuild reuses that session
#      for automatic signing (certificate + provisioning profile are created on the first build).
#   3. iPhone connected by cable (first time: tap "Trust" on the phone), screen unlocked, and
#      Developer Mode enabled (Settings → Privacy & Security → Developer Mode; the switch appears
#      after the phone has been connected to a Mac with Xcode once).
#
# Usage:
#   bash scripts/install-ios.sh                        # auto-detect team and device, build, install, launch
#   bash scripts/install-ios.sh --device "iPhone 15"   # pick a device by name or identifier
#   bash scripts/install-ios.sh --doctor               # only check prerequisites and list devices
#   TEAM_ID=ABCDE12345 BUNDLE_ID=com.me.airplayany bash scripts/install-ios.sh
#
# Options / environment:
#   --team ID        | TEAM_ID        Apple Developer team id (auto-detected from Xcode's accounts)
#   --device NAME    | DEVICE         device name, identifier or UDID (see --doctor)
#   --bundle-id ID   | BUNDLE_ID      bundle identifier used when generating the project
#   --no-launch                       install but do not launch the app
#   --doctor                          check toolchain, team and devices, then exit
#   APP_NAME, OUT (build), CONFIGURATION (Release)
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="${APP_NAME:-AirPlay Any Video}"
BUNDLE_ID="${BUNDLE_ID:-dev.nikitaspiridonov.airplayany}"
OUT="${OUT:-build}"
CONFIGURATION="${CONFIGURATION:-Release}"
TEAM_ID="${TEAM_ID:-}"
DEVICE="${DEVICE:-}"
DOCTOR=0
LAUNCH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --team) TEAM_ID="${2:-}"; shift 2 ;;
    --device) DEVICE="${2:-}"; shift 2 ;;
    --bundle-id) BUNDLE_ID="${2:-}"; shift 2 ;;
    --doctor) DOCTOR=1; shift ;;
    --no-launch) LAUNCH=0; shift ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;34m→\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. toolchain
command -v xcrun >/dev/null 2>&1 || die "xcrun not found. Install Xcode from the App Store, then: sudo xcode-select -s /Applications/Xcode.app"
DEV_DIR="$(xcode-select -p 2>/dev/null || true)"
[[ "$DEV_DIR" == *".app/Contents/Developer"* ]] || die "Command Line Tools alone are not enough (active path: ${DEV_DIR:-none}). Run: sudo xcode-select -s /Applications/Xcode.app"
xcodebuild -version >/dev/null 2>&1 || die "xcodebuild is not usable (license not accepted?). Run: sudo xcodebuild -license accept"
log "$(xcodebuild -version | head -1) at $DEV_DIR"
xcrun --find devicectl >/dev/null 2>&1 || die "devicectl not found: Xcode 15 or newer is required to install on a device from the terminal."

# ---------------------------------------------------------------- 2. signing team
detect_team() {
  # Xcode keeps the teams of the signed-in Apple IDs in its preferences.
  local t
  t="$(defaults read com.apple.dt.Xcode IDEProvisioningTeams 2>/dev/null | grep -o 'teamID = "\{0,1\}[A-Z0-9]\{10\}' | head -1 | grep -o '[A-Z0-9]\{10\}$' || true)"
  if [[ -z "$t" ]]; then
    # Fallback: an existing development certificate in the keychain.
    t="$(security find-identity -v -p codesigning 2>/dev/null | grep -o 'Apple Development: [^"]*([A-Z0-9]\{10\})' | head -1 | grep -o '([A-Z0-9]\{10\})' | tr -d '()' || true)"
  fi
  printf '%s' "$t"
}
[[ -n "$TEAM_ID" ]] || TEAM_ID="$(detect_team)"
if [[ -z "$TEAM_ID" ]]; then
  if [[ "$DOCTOR" == 1 ]]; then
    warn "no signing team detected. Add your Apple ID once in Xcode → Settings → Accounts, or pass --team TEAMID."
  else
    die "could not detect your Apple Developer team. Add your Apple ID once in Xcode → Settings → Accounts (free account is fine), or pass --team TEAMID (Xcode → Settings → Accounts → your team, or developer.apple.com/account → Membership)."
  fi
else
  log "Signing team: $TEAM_ID"
fi

# ---------------------------------------------------------------- 3. device
DEVICES_JSON="${TMPDIR:-/tmp}/apa-devices-$$.json"
trap 'rm -f "${DEVICES_JSON:?}"' EXIT
xcrun devicectl list devices --json-output "$DEVICES_JSON" >/dev/null 2>&1 || die "devicectl could not list devices."
DEVICE_LINE="$(python3 - "$DEVICES_JSON" "$DEVICE" "$DOCTOR" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
want = sys.argv[2].strip().lower()
doctor = sys.argv[3] == "1"
rows = []
for d in data.get("result", {}).get("devices", []):
    hw = d.get("hardwareProperties", {}) or {}
    dp = d.get("deviceProperties", {}) or {}
    cp = d.get("connectionProperties", {}) or {}
    platform = str(hw.get("platform", "") or "")
    if "mac" in platform.lower() or "tv" in platform.lower() or "watch" in platform.lower():
        continue
    rows.append({
        "id": d.get("identifier", ""), "udid": hw.get("udid", ""), "name": dp.get("name", ""),
        "model": hw.get("marketingName") or hw.get("productType", ""), "os": dp.get("osVersionNumber", ""),
        "tunnel": cp.get("tunnelState", ""), "pairing": cp.get("pairingState", ""), "transport": cp.get("transportType", ""),
        "devmode": dp.get("developerModeStatus", ""),
    })
if doctor:
    if not rows:
        print("  (no iPhone/iPad paired with this Mac: connect it by cable and tap Trust on the phone)")
    for r in rows:
        print("  %-24s %-14s iOS %-8s %-12s %-10s devmode=%s  id=%s" % (r["name"], r["model"], r["os"], r["tunnel"] or "-", r["transport"] or "-", r["devmode"] or "?", r["id"]))
    sys.exit(0)
pick = None
if want:
    for r in rows:
        hay = " ".join([r["id"], r["udid"], r["name"]]).lower()
        if want in hay:
            pick = r; break
    if not pick:
        sys.exit("no device matches '%s'. Run with --doctor to see devices." % sys.argv[2])
else:
    connected = [r for r in rows if str(r["tunnel"]).lower() == "connected"]
    pick = (connected or rows or [None])[0]
    if not pick:
        sys.exit("no iPhone/iPad found. Connect it by cable, unlock it, tap Trust, then retry (or --doctor).")
print("%s\t%s" % (pick["id"], pick["name"]))
PY
)"
if [[ "$DOCTOR" == 1 ]]; then
  log "Devices:"
  printf '%s\n' "$DEVICE_LINE"
  PROJECT="$OUT/$APP_NAME/$APP_NAME.xcodeproj"
  if [[ -d "$PROJECT" ]]; then log "Xcode project: $PROJECT"; else log "Xcode project not generated yet (created on first install)"; fi
  exit 0
fi
DEVICE_ID="${DEVICE_LINE%%$'\t'*}"
DEVICE_NAME="${DEVICE_LINE#*$'\t'}"
log "Target device: $DEVICE_NAME ($DEVICE_ID)"
[[ -n "$DEVICE" ]] || log "(pick another one with --device \"name or id\"; see --doctor for the list)"

# ---------------------------------------------------------------- 4. project
PROJECT="$OUT/$APP_NAME/$APP_NAME.xcodeproj"
if [[ ! -d "$PROJECT" ]]; then
  log "Generating the Xcode project (first run, bundle id $BUNDLE_ID)"
  QUIET=1 APP_NAME="$APP_NAME" BUNDLE_ID="$BUNDLE_ID" OUT="$OUT" bash scripts/make-xcode-project.sh both
fi
SCHEME="$(xcodebuild -list -json -project "$PROJECT" 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
s = (d.get("project") or d.get("workspace") or {}).get("schemes", [])
ios = [x for x in s if "(iOS)" in x] or [x for x in s if "macOS" not in x]
print(ios[0] if ios else "")')"
[[ -n "$SCHEME" ]] || die "no iOS scheme found in $PROJECT. Delete the build directory and regenerate: bash scripts/make-xcode-project.sh"

# ---------------------------------------------------------------- 5. build + sign
DERIVED="$OUT/DerivedData"
LOG="$OUT/xcodebuild-ios.log"
log "Building scheme '$SCHEME' ($CONFIGURATION) for iOS devices; the first build also creates the certificate and profile. Log: $LOG"
set +e
xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration "$CONFIGURATION" \
  -destination 'generic/platform=iOS' -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic build 2>&1 \
  | tee "$LOG" | grep --line-buffered -E '(^\*\* |error:|Signing Identity:|Provisioning Profile:)'
STATUS=${PIPESTATUS[0]}
set -e
if [[ "$STATUS" != 0 ]]; then
  if grep -qiE 'No Account for Team|session has expired|No signing certificate|requires a development team|not signed in' "$LOG"; then
    KNOWN="$(defaults read com.apple.dt.Xcode IDEProvisioningTeams 2>/dev/null | grep -oE 'team(ID|Name) = "?[^";]+' | sed -E 's/team(ID|Name) = "?//' | paste -d' ' - - 2>/dev/null || true)"
    [[ -n "$KNOWN" ]] && printf 'Teams Xcode has seen (id name):\n%s\n' "$KNOWN" >&2
    die "Xcode has no signed-in Apple ID for team $TEAM_ID. Open Xcode → Settings → Accounts: add your Apple ID with '+' or sign in again if it shows 'session expired'. If another Apple ID is signed in, rerun with --team <its team id> (shown in the list above)."
  elif grep -qiE 'bundle identifier .* is not available|already exists|Failed Registering Bundle Identifier' "$LOG"; then
    die "bundle id is taken by another team. Delete the build directory and pick your own: BUNDLE_ID=com.yourname.airplayany bash scripts/install-ios.sh"
  elif grep -qiE 'Developer Mode' "$LOG"; then
    die "enable Developer Mode on the phone (Settings → Privacy & Security → Developer Mode), then rerun."
  fi
  die "build failed (exit $STATUS). See $LOG"
fi
APP="$DERIVED/Build/Products/$CONFIGURATION-iphoneos/$APP_NAME.app"
[[ -d "$APP" ]] || APP="$(find "$DERIVED/Build/Products/$CONFIGURATION-iphoneos" -maxdepth 1 -name '*.app' 2>/dev/null | head -1 || true)"
[[ -n "$APP" && -d "$APP" ]] || die "built app not found under $DERIVED/Build/Products"
ACTUAL_BUNDLE_ID="$(python3 -c 'import plistlib, sys; print(plistlib.load(open(sys.argv[1], "rb")).get("CFBundleIdentifier", ""))' "$APP/Info.plist" 2>/dev/null || echo "$BUNDLE_ID")"
log "Built: $APP ($ACTUAL_BUNDLE_ID)"

# ---------------------------------------------------------------- 6. install + launch
log "Installing on $DEVICE_NAME (unlock the phone if it asks)"
if ! xcrun devicectl device install app --device "$DEVICE_ID" "$APP"; then
  die "install failed. Typical causes: the phone is locked; Developer Mode is off (Settings → Privacy & Security → Developer Mode); the phone is not paired (unplug, replug, tap Trust). Run --doctor to check."
fi
if [[ "$LAUNCH" == 1 ]]; then
  xcrun devicectl device process launch --device "$DEVICE_ID" "$ACTUAL_BUNDLE_ID" >/dev/null 2>&1 \
    || warn "could not launch the app remotely; open '$APP_NAME' on the phone once by hand."
fi

cat <<MSG

✅ Installed on $DEVICE_NAME. On the phone:
  1. If iOS shows "Untrusted Developer": Settings → General → VPN & Device Management → your Apple ID → Trust.
  2. Settings → Safari → Extensions → $APP_NAME → On, and "Allow extension" → All Websites.
  3. Open a page with a video in Safari and tap the blue AirPlay badge on the video.
Free Apple ID: the app expires after 7 days; just rerun this script.
MSG
