#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

archive=""
output_dir=""
harness_dir=""
image=""
repository=""
target_sha=""
harness_repository=""
harness_sha=""
run_id=""
run_attempt=""
allow_unreleased_changelog="false"
mode="package"
install_policy="installer"
registry_output_dir=""
candidate_version=""
required_packages_json=""
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || fail "missing value for $1"
  case "$1" in
    --archive) archive="$2" ;;
    --output-dir) output_dir="$2" ;;
    --harness-dir) harness_dir="$2" ;;
    --image) image="$2" ;;
    --repository) repository="$2" ;;
    --target-sha) target_sha="$2" ;;
    --harness-repository) harness_repository="$2" ;;
    --harness-sha) harness_sha="$2" ;;
    --run-id) run_id="$2" ;;
    --run-attempt) run_attempt="$2" ;;
    --allow-unreleased-changelog) allow_unreleased_changelog="$2" ;;
    --mode) mode="$2" ;;
    --install-policy) install_policy="$2" ;;
    --registry-output-dir) registry_output_dir="$2" ;;
    --candidate-version) candidate_version="$2" ;;
    --required-packages-json) required_packages_json="$2" ;;
    *) fail "unknown candidate packaging argument: $1" ;;
  esac
  shift 2
done
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  fail "repository must be an owner/repository slug"
for component in "${repository%%/*}" "${repository#*/}"; do
  [[ "$component" != "." && "$component" != ".." ]] || fail "invalid repository component"
done
[[ "$harness_repository" == "openclaw/openclaw" ]] ||
  fail "harness repository must be openclaw/openclaw"
[[ "$target_sha" =~ ^[0-9a-f]{40}$ && "$harness_sha" =~ ^[0-9a-f]{40}$ ]] ||
  fail "target and harness SHA must be full lowercase commit SHAs"
[[ "$run_id" =~ ^[1-9][0-9]*$ && "$run_attempt" =~ ^[1-9][0-9]*$ ]] ||
  fail "run ID and attempt must be positive integers"
[[ "$allow_unreleased_changelog" == "true" || "$allow_unreleased_changelog" == "false" ]] ||
  fail "allow-unreleased-changelog must be true or false"
[[ "$mode" == "package" || "$mode" == "registry-only" ]] || fail "unknown candidate packaging mode"
[[ "$install_policy" == "installer" || "$install_policy" == "package-candidate" ]] ||
  fail "unknown candidate install policy"
if [[ "$mode" == "package" ]]; then
  [[ -n "$output_dir" ]] || fail "package mode requires an output directory"
else
  [[ -z "$output_dir" && -n "$registry_output_dir" ]] ||
    fail "registry-only requires a registry output directory and no package output"
fi
if [[ -n "$registry_output_dir$candidate_version$required_packages_json" ]]; then
  [[ -n "$registry_output_dir" && -n "$candidate_version" && -n "$required_packages_json" ]] ||
    fail "registry output, candidate version and required packages JSON must be supplied together"
fi
[[ -n "$image" && -d "$harness_dir" ]] ||
  fail "trusted image and existing harness directory are required"
seal_uid="$(id -u)"
seal_gid="$(id -g)"
[[ "$seal_uid" != 0 ]] || fail "run candidate packaging as a non-root host user"
[[ -f "$archive" && ! -L "$archive" ]] || fail "candidate archive must be a regular file"
[[ "$(git -C "$harness_dir" rev-parse --verify 'HEAD^{commit}')" == "$harness_sha" ]] ||
  fail "harness HEAD differs from the verified workflow SHA"
