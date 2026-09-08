#!/usr/bin/env bash

extract_openclaw_semver() {
  local raw="${1:-}"
  raw="${raw//$'\r'/}"
  if [[ "$raw" =~ v?([0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?(\+[0-9A-Za-z.-]+)?) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

quiet_npm() {
  npm \
    --loglevel=error \
    --logs-max=0 \
    --no-update-notifier \
    --no-fund \
    --no-audit \
    --no-progress \
    "$@"
}

resolve_previous_npm_version() {
  local package_name="$1"
  local target_version="$2"
  local versions_json
  versions_json="$(quiet_npm view "$package_name" versions --json)" || return
  # npm sorts versions by SemVer. Anchor to the selected target so newer
  # publications cannot silently turn upgrade coverage into a downgrade.
  VERSIONS_JSON="$versions_json" node - "$package_name" "$target_version" <<'NODE'
const [packageName, target] = process.argv.slice(2);
const versions = JSON.parse(process.env.VERSIONS_JSON || "[]");
const index = Array.isArray(versions) ? versions.lastIndexOf(target) : -1;
if (index <= 0) {
  console.error(`No published predecessor for ${packageName}@${target}. Set an explicit previous version or skip preinstallation for a fresh-install test.`);
  process.exit(2);
}
process.stdout.write(versions[index - 1]);
NODE
}
