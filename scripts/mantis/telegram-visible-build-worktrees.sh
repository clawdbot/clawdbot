#!/usr/bin/env bash
set -euo pipefail
baseline_root="$BASELINE_ROOT"
candidate_root="$CANDIDATE_ROOT"
toolchain=/usr/local/lib/mantis-toolchain
corepack_home="${RUNNER_TEMP}/mantis-corepack"
restored=false
[[ -f "$BASELINE_ARCHIVE" ]] && restored=true
candidate_git_link="$(cat "$candidate_root/.git")"

baseline_build() {
  mkdir -p "${RUNNER_TEMP}/mantis-baseline-home"
  cd "$baseline_root"
  env -i CI=1 COREPACK_HOME="$corepack_home" HOME="${RUNNER_TEMP}/mantis-baseline-home" \
    OPENCLAW_BUILD_PRIVATE_QA=1 OPENCLAW_ENABLE_PRIVATE_QA_CLI=1 \
    PATH="$toolchain:/usr/bin:/bin" "$toolchain/pnpm" install --frozen-lockfile
  if [[ "$restored" == true ]]; then
    tar -C "$baseline_root" -xf "$BASELINE_ARCHIVE"
  fi
  if [[ "$BASELINE_CACHE_HIT" != true ]]; then
    env -i CI=1 COREPACK_HOME="$corepack_home" HOME="${RUNNER_TEMP}/mantis-baseline-home" \
      OPENCLAW_BUILD_PRIVATE_QA=1 OPENCLAW_ENABLE_PRIVATE_QA_CLI=1 OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 \
      PATH="$toolchain:/usr/bin:/bin" "$toolchain/pnpm" build
    mkdir -p "$(dirname "$BASELINE_ARCHIVE")" "$baseline_root/.artifacts/build-all-cache"
    tar -C "$baseline_root" -cf "${BASELINE_ARCHIVE}.new" dist dist-runtime packages/*/dist .artifacts/build-all-cache
    find extensions -type f -path '*/src/host/*' \( -name '.bundle.hash' -o -name '*.bundle.js' \) -print0 \
      | tar --append --file="${BASELINE_ARCHIVE}.new" --null --files-from=-
    mv -T "${BASELINE_ARCHIVE}.new" "$BASELINE_ARCHIVE"
  fi
  test -d dist-runtime
  test -f dist/build-info.json
}

candidate_build() {
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin mantis-builder
  sudo chown -R mantis-builder:mantis-builder "$candidate_root"
  sudo /usr/local/sbin/openclaw-mantis-sut-container build "$candidate_root" "$HOST_PNPM_STORE"
  test "$(cat "$candidate_root/.git")" = "$candidate_git_link"
  git -c safe.directory="$candidate_root" -C "$candidate_root" diff --exit-code
  git -c safe.directory="$candidate_root" -C "$candidate_root" diff --cached --exit-code
  test "$(git -c safe.directory="$candidate_root" -C "$candidate_root" rev-parse HEAD)" = "$CANDIDATE_SHA"
}

(baseline_build 2>&1 | sed -u 's/^/[baseline] /') & baseline_pid=$!
(candidate_build 2>&1 | sed -u 's/^/[candidate] /') & candidate_pid=$!
set +e
wait "$baseline_pid"; baseline_status=$?
wait "$candidate_pid"; candidate_status=$?
set -e
if ((baseline_status != 0 || candidate_status != 0)); then
  echo "::error::Proof build failure: baseline=${baseline_status}, candidate=${candidate_status}."
  exit 1
fi
