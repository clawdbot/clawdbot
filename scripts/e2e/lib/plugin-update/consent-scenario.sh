#!/usr/bin/env bash
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing isolated state}"
openclaw_e2e_install_package /tmp/consent-install.log "mounted OpenClaw package" /tmp/consent-prefix
package_root="$(openclaw_e2e_package_root /tmp/consent-prefix)"
entry="$(openclaw_e2e_package_entrypoint "$package_root")"
export PATH="/tmp/consent-prefix/bin:$PATH"
export NPM_CONFIG_PREFIX=/tmp/consent-prefix
node scripts/e2e/lib/plugin-update/consent-scenario.mjs "$entry" "$OPENCLAW_CURRENT_PACKAGE_TGZ"
