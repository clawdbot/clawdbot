// NPM CLI fixture writers used by installer shell-script tests.
import { chmodSync, writeFileSync } from "node:fs";

export function writeNpmFreshnessConflictFixture(path: string, argsLog: string) {
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}`,
      'if [[ "$1" == "config" && "$2" == "get" && "$3" == "min-release-age" ]]; then',
      "  printf 'null\\n'",
      "  exit 0",
      "fi",
      'if [[ "$1" == "config" && "$2" == "get" && "$3" == "before" ]]; then',
      "  printf 'Wed May 13 2026 21:25:20 GMT-0300 (Brasilia Standard Time)\\n'",
      "  exit 0",
      "fi",
      'for arg in "$@"; do',
      '  if [[ "$arg" == --before=* ]]; then',
      "    printf '%s\\n' 'Exit prior to config file resolving' >&2",
      "    printf '%s\\n' 'cause' >&2",
      "    printf '%s\\n' '--min-release-age cannot be provided when using --before' >&2",
      "    exit 64",
      "  fi",
      "done",
      'for arg in "$@"; do',
      '  if [[ "$arg" == "--min-release-age=0" ]]; then',
      "    exit 0",
      "  fi",
      "done",
      "exit 65",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

export function writeNpmBeforePolicyFixture(path: string, argsLog: string) {
  writeFileSync(
    path,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}`,
      'if [[ "$1" == "config" && "$2" == "get" && "$3" == "min-release-age" ]]; then',
      "  printf 'null\\n'",
      "  exit 0",
      "fi",
      'if [[ "$1" == "config" && "$2" == "get" && "$3" == "before" ]]; then',
      "  printf 'Wed May 13 2026 21:25:20 GMT-0300 (Brasilia Standard Time)\\n'",
      "  exit 0",
      "fi",
      'for arg in "$@"; do',
      '  if [[ "$arg" == "--min-release-age=0" ]]; then',
      "    printf '%s\\n' 'min-release-age should not be selected for project-only npmrc' >&2",
      "    exit 64",
      "  fi",
      "done",
      'for arg in "$@"; do',
      '  if [[ "$arg" == --before=* ]]; then',
      "    exit 0",
      "  fi",
      "done",
      "exit 65",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}
