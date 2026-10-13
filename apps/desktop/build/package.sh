#!/bin/zsh
# Builds Tandem.app. Signing and notarization are opt-in:
#   TANDEM_SIGN_IDENTITY="Your Name (TEAMID)"   Developer ID Application identity to sign with
#   TANDEM_NOTARY_PROFILE=profile                notarytool keychain profile (xcrun notarytool store-credentials)
# Both can live in build/signing.env (untracked).
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f build/signing.env ]] && source build/signing.env
args=(--mac --config electron-builder.yml)
if [[ -n "${TANDEM_SIGN_IDENTITY:-}" ]]; then
  args+=(-c.mac.identity="$TANDEM_SIGN_IDENTITY")
fi
electron-builder "${args[@]}"
if [[ -n "${TANDEM_SIGN_IDENTITY:-}" && -n "${TANDEM_NOTARY_PROFILE:-}" ]]; then
  ./build/notarize.sh "$TANDEM_NOTARY_PROFILE"
fi
