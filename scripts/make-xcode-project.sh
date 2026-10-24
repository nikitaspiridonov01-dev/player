#!/usr/bin/env bash
# Generates the Xcode project that wraps the web extension into a macOS + iOS app
# (Safari web extensions are installed through an app). Run on a Mac with Xcode installed.
#
#   bash scripts/make-xcode-project.sh            # macOS + iOS targets
#   bash scripts/make-xcode-project.sh ios        # iOS only
#   bash scripts/make-xcode-project.sh macos      # macOS only
#
# Environment overrides:
#   APP_NAME   display name of the wrapper app           (default: "AirPlay Any Video")
#   BUNDLE_ID  reverse-DNS bundle identifier             (default: dev.nikitaspiridonov.airplayany)
#   OUT        output directory for the Xcode project    (default: build)
#   COPY=1     copy extension files into the project instead of referencing ./extension
#   OPEN=1     open the generated project in Xcode when done
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="${APP_NAME:-AirPlay Any Video}"
BUNDLE_ID="${BUNDLE_ID:-dev.nikitaspiridonov.airplayany}"
OUT="${OUT:-build}"
PLATFORM="${1:-both}"

if ! command -v xcrun >/dev/null 2>&1; then
  echo "error: xcrun not found. Install Xcode from the App Store, then run:" >&2
  echo "       sudo xcode-select -s /Applications/Xcode.app && sudo xcodebuild -license accept" >&2
  exit 1
fi

# Xcode 26 renamed the tool; older Xcode ships the converter.
TOOL=""
for candidate in safari-web-extension-packager safari-web-extension-converter; do
  if xcrun --find "$candidate" >/dev/null 2>&1; then TOOL="$candidate"; break; fi
done
if [[ -z "$TOOL" ]]; then
  echo "error: neither safari-web-extension-packager nor safari-web-extension-converter is available (full Xcode required)." >&2
  exit 1
fi

ARGS=(--project-location "$OUT" --app-name "$APP_NAME" --bundle-identifier "$BUNDLE_ID" --swift --no-prompt --force)
case "$PLATFORM" in
  both) ;;
  ios|--ios-only) ARGS+=(--ios-only) ;;
  macos|--macos-only) ARGS+=(--macos-only) ;;
  *) echo "usage: $0 [both|ios|macos]" >&2; exit 2 ;;
esac
[[ "${COPY:-0}" == "1" ]] && ARGS+=(--copy-resources)
[[ "${OPEN:-0}" == "1" ]] || ARGS+=(--no-open)

echo "→ xcrun $TOOL ${ARGS[*]} extension"
xcrun "$TOOL" "${ARGS[@]}" extension

echo
echo "Done. Open the project:"
echo "  open \"$OUT/$APP_NAME/$APP_NAME.xcodeproj\""
echo
echo "Next: in Xcode select your Team (Signing & Capabilities) for the app and the extension targets,"
echo "pick your iPhone (or 'My Mac') as the run destination and press Run."
