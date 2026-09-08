#!/usr/bin/env bash

openclaw_frozen_target_omissions_authorized() {
  case "${OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS:-0}" in
    0 | "")
      return 1
      ;;
    1) ;;
    *)
      echo "invalid OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: expected 0 or 1" >&2
      return 2
      ;;
  esac

  if [[ ! "${OPENCLAW_SELECTED_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "OPENCLAW_SELECTED_SHA must be a full lowercase commit SHA" >&2
    return 2
  fi
  if [[ ! "${OPENCLAW_TOOLING_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "OPENCLAW_TOOLING_SHA must be a full lowercase commit SHA" >&2
    return 2
  fi
  if [[ "$OPENCLAW_SELECTED_SHA" == "$OPENCLAW_TOOLING_SHA" ]]; then
    echo "frozen-target omissions require distinct selected and tooling SHAs" >&2
    return 2
  fi
}

openclaw_prepare_frozen_target_context() {
  local source_root="${1:?missing selected source root}" authorization_status=0

  openclaw_frozen_target_omissions_authorized || authorization_status=$?
  [ "$authorization_status" -eq 1 ] && return 1
  [ "$authorization_status" -eq 0 ] || return "$authorization_status"

  if [ "$(git -C "$source_root" rev-parse HEAD 2>/dev/null)" != "$OPENCLAW_SELECTED_SHA" ]; then
    echo "selected source checkout does not match OPENCLAW_SELECTED_SHA" >&2
    return 2
  fi
}

openclaw_resolve_frozen_target_file() {
  local source_root="${1:?missing selected source root}" \
    relative_path="${2:?missing selected relative path}" \
    fallback_path="${3:-}" context_status=0
  local frozen_missing_path="${4-$fallback_path}"

  openclaw_prepare_frozen_target_context "$source_root" || context_status=$?
  case "$context_status" in
    0)
      if openclaw_frozen_target_source_has_path "$source_root" "$relative_path"; then
        printf '%s\n' "$source_root/$relative_path"
        return
      fi
      printf '%s\n' "$frozen_missing_path"
      return
      ;;
    1) ;;
    *) return "$context_status" ;;
  esac
  printf '%s\n' "$fallback_path"
}

openclaw_frozen_target_source_has_path() {
  local source_root="${1:?missing selected source root}" relative_path="${2:?missing relative path}"
  git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:$relative_path" 2>/dev/null
}

openclaw_frozen_target_source_contains() {
  local source_root="${1:?missing selected source root}" relative_path="${2:?missing relative path}" needle="${3:?missing text}"
  # Do not use grep -q here: every caller has pipefail enabled, and a matching
  # early exit can turn git show's SIGPIPE into a false "capability absent".
  git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:$relative_path" 2>/dev/null | grep -F -- "$needle" >/dev/null
}

openclaw_resolve_frozen_live_cli_backend_package_mode() {
  local source_root="${1:?missing selected source root}" authorization_status=0

  export OPENCLAW_FROZEN_TARGET_LIVE_CLI_BACKEND_PACKAGE_MODE="current"

  openclaw_prepare_frozen_target_context "$source_root" || authorization_status=$?
  [ "$authorization_status" -eq 1 ] && return 0
  [ "$authorization_status" -eq 0 ] || return "$authorization_status"

  # Older selected releases have no package resolver. Derive that one released
  # capability before Docker so the container never receives control-plane SHAs.
  if ! openclaw_frozen_target_source_contains \
    "$source_root" scripts/print-cli-backend-live-metadata.ts 'resolveCliBackendDockerPackages'; then
    export OPENCLAW_FROZEN_TARGET_LIVE_CLI_BACKEND_PACKAGE_MODE="legacy"
  fi
}

