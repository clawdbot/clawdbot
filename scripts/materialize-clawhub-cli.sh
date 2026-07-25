#!/usr/bin/env bash

set -euo pipefail

source_root="${1:?trusted ClawHub CLI source root is required}"
destination="${2:?ClawHub CLI destination is required}"
github_output="${3:-}"

package_json="${source_root}/package.json"
package_lock="${source_root}/package-lock.json"
expected_lock_sha256="f44f670d70f13a8cde566a174cae5be682ad98456ec7a85aafd497f7d8c71816"
expected_clawhub_integrity="sha512-YvUImhsVaM90BUAv3uP7lfABziwR5XL3ch2Owa+GvNxwQ2xzZFmZC0yVjAtQbvep+dDDS16nUGRwKx7jqnTOEA=="
test -f "${package_json}"
test -f "${package_lock}"
if [[ -e "${destination}" || -L "${destination}" ]]; then
  echo "ClawHub CLI destination must not already exist: ${destination}" >&2
  exit 1
fi

install -d -m 0700 "${destination}"
install -m 0600 "${package_json}" "${destination}/package.json"
install -m 0600 "${package_lock}" "${destination}/package-lock.json"

lock_sha256="$(
  CLAWHUB_CLI_LOCK="${package_lock}" \
    node -e "const { createHash } = require('node:crypto'); const { readFileSync } = require('node:fs'); process.stdout.write(createHash('sha256').update(readFileSync(process.env.CLAWHUB_CLI_LOCK)).digest('hex'));"
)"
[[ "${lock_sha256}" == "${expected_lock_sha256}" ]] || {
  echo "Pinned ClawHub CLI lock SHA-256 mismatch." >&2
  exit 1
}
clawhub_integrity="$(
  CLAWHUB_CLI_LOCK="${package_lock}" \
    node -p "require(require('node:path').resolve(process.env.CLAWHUB_CLI_LOCK)).packages['node_modules/clawhub'].integrity"
)"
[[ "${clawhub_integrity}" == "${expected_clawhub_integrity}" ]] || {
  echo "Pinned ClawHub CLI integrity mismatch." >&2
  exit 1
}

npm ci \
  --prefix "${destination}" \
  --ignore-scripts \
  --no-audit \
  --no-fund \
  --omit=dev

clawhub_version="$(
  CLAWHUB_CLI_ROOT="${destination}" \
    node -p "require(require('node:path').join(process.env.CLAWHUB_CLI_ROOT, 'node_modules/clawhub/package.json')).version"
)"
[[ "${clawhub_version}" == "0.23.1" ]] || {
  echo "Pinned ClawHub CLI version mismatch: ${clawhub_version}" >&2
  exit 1
}
test -x "${destination}/node_modules/.bin/clawhub"
clawhub_cli="${destination}/node_modules/.bin/clawhub"

echo "Materialized clawhub@${clawhub_version} from lock ${lock_sha256}."
if [[ -n "${github_output}" ]]; then
  {
    echo "cli=${clawhub_cli}"
    echo "integrity=${clawhub_integrity}"
    echo "lock_sha256=${lock_sha256}"
    echo "version=${clawhub_version}"
  } >> "${github_output}"
fi
