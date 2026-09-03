#!/usr/bin/env bash

set -euo pipefail

source_root="${1:?trusted Vercel CLI source root is required}"
destination="${2:?Vercel CLI destination is required}"
github_output="${3:-}"

package_json="${source_root}/package.json"
package_lock="${source_root}/package-lock.json"
expected_lock_sha256="e0dfc23d8bc7d5739dd25b70359a0db456099a2bda4914223136e094e3d7bede"
expected_vercel_integrity="sha512-tQgKXmppJ/uoQZfX+HYAVIxWSUS6V6FMounEEpsHTUqlHyBI/aOATH9sKtkXXD1lQt/JsN4ocWymIGUPLRTxwA=="
test -f "${package_json}"
test -f "${package_lock}"
if [[ -e "${destination}" || -L "${destination}" ]]; then
  echo "Vercel CLI destination must not already exist: ${destination}" >&2
  exit 1
fi

install -d -m 0700 "${destination}"
install -m 0600 "${package_json}" "${destination}/package.json"
install -m 0600 "${package_lock}" "${destination}/package-lock.json"

lock_sha256="$(
  VERCEL_CLI_LOCK="${package_lock}" \
    node -e "const { createHash } = require('node:crypto'); const { readFileSync } = require('node:fs'); process.stdout.write(createHash('sha256').update(readFileSync(process.env.VERCEL_CLI_LOCK)).digest('hex'));"
)"
[[ "${lock_sha256}" == "${expected_lock_sha256}" ]] || {
  echo "Pinned Vercel CLI lock SHA-256 mismatch." >&2
  exit 1
}
vercel_integrity="$(
  VERCEL_CLI_LOCK="${package_lock}" \
    node -p "require(require('node:path').resolve(process.env.VERCEL_CLI_LOCK)).packages['node_modules/vercel'].integrity"
)"
[[ "${vercel_integrity}" == "${expected_vercel_integrity}" ]] || {
  echo "Pinned Vercel CLI integrity mismatch." >&2
  exit 1
}

# Install with lifecycle scripts disabled before any credential is exposed to
# the CLI process. The committed lock fixes the complete dependency closure.
(
  cd "${destination}"
  npm ci \
    --ignore-scripts \
    --no-audit \
    --no-fund \
    --omit=dev
)

vercel_version="$(
  VERCEL_CLI_ROOT="${destination}" \
    node -p "require(require('node:path').join(process.env.VERCEL_CLI_ROOT, 'node_modules/vercel/package.json')).version"
)"
[[ "${vercel_version}" == "59.5.0" ]] || {
  echo "Pinned Vercel CLI version mismatch: ${vercel_version}" >&2
  exit 1
}
test -x "${destination}/node_modules/.bin/vercel"
vercel_cli="${destination}/node_modules/.bin/vercel"
# Use Sandbox directly: Vercel's sandbox wrapper overwrites failed remote exits.
test -x "${destination}/node_modules/.bin/sandbox"
sandbox_cli="${destination}/node_modules/.bin/sandbox"

echo "Materialized vercel@${vercel_version} from lock ${lock_sha256}."
if [[ -n "${github_output}" ]]; then
  {
    echo "cli=${vercel_cli}"
    echo "sandbox_cli=${sandbox_cli}"
    echo "integrity=${vercel_integrity}"
    echo "lock_sha256=${lock_sha256}"
    echo "version=${vercel_version}"
  } >> "${github_output}"
fi