archive="$(realpath "$archive")"
harness_dir="$(realpath "$harness_dir")"
# Pin both phases to the same trusted image before candidate execution.
image="$(docker image inspect --format '{{.Id}}' "$image")"
[[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "trusted image must resolve to an immutable image ID"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-candidate.XXXXXXXX")"
if python3 "$harness_dir/scripts/docker/pack-candidate-data.py" prepare \
  --archive "$archive" --harness-dir "$harness_dir" --scratch "$scratch" \
  --output-dir "$output_dir" --registry-output-dir "$registry_output_dir" \
  --candidate-version "$candidate_version" --required-packages-json "$required_packages_json"; then
  :
else
  status=$?
  rm -rf -- "$scratch"
  exit "$status"
fi
[[ -z "$output_dir" ]] || output_dir="$(realpath "$output_dir")"
[[ -z "$registry_output_dir" ]] || registry_output_dir="$(realpath "$registry_output_dir")"
package_dir="$scratch/package"
registry_dir="$scratch/registry"
worker_mounts=()
seal_mounts=()
if [[ "$mode" == "package" ]]; then
  mkdir "$package_dir"
  chmod 0777 "$package_dir"
  worker_mounts+=(-v "$package_dir:/output")
  seal_mounts+=(-v "$package_dir:/package:ro" -v "$output_dir:/payload")
fi
if [[ -n "$registry_output_dir" ]]; then
  mkdir "$registry_dir"
  chmod 0777 "$registry_dir"
  worker_mounts+=(-v "$registry_dir:/registry-output")
  seal_mounts+=(-v "$registry_dir:/registry-input:ro" -v "$registry_output_dir:/registry")
fi
build_container="openclaw-candidate-build-${scratch##*.}"
seal_container="openclaw-candidate-seal-${scratch##*.}"
command_token=""
remove_containers() {
  local status=0
  local container
  local inventory
  containers_absent=1
  for container in "$@"; do
    if ! inventory="$(timeout --kill-after=10s 30s docker container ls --all \
      --filter "name=$container" --format '{{.Names}}')"; then
      echo "cannot inventory candidate container: $container" >&2
      status=1
      containers_absent=0
      continue
    fi
    if grep -Fx -- "$container" <<<"$inventory" >/dev/null; then
      timeout --kill-after=10s 30s docker rm -f "$container" >/dev/null || status=1
      if ! inventory="$(timeout --kill-after=10s 30s docker container ls --all \
        --filter "name=$container" --format '{{.Names}}')" ||
        grep -Fx -- "$container" <<<"$inventory" >/dev/null; then
        echo "candidate container absence unconfirmed after removal: $container" >&2
        status=1
        containers_absent=0
        continue
      fi
    fi
    echo "confirmed candidate container absent: $container" >&2
  done
  return "$status"
}
cleanup() {
  local status=$?
  local cleanup_status=0
  trap - EXIT INT TERM
  remove_containers "$build_container" "$seal_container" || cleanup_status=$?
  if [[ "$containers_absent" == 1 ]]; then
    rm -rf -- "$scratch" || cleanup_status=1
  else
    echo "candidate scratch retained while container absence is unconfirmed" >&2
  fi
  if [[ -n "$command_token" ]]; then
    printf '::%s::\n' "$command_token" >&2
  fi
  if [[ "$status" == 0 ]]; then
    status="$cleanup_status"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Candidate stdout/stderr is evidence, never an Actions command channel.
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  command_token="$(openssl rand -hex 32)"
  printf '::stop-commands::%s\n' "$command_token" >&2
fi
timeout --kill-after=30s 50m docker run --rm --init \
  --name "$build_container" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 1024 \
  --user node \
  --entrypoint /bin/bash \
  -e "ALLOW_UNRELEASED_CHANGELOG=$allow_unreleased_changelog" \
  -e "MODE=$mode" \
  -e "INSTALL_POLICY=$install_policy" \
  -e "REPOSITORY=$repository" \
  -e "TARGET_SHA=$target_sha" \
  -e "CANDIDATE_VERSION=$candidate_version" \
  -e "REQUIRED_PACKAGES_JSON=$required_packages_json" \
  -e CI=1 \
  -v "$archive:/input/candidate.tar.gz:ro" \
  "${worker_mounts[@]}" \
  -v "$scratch/harness:/harness:ro" \
  "$image" -lc '
    set -euo pipefail
    test "$(id -u)" -ne 0
    export HOME="$(mktemp -d)"
    export XDG_CONFIG_HOME="$HOME/.config"
    export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
    export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false GIT_NO_REPLACE_OBJECTS=1
    mkdir -p "$XDG_CONFIG_HOME" "$HOME/git-template"
    source_dir="$(mktemp -d)"
    if [[ -n "$CANDIDATE_VERSION" ]]; then
      git_safe() {
        env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" XDG_CONFIG_HOME="$XDG_CONFIG_HOME" \
          LANG=C.UTF-8 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
          GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false GIT_SSH_COMMAND=/bin/false \
          GIT_NO_REPLACE_OBJECTS=1 \
          git -c credential.helper= -c core.hooksPath=/dev/null \
            -c protocol.allow=never -c protocol.https.allow=always \
            -c http.sslVerify=true -c core.autocrlf=false "$@"
      }
      git_safe init --template="$HOME/git-template" "$source_dir"
      cd "$source_dir"
      git_safe fetch --no-tags --no-recurse-submodules --depth=1 \
        "https://github.com/$REPOSITORY.git" "$TARGET_SHA"
      test "$(git_safe rev-parse --verify "${TARGET_SHA}^{commit}")" = "$TARGET_SHA"
      git_safe checkout --detach "$TARGET_SHA"
      python3 /harness/scripts/docker/pack-candidate-data.py compare \
        --archive /input/candidate.tar.gz --source-dir "$source_dir" \
        --candidate-version "$CANDIDATE_VERSION" --target-sha "$TARGET_SHA"
    else
      tar -xzf /input/candidate.tar.gz \
        --strip-components=1 \
        --no-same-owner \
        --no-same-permissions \
        -C "$source_dir"
    fi
    cd "$source_dir"
    if [[ "$MODE" == "package" ]]; then
      preflight_args=(--source-dir "$source_dir")
      if [[ "$ALLOW_UNRELEASED_CHANGELOG" == "true" ]]; then
        preflight_args+=(--allow-unreleased-changelog)
      fi
      node /harness/scripts/package-source-preflight.mjs "${preflight_args[@]}"
    fi
    mkdir -p /tmp/corepack
    corepack enable --install-directory /tmp/corepack
    export PATH="/tmp/corepack:$PATH"
    if [[ "$INSTALL_POLICY" == "package-candidate" || -n "$CANDIDATE_VERSION" ]]; then
      pnpm install --frozen-lockfile --config.ignore-scripts=false \
        --config.engine-strict=false --config.enable-pre-post-scripts=true
    else
      pnpm install --frozen-lockfile
    fi
    if [[ "$MODE" == "package" ]]; then
      package_args=(--source-dir "$source_dir" --output-dir /output --output-name candidate.tgz)
      # Frozen Node-native packers intentionally omit this newer option.
      if [[ "$ALLOW_UNRELEASED_CHANGELOG" == "true" ]] && \
        grep -Fq -- "--allow-unreleased-changelog" scripts/package-openclaw-for-docker.mts; then
        package_args+=(--allow-unreleased-changelog)
      fi
      node scripts/package-openclaw-for-docker.mjs "${package_args[@]}"
    fi
    if [[ -n "$CANDIDATE_VERSION" ]]; then
      node /harness/scripts/prepublish-plugin-registry-artifact.mjs create \
        --repo-root "$source_dir" --artifact-dir /registry-output \
        --source-sha "$TARGET_SHA" --candidate-version "$CANDIDATE_VERSION" \
        --required-packages-json "$REQUIRED_PACKAGES_JSON"
    fi
  ' >&2

# Reuse the accepted absence check as a barrier against background writers.
remove_containers "$build_container"
timeout --kill-after=30s 5m docker run --rm --init \
  --name "$seal_container" \
  --network none \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 1024 \
  --user "$seal_uid:$seal_gid" \
  --entrypoint python3 \
  -v "$scratch/harness:/harness:ro" \
  -v "$archive:/input/candidate.tar.gz:ro" \
  "${seal_mounts[@]}" \
  "$image" /harness/scripts/docker/pack-candidate-data.py seal \
    --harness-dir /harness \
    --mode "$mode" \
    --archive /input/candidate.tar.gz \
    --package-dir /package \
    --output-dir "${output_dir:+/payload}" \
    --registry-dir /registry-input \
    --registry-output-dir "${registry_output_dir:+/registry}" \
    --reported-registry-dir "$registry_output_dir" \
    --candidate-version "$candidate_version" \
    --required-packages-json "$required_packages_json" \
    --repository "$repository" \
    --target-sha "$target_sha" \
    --harness-repository "$harness_repository" \
    --harness-sha "$harness_sha" \
    --run-id "$run_id" \
    --run-attempt "$run_attempt"
