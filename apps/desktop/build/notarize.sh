#!/bin/zsh
# Notarize + staple the packaged app when a notarytool keychain profile exists.
# Usage: build/notarize.sh <notarytool keychain profile>
set -euo pipefail
profile=${1:?usage: notarize.sh <notarytool profile>}
app="out/mac-arm64/Tandem.app"
if ! xcrun notarytool history --keychain-profile "$profile" >/dev/null 2>&1; then
  echo "Skipping notarization: no notarytool profile \"$profile\"."
  echo "Create it once with: xcrun notarytool store-credentials \"$profile\" --apple-id <Apple ID> --team-id <Team ID>"
  exit 0
fi
ditto -c -k --keepParent "$app" out/Tandem-notarize.zip
xcrun notarytool submit out/Tandem-notarize.zip --keychain-profile "$profile" --wait
xcrun stapler staple "$app"
rm -f out/Tandem-notarize.zip
echo "Notarized and stapled $app"
