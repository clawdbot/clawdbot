#!/usr/bin/env bash

set -euo pipefail

mode="${1:-}"
package_dir="${2:-}"

if [[ "${mode}" != "--dry-run" && "${mode}" != "--publish" ]]; then
  echo "usage: bash scripts/plugin-clawhub-publish.sh [--dry-run|--publish] <package-dir>" >&2
  exit 2
fi

if [[ -z "${package_dir}" ]]; then
  echo "missing package dir" >&2
  exit 2
fi

if [[ ! "${package_dir}" =~ ^extensions/[a-z0-9][a-z0-9._-]*$ ]]; then
  echo "invalid package dir: ${package_dir}" >&2
  exit 2
fi

if [[ ! -f "${package_dir}/package.json" ]]; then
  echo "package.json not found under ${package_dir}" >&2
  exit 2
fi

if ! command -v clawhub >/dev/null 2>&1; then
  echo "clawhub CLI is required on PATH" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
package_name="$(node -e 'const pkg = require(require("node:path").resolve(process.argv[1], "package.json")); console.log(pkg.name)' "${package_dir}")"
package_version="$(node -e 'const pkg = require(require("node:path").resolve(process.argv[1], "package.json")); console.log(pkg.version)' "${package_dir}")"
publish_tag="${PACKAGE_TAG:-latest}"
source_repo="${SOURCE_REPO:-${GITHUB_REPOSITORY:-openclaw/openclaw}}"
source_commit="${SOURCE_COMMIT:-$(git rev-parse HEAD)}"
source_ref="${SOURCE_REF:-$(git symbolic-ref -q HEAD || true)}"
clawhub_workdir="${CLAWDHUB_WORKDIR:-${CLAWHUB_WORKDIR:-$(pwd)}}"
package_source="${package_dir}"

if [[ "${package_source}" != /* && "${package_source}" != ./* ]]; then
  package_source="./${package_source}"
fi

pack_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-clawhub-pack.XXXXXX")"
cleanup() {
  rm -rf "${pack_dir}"
}
trap cleanup EXIT

pack_cmd=(
  clawhub
  package
  pack
  "${package_source}"
  --pack-destination
  "${pack_dir}"
  --json
)

build_package_runtime() {
  if [[ "${OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD:-1}" == "0" || "${OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD:-1}" == "false" ]]; then
    echo "Package-local runtime build: skipped"
    return
  fi
  echo "Package-local runtime build: ${package_dir}"
  node "${repo_root}/scripts/lib/plugin-npm-runtime-build.mjs" "${package_dir}" >&2
}

echo "Resolved package dir: ${package_dir}"
echo "Resolved package source: ${package_source}"
echo "Resolved package name: ${package_name}"
echo "Resolved package version: ${package_version}"
echo "Resolved publish tag: ${publish_tag}"
echo "Resolved source repo: ${source_repo}"
echo "Resolved source commit: ${source_commit}"
echo "Resolved source ref: ${source_ref:-<missing>}"
echo "Resolved ClawHub workdir: ${clawhub_workdir}"
echo "Publish auth: GitHub Actions OIDC via ClawHub short-lived token"

printf 'Pack command: CLAWHUB_WORKDIR=%q' "${clawhub_workdir}"
printf ' %q' "${pack_cmd[@]}"
printf '\n'

build_package_runtime

pack_json="${pack_dir}/pack.json"
CLAWHUB_WORKDIR="${clawhub_workdir}" \
  node "${repo_root}/scripts/lib/plugin-npm-package-manifest.mjs" --run "${package_dir}" -- \
  "${pack_cmd[@]}" > "${pack_json}"
pack_output="$(cat "${pack_json}")"
printf '%s\n' "${pack_output}"

pack_path="$(
  PACK_OUTPUT="${pack_output}" node --input-type=module <<'EOF'
import { resolve } from "node:path";

const raw = process.env.PACK_OUTPUT ?? "";
let parsed;
try {
  parsed = JSON.parse(raw);
} catch (error) {
  console.error(`clawhub package pack did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (!parsed || typeof parsed.path !== "string" || parsed.path.trim() === "") {
  console.error("clawhub package pack output did not include a tarball path.");
  process.exit(1);
}
console.log(resolve(parsed.path));
EOF
)"

if [[ ! -f "${pack_path}" ]]; then
  echo "ClawPack tarball not found: ${pack_path}" >&2
  exit 1
fi

publish_cmd=(
  clawhub
  package
  publish
  "${pack_path}"
  --tags
  "${publish_tag}"
  --source-repo
  "${source_repo}"
  --source-commit
  "${source_commit}"
  --source-path
  "${package_dir}"
)

if [[ -n "${source_ref}" ]]; then
  publish_cmd+=(
    --source-ref
    "${source_ref}"
  )
fi

echo "Resolved ClawPack: ${pack_path}"

printf 'Publish command: CLAWHUB_WORKDIR=%q' "${clawhub_workdir}"
printf ' %q' "${publish_cmd[@]}"
printf '\n'

if [[ "${mode}" == "--dry-run" ]]; then
  CLAWHUB_WORKDIR="${clawhub_workdir}" "${publish_cmd[@]}" --dry-run
  exit 0
fi

publish_log="${pack_dir}/publish.log"
for attempt in $(seq 1 "${OPENCLAW_CLAWHUB_PUBLISH_ATTEMPTS:-8}"); do
  if CLAWHUB_WORKDIR="${clawhub_workdir}" "${publish_cmd[@]}" > >(tee "${publish_log}") 2>&1; then
    exit 0
  fi
  if ! grep -Eqi "rate limit|too many requests|\\b429\\b" "${publish_log}"; then
    exit 1
  fi
  echo "ClawHub publish hit a rate limit; retrying (${attempt}/${OPENCLAW_CLAWHUB_PUBLISH_ATTEMPTS:-8})." >&2
  sleep "${OPENCLAW_CLAWHUB_PUBLISH_RETRY_DELAY_SECONDS:-60}"
done

echo "ClawHub publish failed after ${OPENCLAW_CLAWHUB_PUBLISH_ATTEMPTS:-8} attempts." >&2
exit 1
