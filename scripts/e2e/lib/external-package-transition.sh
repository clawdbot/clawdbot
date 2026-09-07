#!/usr/bin/env bash

# The caller owns the stopped Gateway. This proves external installation, never
# substitutes it for a successful in-process updater result.
openclaw_e2e_external_package_transition() (
  local baseline_version="$1" candidate_version="$2" evidence_dir="$3" stopped_pid="${4:-}"
  if [ -n "$stopped_pid" ] && kill -0 "$stopped_pid" 2>/dev/null; then
    echo "external package transition requires its Gateway owner to finish stopping" >&2
    return 1
  fi
  mkdir -p "$evidence_dir" || return "$?"
  local backup_dir
  backup_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-transition-backup.XXXXXX")" || return "$?"
  trap 'rm -rf "$backup_dir"' EXIT
  chmod 700 "$backup_dir" || return "$?"
  openclaw backup create --verify --output "$backup_dir/before.tar.gz" --json \
    >"$evidence_dir/backup.json" 2>"$evidence_dir/backup.err" || return "$?"

  if { [ "$baseline_version" = "2026.8.2" ] || [ "$baseline_version" = "2026.9.2" ]; } && [ "$candidate_version" = "2026.9.3" ]; then
    node scripts/e2e/lib/external-package-transition.mjs schema 15 \
      >"$evidence_dir/schema-before.json" || return "$?"
  fi

  openclaw_e2e_install_package "$evidence_dir/install.log" "external candidate installation" || return "$?"
  openclaw doctor --fix --non-interactive \
    >"$evidence_dir/doctor.log" 2>&1 || return "$?"
  if { [ "$baseline_version" = "2026.8.2" ] || [ "$baseline_version" = "2026.9.2" ]; } && [ "$candidate_version" = "2026.9.3" ]; then
    node scripts/e2e/lib/external-package-transition.mjs schema 16 \
      >"$evidence_dir/schema-after-doctor.json" || return "$?"
  fi
  node scripts/e2e/lib/external-package-transition.mjs receipt \
    "$baseline_version" "$candidate_version" "$evidence_dir" \
    >"$evidence_dir/transition.json"
)
