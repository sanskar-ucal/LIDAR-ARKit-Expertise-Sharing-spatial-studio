#!/usr/bin/env bash
# Packages the Blender add-on two ways:
#   build/roombridge-extension.zip  Blender 4.2+ extension (blender_manifest.toml at the zip root)
#                                   Install: Edit > Preferences > Get Extensions > ⌄ > Install from Disk
#   build/roombridge-addon.zip      Legacy add-on (zip contains the roombridge/ folder)
#                                   Install: Edit > Preferences > Add-ons > ⌄ > Install from Disk
set -euo pipefail
cd "$(dirname "$0")/.."

src=blender_addon/roombridge
out=build
mkdir -p "$out"
rm -f "$out/roombridge-extension.zip" "$out/roombridge-addon.zip"

python3 -m py_compile "$src"/*.py
find "$src" -name '__pycache__' -type d -prune -exec rm -rf {} +

(cd "$src" && zip -q -r "../../$out/roombridge-extension.zip" . -x '*.pyc' -x '__pycache__/*' -x '.DS_Store')
(cd blender_addon && zip -q -r "../$out/roombridge-addon.zip" roombridge -x '*.pyc' -x '*/__pycache__/*' -x '*.DS_Store')

echo "Wrote:"
ls -l "$out"/roombridge-*.zip
