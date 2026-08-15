#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "usage: bash scripts/plugin-clawhub-publish.sh [--dry-run|--publish|--pack] <package-dir>"
  echo "       bash scripts/plugin-clawhub-publish.sh [--validate-packed|--publish-packed] <clawpack.tgz>"
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

mode="${1:-}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
invocation_root="$(pwd)"

if [[ "${mode}" != "--dry-run" && "${mode}" != "--publish" && "${mode}" != "--pack" &&
  "${mode}" != "--validate-packed" && "${mode}" != "--publish-packed" ]]; then
  usage >&2
  exit 2
fi
shift

if [[ "${1:-}" == "--" ]]; then
  shift
fi
input_path=""
if [[ "$#" -gt 0 ]]; then
  case "$1" in
    -*) echo "unexpected plugin ClawHub package-dir option: $1" >&2; exit 2 ;;
    *) input_path="$1"; shift ;;
  esac
fi
if [[ -z "${input_path}" ]]; then
  echo "missing package dir or ClawPack path" >&2
  exit 2
fi
if [[ "$#" -gt 0 ]]; then
  echo "unexpected plugin ClawHub publish argument: $1" >&2
  exit 2
fi

packed_mode=false
if [[ "${mode}" == "--validate-packed" || "${mode}" == "--publish-packed" ]]; then
  packed_mode=true
fi

package_dir="${PACKAGE_DIR:-}"
clawpack_path=""
if [[ "${packed_mode}" == "true" ]]; then
  clawpack_path="$(cd "$(dirname "${input_path}")" && pwd)/$(basename "${input_path}")"
else
  package_dir="${input_path}"
fi

if [[ ! "${package_dir}" =~ ^extensions/[a-z0-9][a-z0-9._-]*$ ]]; then
  echo "invalid package dir: ${package_dir}" >&2
  exit 2
fi

package_source="${invocation_root}/${package_dir}"

if [[ "${packed_mode}" == "false" && ! -f "${package_source}/package.json" ]]; then
  echo "package.json not found under ${package_dir}" >&2
  exit 2
fi
if [[ "${packed_mode}" == "true" && ! -f "${clawpack_path}" ]]; then
  echo "ClawPack tarball not found: ${clawpack_path}" >&2
  exit 2
fi

