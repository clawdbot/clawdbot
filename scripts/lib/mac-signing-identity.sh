#!/usr/bin/env bash

# Canonical tier order for codesign-mac-app.sh (signs) and restart-mac.sh (picks
# signed vs ad-hoc). Both once re-derived it from their own `security` pipeline,
# so their answers to "can we sign?" could disagree and cost an operator TCC
# persistence. One list keeps them from drifting apart again.
MAC_SIGNING_IDENTITY_CLASSES=(
  "Developer ID Application"
  "Apple Distribution"
  "Apple Development"
)

# Apple classes only, by decision: the signed path exists to keep TCC grants
# across rebuilds and only a real Apple identity is known to do that
# (docs/platforms/mac/permissions.md). Other codesigning certs stay reachable
# through an explicit SIGN_IDENTITY, so this scopes guessing, not capability.
#
# Match the quoted name against an exact "<class>:" prefix. A bare substring
# search also accepts names that merely contain the class text, such as a
# self-signed "Acme Developer ID Application Proxy". Accepted tradeoff: this
# classifies by certificate name, not issuer chain, so a cert deliberately
# named like an Apple one still passes; validating provenance in the packaging
# scripts is not worth it when the operator owns the keychain either way.
select_mac_signing_identity() {
  local listing=""
  listing="$(security find-identity -p codesigning -v 2>/dev/null)" || return 1

  local identity_class="" identity=""
  for identity_class in "${MAC_SIGNING_IDENTITY_CLASSES[@]}"; do
    identity="$(awk -F'"' -v prefix="${identity_class}:" \
      'index($2, prefix) == 1 { print $2; exit }' <<<"${listing}")"
    if [[ -n "${identity}" ]]; then
      printf '%s\n' "${identity}"
      return 0
    fi
  done

  return 1
}