openclaw_resolve_frozen_plugin_harness_capabilities() {
  local source_root="${1:?missing selected source root}" authorization_status=0

  export OPENCLAW_FROZEN_TARGET_PLUGIN_UNINSTALL_MODE="current" \
    OPENCLAW_FROZEN_PLUGIN_PRERELEASE_FIXTURE_DIALECT="current"

  openclaw_prepare_frozen_target_context "$source_root" || authorization_status=$?
  [ "$authorization_status" -eq 1 ] && return 0
  [ "$authorization_status" -eq 0 ] || return "$authorization_status"

  # The old plugin sweep asserted removal but predated the canonical disabled
  # marker. Only that selected, packaged assertion dialect may relax the marker.
  if openclaw_frozen_target_source_contains "$source_root" scripts/e2e/lib/plugins/assertions.mjs 'function assertPluginTgzRemoved()' &&
    ! openclaw_frozen_target_source_contains "$source_root" scripts/e2e/lib/plugins/assertions.mjs 'function assertPluginUninstallConfigState('; then
    export OPENCLAW_FROZEN_TARGET_PLUGIN_UNINSTALL_MODE="legacy"
  fi

  if openclaw_frozen_target_source_contains "$source_root" src/config/types.messages.ts 'tts?: TtsConfig;' &&
    openclaw_frozen_target_source_contains "$source_root" src/config/types.plugins.ts 'bundledDiscovery?: "compat" | "allowlist";' &&
    openclaw_frozen_target_source_contains "$source_root" src/plugin-sdk/session-store-runtime.ts 'before SQLite migration' &&
    ! openclaw_frozen_target_source_has_path "$source_root" src/plugins/uninstall-package-plan.ts; then
    export OPENCLAW_FROZEN_PLUGIN_PRERELEASE_FIXTURE_DIALECT="legacy"
  fi
}

openclaw_append_frozen_plugin_harness_docker_env() {
  if [[ "${OPENCLAW_FROZEN_TARGET_PLUGIN_UNINSTALL_MODE:-current}" == "legacy" ]]; then
    DOCKER_ENV_ARGS+=( -e "OPENCLAW_FROZEN_TARGET_PLUGIN_UNINSTALL_MODE=legacy" )
  fi
  if [[ "${OPENCLAW_FROZEN_PLUGIN_PRERELEASE_FIXTURE_DIALECT:-current}" == "legacy" ]]; then
    DOCKER_ENV_ARGS+=( -e "OPENCLAW_FROZEN_PLUGIN_PRERELEASE_FIXTURE_DIALECT=legacy" )
  fi
}

