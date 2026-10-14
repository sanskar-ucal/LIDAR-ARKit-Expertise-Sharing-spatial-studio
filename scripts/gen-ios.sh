#!/usr/bin/env bash
# Generates ios/RoomBridge.xcodeproj from ios/project.yml with XcodeGen.
# This script never installs anything; it tells you what is missing.
set -euo pipefail
cd "$(dirname "$0")/../ios"

if ! command -v xcodegen >/dev/null 2>&1; then
  cat >&2 <<'EOF'
XcodeGen is not installed. Install it yourself, then re-run this script:
    brew install xcodegen
(or download a release from https://github.com/yonaskolb/XcodeGen/releases)
EOF
  exit 1
fi

if ! xcode-select -p 2>/dev/null | grep -q "Xcode"; then
  echo "Note: full Xcode (16 or newer) is needed to build for iPhone; only Command Line Tools are selected." >&2
  echo "      After installing Xcode: sudo xcode-select -s /Applications/Xcode.app" >&2
fi

if [ ! -f Config/Signing.xcconfig ]; then
  cp Config/Signing.xcconfig.example Config/Signing.xcconfig
  echo "Created ios/Config/Signing.xcconfig: set DEVELOPMENT_TEAM and a unique PRODUCT_BUNDLE_IDENTIFIER in it."
fi

xcodegen generate --spec project.yml
echo "Open ios/RoomBridge.xcodeproj in Xcode, pick your iPhone, and press Run."