clawhub_cli="${OPENCLAW_CLAWHUB_CLI:-}"
if [[ -n "${clawhub_cli}" ]]; then
  if [[ "${clawhub_cli}" != /* || ! -x "${clawhub_cli}" ]]; then
    echo "OPENCLAW_CLAWHUB_CLI must be an absolute executable path" >&2
    exit 1
  fi
else
  clawhub_cli="$(command -v clawhub 2>/dev/null || true)"
  if [[ -z "${clawhub_cli}" ]]; then
    echo "clawhub CLI is required on PATH" >&2
    exit 1
  fi
fi

if [[ "${packed_mode}" == "true" ]]; then
  package_name="${EXPECTED_CLAWHUB_PACKAGE_NAME:-}"
  package_version="${EXPECTED_CLAWHUB_PACKAGE_VERSION:-}"
  if [[ ! "${package_name}" =~ ^@openclaw/[a-z0-9][a-z0-9._-]*$ ]]; then
    echo "EXPECTED_CLAWHUB_PACKAGE_NAME is invalid." >&2
    exit 2
  fi
  if [[ -z "${package_version}" ]]; then
    echo "EXPECTED_CLAWHUB_PACKAGE_VERSION is required." >&2
    exit 2
  fi
else
  package_name="$(node -e 'const pkg = require(require("node:path").resolve(process.argv[1], "package.json")); console.log(pkg.name)' "${package_source}")"
  package_version="$(node -e 'const pkg = require(require("node:path").resolve(process.argv[1], "package.json")); console.log(pkg.version)' "${package_source}")"
fi
publish_tag="${PACKAGE_TAG:-latest}"
source_repo="${SOURCE_REPO:-${GITHUB_REPOSITORY:-openclaw/openclaw}}"
source_commit="${SOURCE_COMMIT:-$(git -C "${invocation_root}" rev-parse HEAD)}"
source_ref="${SOURCE_REF:-$(git -C "${invocation_root}" symbolic-ref -q HEAD || true)}"
clawhub_workdir="${CLAWDHUB_WORKDIR:-${CLAWHUB_WORKDIR:-${invocation_root}}}"
manual_override_reason="${OPENCLAW_CLAWHUB_MANUAL_OVERRIDE_REASON:-}"
release_git_dir="${OPENCLAW_CLAWHUB_RELEASE_GIT_DIR:-}"
release_tag="${OPENCLAW_CLAWHUB_RELEASE_TAG:-}"
release_target_sha="${OPENCLAW_CLAWHUB_TARGET_SHA:-}"
release_binding_count=0
for release_binding_value in "${release_git_dir}" "${release_tag}" "${release_target_sha}"; do
  if [[ -n "${release_binding_value}" ]]; then
    release_binding_count=$((release_binding_count + 1))
  fi
done
if [[ "${release_binding_count}" != "0" && "${release_binding_count}" != "3" ]]; then
  echo "OPENCLAW_CLAWHUB_RELEASE_GIT_DIR, OPENCLAW_CLAWHUB_RELEASE_TAG, and OPENCLAW_CLAWHUB_TARGET_SHA must be provided together." >&2
  exit 2
fi
if [[ "${release_binding_count}" == "3" ]]; then
  if [[ ! -d "${release_git_dir}" || ! "${release_target_sha}" =~ ^[a-f0-9]{40}$ ]]; then
    echo "ClawHub release tag binding is invalid." >&2
    exit 2
  fi
fi

pack_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/openclaw-clawhub-pack.XXXXXX")"
cleanup() {
  rm -rf "${pack_dir}"
}
trap cleanup EXIT

pack_cmd=(
  "${clawhub_cli}"
  --workdir
  "${clawhub_workdir}"
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
echo "Publish auth: ${OPENCLAW_CLAWHUB_AUTH_LABEL:-GitHub Actions OIDC via ClawHub short-lived token}"

if [[ "${packed_mode}" == "false" ]]; then
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

  clawpack_path="${pack_path}"
fi

echo "Resolved ClawPack: ${clawpack_path}"

if [[ "${mode}" == "--pack" ]]; then
  output_dir="${OPENCLAW_CLAWHUB_PACK_OUTPUT_DIR:-}"
  if [[ -z "${output_dir}" ]]; then
    echo "OPENCLAW_CLAWHUB_PACK_OUTPUT_DIR is required for --pack" >&2
    exit 2
  fi
  mkdir -p "${output_dir}"
  output_path="${output_dir}/$(basename "${clawpack_path}")"
  cp "${clawpack_path}" "${output_path}"
  echo "Packed ClawPack: ${output_path}"
  exit 0
fi

verify_packed_identity() {
  local expected_sha="${EXPECTED_CLAWHUB_ARTIFACT_SHA256:-}"
  local expected_size="${EXPECTED_CLAWHUB_ARTIFACT_SIZE:-}"
  if [[ ! "${expected_sha}" =~ ^[a-f0-9]{64}$ ]]; then
    echo "EXPECTED_CLAWHUB_ARTIFACT_SHA256 is invalid." >&2
    exit 2
  fi
  if [[ ! "${expected_size}" =~ ^[1-9][0-9]*$ ]]; then
    echo "EXPECTED_CLAWHUB_ARTIFACT_SIZE is invalid." >&2
    exit 2
  fi

  node "${repo_root}/scripts/lib/clawhub-bootstrap-artifact.mjs" verify-packed \
    --path "${clawpack_path}" \
    --expected-sha256 "${expected_sha}" \
    --expected-size "${expected_size}" \
    --expected-dir "${package_dir}" \
    --expected-name "${package_name}" \
    --expected-version "${package_version}"
}

if [[ "${packed_mode}" == "true" ]]; then
  verify_packed_identity
fi

clawhub_timeout_seconds="${OPENCLAW_CLAWHUB_PUBLISH_ATTEMPT_TIMEOUT_SECONDS:-300}"
if [[ ! "${clawhub_timeout_seconds}" =~ ^[1-9][0-9]*$ || "${clawhub_timeout_seconds}" -gt 900 ]]; then
  echo "OPENCLAW_CLAWHUB_PUBLISH_ATTEMPT_TIMEOUT_SECONDS must be an integer from 1 through 900." >&2
  exit 2
fi
timeout_bin=""
for timeout_candidate in timeout gtimeout; do
  timeout_candidate_path="$(command -v "${timeout_candidate}" 2>/dev/null || true)"
  if [[ -n "${timeout_candidate_path}" ]] &&
    "${timeout_candidate_path}" --signal=TERM --kill-after=1s 1s true >/dev/null 2>&1; then
    timeout_bin="${timeout_candidate_path}"
    break
  fi
done
if [[ -z "${timeout_bin}" ]]; then
  echo "GNU timeout or gtimeout with --signal and --kill-after support is required for bounded ClawHub CLI calls." >&2
  exit 1
fi
clawhub_timeout=(
  "${timeout_bin}"
  --signal=TERM
  --kill-after=10s
  "${clawhub_timeout_seconds}s"
)

validate_packed_publish() {
  local dry_run_json
  dry_run_json="$(
    CLAWHUB_WORKDIR="${clawhub_workdir}" "${clawhub_timeout[@]}" "${clawhub_cli}" \
      --workdir "${clawhub_workdir}" \
      package publish "${clawpack_path}" \
      --tags "${publish_tag}" \
      --source-repo "${source_repo}" \
      --source-commit "${source_commit}" \
      --source-path "${package_dir}" \
      --dry-run \
      --json
  )"
  printf '%s\n' "${dry_run_json}"
  DRY_RUN_JSON="${dry_run_json}" EXPECTED_NAME="${package_name}" EXPECTED_VERSION="${package_version}" \
    node --input-type=module <<'NODE'
const output = JSON.parse(process.env.DRY_RUN_JSON ?? "");
if (output.name !== process.env.EXPECTED_NAME || output.version !== process.env.EXPECTED_VERSION) {
  throw new Error(
    `Packed ClawHub identity mismatch: expected ${process.env.EXPECTED_NAME}@${process.env.EXPECTED_VERSION}, found ${String(output.name)}@${String(output.version)}.`,
  );
}
NODE
}

if [[ "${packed_mode}" == "true" ]]; then
  validate_packed_publish
  if [[ "${mode}" == "--validate-packed" ]]; then
    exit 0
  fi
fi

publish_cmd=(
  "${clawhub_cli}"
  --workdir
  "${clawhub_workdir}"
  package
  publish
  "${clawpack_path}"
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

if [[ -n "${manual_override_reason}" ]]; then
  publish_cmd+=(
    --manual-override-reason
    "${manual_override_reason}"
  )
fi

printf 'Publish command: CLAWHUB_WORKDIR=%q' "${clawhub_workdir}"
printf ' %q' "${publish_cmd[@]}"
printf '\n'

if [[ "${mode}" == "--dry-run" ]]; then
  CLAWHUB_WORKDIR="${clawhub_workdir}" "${clawhub_timeout[@]}" "${publish_cmd[@]}" --dry-run
  exit 0
fi

publish_attempts="${OPENCLAW_CLAWHUB_PUBLISH_ATTEMPTS:-8}"
publish_retry_delay="${OPENCLAW_CLAWHUB_PUBLISH_RETRY_DELAY_SECONDS:-60}"
if [[ ! "${publish_attempts}" =~ ^[1-9][0-9]*$ || "${publish_attempts}" -gt 12 ]]; then
  echo "OPENCLAW_CLAWHUB_PUBLISH_ATTEMPTS must be an integer from 1 through 12." >&2
  exit 2
fi
if [[ ! "${publish_retry_delay}" =~ ^[1-9][0-9]*$ || "${publish_retry_delay}" -gt 300 ]]; then
  echo "OPENCLAW_CLAWHUB_PUBLISH_RETRY_DELAY_SECONDS must be an integer from 1 through 300." >&2
  exit 2
fi

publish_log="${pack_dir}/publish.log"
verify_release_tag_target() {
  if [[ "${release_binding_count}" == "0" ]]; then
    return 0
  fi
  git -C "${release_git_dir}" fetch --force --no-tags origin \
    "+refs/tags/${release_tag}:refs/tags/${release_tag}"
  local tag_sha
  tag_sha="$(git -C "${release_git_dir}" rev-parse "${release_tag}^{commit}")"
  [[ "${tag_sha}" == "${release_target_sha}" ]] || {
    echo "ClawHub publish target ${release_target_sha} no longer matches ${release_tag} (${tag_sha})." >&2
    exit 1
  }
}

for attempt in $(seq 1 "${publish_attempts}"); do
  verify_release_tag_target
  set +e
  CLAWHUB_WORKDIR="${clawhub_workdir}" \
    "${clawhub_timeout[@]}" "${publish_cmd[@]}" 2>&1 | tee "${publish_log}"
  pipeline_status=("${PIPESTATUS[@]}")
  set -e
  publish_status="${pipeline_status[0]}"
  tee_status="${pipeline_status[1]}"
  if [[ "${tee_status}" != "0" ]]; then
    echo "Failed to capture ClawHub publish output." >&2
    exit "${tee_status}"
  fi
  if [[ "${publish_status}" == "0" ]]; then
    exit 0
  fi
  if [[ "${publish_status}" != "124" && "${publish_status}" != "137" ]] &&
    ! grep -Eqi "rate limit|too many requests|\\b(408|425|429|5[0-9]{2})\\b|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|network error|temporarily unavailable" "${publish_log}"; then
    exit 1
  fi
  if [[ "${attempt}" -lt "${publish_attempts}" ]]; then
    echo "ClawHub publish hit a transient failure; retrying (${attempt}/${publish_attempts})." >&2
    sleep "${publish_retry_delay}"
  fi
done

echo "ClawHub publish failed after ${publish_attempts} attempts." >&2
exit 1