openclaw_resolve_frozen_core_harness_capabilities() {
  local source_root="${1:?missing selected source root}" authorization_status=0

  export OPENCLAW_FROZEN_TARGET_ONBOARD_CASES="" \
    OPENCLAW_FROZEN_TARGET_ONBOARD_SESSION_MEMORY_HOOK_MODE="required" \
    OPENCLAW_FROZEN_TARGET_AGENT_BUNDLE_MCP_MODE="current" \
    OPENCLAW_FROZEN_TARGET_MCP_MEMORY_CONFIG_MODE="current" \
    OPENCLAW_FROZEN_TARGET_MCP_CODE_MODE_CATALOG_MODE="current" \
    OPENCLAW_FROZEN_TARGET_RUNTIME_CONTEXT_INPUT_MODE="producer-fragments" \
    OPENCLAW_FROZEN_TARGET_SESSION_REPAIR_MODE="sqlite"

  openclaw_prepare_frozen_target_context "$source_root" || authorization_status=$?
  [ "$authorization_status" -eq 1 ] && return 0
  [ "$authorization_status" -eq 0 ] || return "$authorization_status"

  # The pre-consent onboarding flow does not accept the wizard record or the
  # newer guided case. Run its own established non-interactive coverage.
  if ! openclaw_frozen_target_source_contains "$source_root" src/config/zod-schema.ts 'securityAcknowledgedAt:' &&
    openclaw_frozen_target_source_contains "$source_root" src/config/zod-schema.ts 'lastRunAt:'; then
    export OPENCLAW_FROZEN_TARGET_ONBOARD_CASES="local-basic,remote-non-interactive,reset,channels,skills"
  fi

  # Before default-hook onboarding, quickstart offered only the hooks it found
  # in the workspace. A successful old quickstart therefore cannot promise a
  # session-memory entry when that workspace shipped no hook definition.
  if openclaw_frozen_target_source_has_path "$source_root" src/commands/onboard-hooks.ts &&
    openclaw_frozen_target_source_contains "$source_root" src/commands/onboard-hooks.ts 'setupInternalHooks' &&
    ! openclaw_frozen_target_source_contains "$source_root" src/commands/onboard-hooks.ts 'enableDefaultOnboardingInternalHooks'; then
    export OPENCLAW_FROZEN_TARGET_ONBOARD_SESSION_MEMORY_HOOK_MODE="interactive"
  fi

  if openclaw_frozen_target_source_contains "$source_root" src/agents/memory-search.ts 'cfg.agents?.defaults?.memorySearch'; then
    export OPENCLAW_FROZEN_TARGET_MCP_MEMORY_CONFIG_MODE="agent"
  fi

  if ! openclaw_frozen_target_source_has_path "$source_root" src/state/openclaw-agent-db-session-migrations.ts &&
    openclaw_frozen_target_source_contains "$source_root" src/commands/doctor-session-transcripts.ts '.pre-doctor-branch-repair-'; then
    export OPENCLAW_FROZEN_TARGET_SESSION_REPAIR_MODE="jsonl"
  fi

  local runtime_context_path="src/agents/embedded-agent-runner/run/runtime-context-prompt.ts"
  local has_legacy_runtime_context=0 has_producer_runtime_context=0
  if openclaw_frozen_target_source_contains "$source_root" "$runtime_context_path" 'extractInternalRuntimeContext' &&
    openclaw_frozen_target_source_contains "$source_root" "$runtime_context_path" 'modelPrompt?: string;'; then
    has_legacy_runtime_context=1
  fi
  if openclaw_frozen_target_source_contains "$source_root" "$runtime_context_path" 'fragments?: RuntimeContextFragment[];' &&
    openclaw_frozen_target_source_contains "$source_root" "$runtime_context_path" 'const fragments = params.fragments?.filter'; then
    has_producer_runtime_context=1
  fi
  case "$has_producer_runtime_context:$has_legacy_runtime_context" in
    1:0) ;;
    0:1)
      export OPENCLAW_FROZEN_TARGET_RUNTIME_CONTEXT_INPUT_MODE="legacy-marked-prompt"
      ;;
    *)
      echo "unable to resolve frozen runtime-context input contract from selected source" >&2
      return 2
      ;;
  esac

  # The selected release exposes ALL_TOOLS to code mode but predates the
  # catalog global. Its fixture must use the global the package actually ships.
  if openclaw_frozen_target_source_contains "$source_root" src/agents/code-mode-namespaces.ts '"ALL_TOOLS"' &&
    ! openclaw_frozen_target_source_contains "$source_root" src/agents/code-mode-namespaces.ts '"catalog"'; then
    export OPENCLAW_FROZEN_TARGET_MCP_CODE_MODE_CATALOG_MODE="legacy"
  fi

  # The manager API and MCP App assertions were added after the selected
  # release. Run its still-packaged bundle-MCP contract instead of importing a
  # new dist entry the release cannot contain.
  if ! git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:src/agents/agent-bundle-mcp-manager-api.ts" 2>/dev/null &&
    git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:src/agents/agent-bundle-mcp-runtime.ts" 2>/dev/null &&
    git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:scripts/e2e/agent-bundle-mcp-tools-docker-client.ts" 2>/dev/null; then
    export OPENCLAW_FROZEN_TARGET_AGENT_BUNDLE_MCP_MODE="legacy"
  fi
}
