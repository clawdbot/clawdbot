#!/usr/bin/env bash

# Single owner of "which Keychain certificate may be picked automatically" for the Mac developer
# entry points. Both the signer (scripts/codesign-mac-app.sh) and the restart flow's signed-vs-ad-hoc
# decision (scripts/restart-mac.sh) must judge the same listing the same way: when only one of them
# accepts a certificate, restart silently ad-hoc-signs a machine that packaging would have signed
# properly, and ad-hoc signatures drop TCC grants on every rebuild.
#
# Selection order is a documented contract (docs/platforms/mac/signing.md): Developer ID Application,
# Apple Distribution, Apple Development, then any valid codesigning identity. The best rank wins
# across the whole listing rather than the first line, so ranks are collected in one pass and
# resolved at END. `security` status is ignored on purpose: selection is judged by the emitted
# listing, and a non-zero exit alongside usable output must not strand the caller.
select_mac_signing_identity() {
  { security find-identity -p codesigning -v 2>/dev/null || true; } | awk -F'"' '
    NF > 1 && $2 != "" {
      rank = 4
      if ($2 ~ /Developer ID Application/) rank = 1
      else if ($2 ~ /Apple Distribution/) rank = 2
      else if ($2 ~ /Apple Development/) rank = 3
      if (!(rank in best)) best[rank] = $2
    }
    END {
      for (rank = 1; rank <= 4; rank++) {
        if (rank in best) { print best[rank]; exit 0 }
      }
      exit 1
    }
  '
}

# Boolean form for callers that only need to know whether automatic signing can proceed. It runs the
# selection itself so eligibility can never drift from what the signer would actually choose.
has_mac_signing_identity() {
  select_mac_signing_identity >/dev/null
}
