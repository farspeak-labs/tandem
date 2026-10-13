#!/bin/zsh
# Builds Tandem.app. Signing and notarization are opt-in:
#   TANDEM_SIGN_IDENTITY="Your Name (TEAMID)"   Developer ID Application identity to sign with
#   TANDEM_NOTARY_PROFILE=profile                notarytool keychain profile (xcrun notarytool store-credentials)
# Both can live in build/signing.env (untracked).
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f build/signing.env ]] && source build/signing.env
args=(--mac --config electron-builder.yml)
# TANDEM_TARGET=dmg builds a distributable disk image (default: just the .app in out/mac-arm64).
if [[ "${TANDEM_TARGET:-dir}" == "dmg" ]]; then
  args+=(-c.mac.target=dmg -c.dmg.title='Tandem ${version}' -c.artifactName='Tandem-${version}-${arch}.${ext}')
fi
if [[ -n "${TANDEM_SIGN_IDENTITY:-}" ]]; then
  args+=(-c.mac.identity="$TANDEM_SIGN_IDENTITY")
  [[ "${TANDEM_TARGET:-dir}" == "dmg" ]] && args+=(-c.dmg.sign=true)
fi
electron-builder "${args[@]}"
if [[ -n "${TANDEM_SIGN_IDENTITY:-}" && -n "${TANDEM_NOTARY_PROFILE:-}" ]]; then
  if [[ "${TANDEM_TARGET:-dir}" == "dmg" ]]; then
    for dmg in out/*.dmg; do ./build/notarize.sh "$TANDEM_NOTARY_PROFILE" "$dmg"; done
  else
    ./build/notarize.sh "$TANDEM_NOTARY_PROFILE"
  fi
fi
