#!/usr/bin/env bash
# Shared owner for dispatch and completion around the immutable ClawHub receipt.
set -euo pipefail

openclaw_npm_expected_workflow_ref="${GITHUB_REF}"
openclaw_npm_expected_workflow_sha="${PARENT_WORKFLOW_SHA}"

is_stable_release() {
  [[ "${RELEASE_TAG}" != *"-alpha."* && "${RELEASE_TAG}" != *"-beta."* ]]
}

is_android_release() {
  [[ "${RELEASE_TAG}" =~ ^v[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(-[1-9][0-9]*)?$ ]]
}

verify_child_run_sha() {
  local workflow="$1"
  local run_id="$2"
  local expected_sha="$3"
  local run_json child_head_sha child_url attempt

  run_json=""
  for attempt in $(seq 1 12); do
    if run_json="$(gh run view --repo "$GITHUB_REPOSITORY" "$run_id" --json headSha,url 2>/dev/null)"; then
      child_head_sha="$(printf '%s' "$run_json" | jq -r '.headSha // ""')"
      if [[ -n "$child_head_sha" ]]; then
        break
      fi
    fi
    if [[ "$attempt" != "12" ]]; then
      sleep 5
    fi
  done

  child_head_sha="$(printf '%s' "$run_json" | jq -r '.headSha // ""' 2>/dev/null || true)"
  child_url="$(printf '%s' "$run_json" | jq -r '.url // ""' 2>/dev/null || true)"
  if [[ "$child_head_sha" != "$expected_sha" ]]; then
    echo "${workflow} child run ${run_id} used workflow SHA ${child_head_sha:-<missing>}, expected ${expected_sha}: ${child_url}" >&2
    gh run cancel --repo "$GITHUB_REPOSITORY" "$run_id" >/dev/null 2>&1 || true
    return 1
  fi
}

dispatch_workflow_at_ref() {
  local workflow_ref="$1"
  local expected_sha="$2"
  shift 2
  local workflow="$1"
  shift

  local dispatch_body dispatch_response encoded_workflow_ref field key resolved_workflow_sha run_id run_url value
  encoded_workflow_ref="$(jq -rn --arg value "$workflow_ref" '$value | @uri')"
  resolved_workflow_sha="$(
    gh api "repos/${GITHUB_REPOSITORY}/commits/${encoded_workflow_ref}" \
      --jq '.sha | select(test("^[a-f0-9]{40}$"))'
  )"
  if [[ "$resolved_workflow_sha" != "$expected_sha" ]]; then
    echo "Child workflow ref ${workflow_ref} resolved to ${resolved_workflow_sha}, expected ${expected_sha}; refusing dispatch." >&2
    exit 1
  fi

  local inputs_json='{}'
  while (( $# > 0 )); do
    if [[ "$1" != "-f" && "$1" != "--raw-field" && "$1" != "-F" && "$1" != "--field" ]]; then
      echo "Unsupported workflow dispatch argument for ${workflow}: $1" >&2
      exit 1
    fi
    if (( $# < 2 )) || [[ "$2" != *=* ]]; then
      echo "Workflow dispatch fields must use key=value syntax for ${workflow}." >&2
      exit 1
    fi
    field="$2"
    shift 2
    key="${field%%=*}"
    value="${field#*=}"
    inputs_json="$(jq -cn \
      --argjson inputs "$inputs_json" \
      --arg key "$key" \
      --arg value "$value" \
      '$inputs + {($key): $value}')"
  done

  dispatch_body="$(jq -cn \
    --arg ref "$workflow_ref" \
    --argjson inputs "$inputs_json" \
    '{ref: $ref, inputs: $inputs}')"
  # API 2026-03-10 removed return_run_details and always returns the
  # workflow_run_id, API run_url, and browser html_url in a 200 response.
  dispatch_response="$(printf '%s' "$dispatch_body" | gh api \
    --method POST \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    "repos/${GITHUB_REPOSITORY}/actions/workflows/${workflow}/dispatches" \
    --input -)"
  run_id="$(printf '%s' "$dispatch_response" | jq -er '.workflow_run_id')"
  run_url="$(printf '%s' "$dispatch_response" | jq -er '.html_url')"
  verify_child_run_sha "$workflow" "$run_id" "$expected_sha" || return 1

  echo "Dispatched ${workflow} from ${workflow_ref} at ${expected_sha}: ${run_url}" >&2
  {
    echo "- ${workflow}: dispatched from \`${workflow_ref}\` at \`${expected_sha}\` (${run_url})"
  } >> "$GITHUB_STEP_SUMMARY"
  printf '%s\n' "${run_id}"
}

dispatch_workflow() {
  dispatch_workflow_at_ref "$CHILD_WORKFLOW_REF" "$PARENT_WORKFLOW_SHA" "$@"
}

verify_bootstrap_workflow_sha() {
  local approved_ref approved_sha current_main_sha
  approved_ref="$(jq -er '.bootstrap.ref | select(type == "string" and length > 0)' "${CLAWHUB_PLAN_PATH}")"
  approved_sha="$(jq -er '.bootstrapWorkflowSha | select(test("^[a-f0-9]{40}$"))' "${CLAWHUB_PLAN_PATH}")"
  if [[ "${approved_ref}" == "main" ]]; then
    current_main_sha="$(
      gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/main" \
        --jq '.object.sha | select(test("^[a-f0-9]{40}$"))'
    )"
    [[ "${approved_sha}" == "${current_main_sha}" ]] || {
      echo "Trusted main moved from approved ClawHub bootstrap workflow SHA ${approved_sha} to ${current_main_sha}; rerun release approval." >&2
      exit 1
    }
  else
    [[ "${approved_ref}" == "${CHILD_WORKFLOW_REF}" ]] || {
      echo "Approved ClawHub bootstrap workflow ref ${approved_ref} does not match protected child workflow ref ${CHILD_WORKFLOW_REF}." >&2
      exit 1
    }
    [[ "${approved_sha}" == "${PARENT_WORKFLOW_SHA}" ]] || {
      echo "Approved ClawHub bootstrap workflow SHA ${approved_sha} does not match parent workflow SHA ${PARENT_WORKFLOW_SHA}." >&2
      exit 1
    }
  fi
  printf '%s\n' "${approved_sha}"
}

print_pending_deployments() {
  local workflow="$1"
  local run_id="$2"
  local pending_json

  pending_json="$(gh api -X GET "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/pending_deployments" 2>/dev/null || true)"
  if [[ -z "${pending_json}" ]] || ! printf '%s' "${pending_json}" | jq -e 'length > 0' >/dev/null 2>&1; then
    return 0
  fi

  echo "${workflow} pending environment approval:"
  while IFS=$'\t' read -r env_id env_name can_approve; do
    echo "- env=${env_name} canApprove=${can_approve}"
    echo "  approve: gh api -X POST repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/pending_deployments -F 'environment_ids[]=${env_id}' -f state=approved -f comment='Approve release gate'"
  done < <(printf '%s' "${pending_json}" | jq -r '.[] | [.environment.id, .environment.name, .current_user_can_approve] | @tsv')
}

# Returns 0 after an approval, 1 when no gate is ready yet, and 2 for
# identity or mutation failures that must not be retried as "pending".
approve_pending_deployments() {
  local workflow="$1"
  local run_id="$2"
  local expected_sha="$3"
  local pending_json approved

  if ! verify_child_run_sha "$workflow" "$run_id" "$expected_sha"; then
    echo "${workflow}: refusing environment approval because the child workflow SHA is not approved." >&2
    return 2
  fi

  if ! pending_json="$(gh api -X GET "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/pending_deployments" 2>/dev/null)"; then
    return 1
  fi
  if [[ -z "${pending_json}" ]] || ! printf '%s' "${pending_json}" | jq -e 'length > 0' >/dev/null 2>&1; then
    return 1
  fi

  approved=0
  while IFS=$'\t' read -r env_id env_name; do
    if [[ -z "${env_id}" ]]; then
      continue
    fi
    echo "${workflow}: approving pending environment ${env_name} (${env_id})"
    if ! gh api -X POST "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/pending_deployments" \
      -F "environment_ids[]=${env_id}" \
      -f state=approved \
      -f comment="Approve child release gate after parent release approval" >/dev/null; then
      echo "${workflow}: failed to approve pending environment ${env_name} (${env_id})." >&2
      return 2
    fi
    approved=1
  done < <(printf '%s' "${pending_json}" | jq -r '.[] | select(.current_user_can_approve == true) | [.environment.id, .environment.name] | @tsv')

  if [[ "${approved}" == "1" ]]; then
    if ! verify_child_run_sha "$workflow" "$run_id" "$expected_sha"; then
      return 2
    fi
    echo "${workflow}: approved available pending environment gates"
    return 0
  fi
  return 1
}

print_failed_run_summary() {
  local run_id="$1"
  local failed_json

  failed_json="$(gh run view --repo "$GITHUB_REPOSITORY" "$run_id" --json jobs \
    --jq '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | {databaseId, name, conclusion, url}' || true)"
  if [[ -z "${failed_json}" ]]; then
    return 0
  fi

  echo "Failed child job summary:"
  printf '%s\n' "${failed_json}"
  while IFS=$'\t' read -r job_id job_name; do
    if [[ -z "${job_id}" ]]; then
      continue
    fi
    echo "--- ${job_name} (${job_id}) log tail ---"
    gh run view --repo "$GITHUB_REPOSITORY" "$run_id" --job "${job_id}" --log 2>/dev/null |
      tail -200 || true
  done < <(printf '%s\n' "${failed_json}" | jq -r '[.databaseId, .name] | @tsv' 2>/dev/null || true)
}

wait_for_run() {
  local workflow="$1"
  local run_id="$2"
  local expected_sha="$3"
  local status conclusion url updated_at created_at duration_seconds duration_label last_state failed_json approval_status

  if ! verify_child_run_sha "$workflow" "$run_id" "$expected_sha"; then
    return 1
  fi

  last_state=""
  while true; do
    run_json="$(gh run view --repo "$GITHUB_REPOSITORY" "$run_id" --json status,url,updatedAt)"
    status="$(printf '%s' "$run_json" | jq -r '.status')"
    if [[ "$status" == "completed" ]]; then
      break
    fi
    failed_json="$(gh run view --repo "$GITHUB_REPOSITORY" "$run_id" --json jobs \
      --jq '[.jobs[] | select(.status == "completed" and .conclusion != "success" and .conclusion != "skipped")]' || true)"
    if [[ -n "${failed_json}" ]] && jq -e 'length > 0' <<< "$failed_json" >/dev/null; then
      echo "${workflow} has failed jobs before the workflow completed: https://github.com/${GITHUB_REPOSITORY}/actions/runs/${run_id}" >&2
      jq '.[] | {name, conclusion, url}' <<< "$failed_json" >&2 || true
      print_failed_run_summary "${run_id}"
      return 1
    fi
    url="$(printf '%s' "$run_json" | jq -r '.url')"
    updated_at="$(printf '%s' "$run_json" | jq -r '.updatedAt')"
    state="${status}:${updated_at}"
    if [[ "$state" != "$last_state" ]]; then
      echo "${workflow} still ${status} (updated ${updated_at}): ${url}"
      print_pending_deployments "${workflow}" "${run_id}"
      last_state="$state"
    fi
    # The deployment gate can appear after the run first reports
    # waiting without changing updatedAt. Retry every poll so that
    # propagation lag cannot strand an approved release.
    approval_status=0
    approve_pending_deployments "${workflow}" "${run_id}" "${expected_sha}" ||
      approval_status=$?
    if (( approval_status > 1 )); then
      return 1
    fi
    sleep 30
  done

  if ! verify_child_run_sha "$workflow" "$run_id" "$expected_sha"; then
    return 1
  fi
  run_json="$(gh run view --repo "$GITHUB_REPOSITORY" "$run_id" --json conclusion,url,createdAt,updatedAt)"
  conclusion="$(printf '%s' "$run_json" | jq -r '.conclusion')"
  url="$(printf '%s' "$run_json" | jq -r '.url')"
  created_at="$(printf '%s' "$run_json" | jq -r '.createdAt')"
  updated_at="$(printf '%s' "$run_json" | jq -r '.updatedAt')"
  duration_seconds="$(
    CREATED_AT="${created_at}" UPDATED_AT="${updated_at}" node --input-type=module -e '
      const created = Date.parse(process.env.CREATED_AT ?? "");
      const updated = Date.parse(process.env.UPDATED_AT ?? "");
      console.log(Number.isFinite(created) && Number.isFinite(updated) ? Math.max(0, Math.round((updated - created) / 1000)) : "");
    '
  )"
  if [[ -n "${duration_seconds}" ]]; then
    duration_label="$((duration_seconds / 60))m$(printf '%02d' $((duration_seconds % 60)))s"
  else
    duration_label="unknown duration"
  fi
  echo "${workflow} finished with ${conclusion} in ${duration_label}: ${url}"
  {
    echo "- ${workflow}: ${conclusion} in ${duration_label} (${url})"
  } >> "$GITHUB_STEP_SUMMARY"
  if [[ "$conclusion" != "success" ]]; then
    print_failed_run_summary "${run_id}"
    return 1
  fi
}

wait_for_run_background() {
  local workflow="$1"
  local run_id="$2"
  local expected_sha="$3"
  local result_file="$4"
  (
    if wait_for_run "${workflow}" "${run_id}" "${expected_sha}"; then
      printf 'success\n' > "${result_file}"
    else
      printf 'failure\n' > "${result_file}"
    fi
  ) &
  wait_run_pid="$!"
}

wait_for_job_success() {
  local workflow="$1"
  local run_id="$2"
  local job_name="$3"
  local expected_sha="$4"
  local jobs_json job_json run_status run_conclusion status conclusion url deadline

  if ! verify_child_run_sha "$workflow" "$run_id" "$expected_sha"; then
    return 1
  fi
  deadline=$((SECONDS + 900))
  while true; do
    jobs_json="$(gh run view --repo "$GITHUB_REPOSITORY" "$run_id" --json status,conclusion,jobs)"
    run_status="$(printf '%s' "$jobs_json" | jq -r '.status')"
    run_conclusion="$(printf '%s' "$jobs_json" | jq -r '.conclusion // ""')"
    job_json="$(printf '%s' "$jobs_json" | jq -c --arg name "$job_name" '.jobs[]? | select(.name == $name) | {status, conclusion, url}' | head -n 1)"
    if [[ -n "$job_json" ]]; then
      status="$(printf '%s' "$job_json" | jq -r '.status')"
      conclusion="$(printf '%s' "$job_json" | jq -r '.conclusion // ""')"
      url="$(printf '%s' "$job_json" | jq -r '.url // ""')"
      if [[ "$status" == "completed" ]]; then
        if [[ "$conclusion" == "success" || "$conclusion" == "skipped" ]]; then
          if ! verify_child_run_sha "$workflow" "$run_id" "$expected_sha"; then
            return 1
          fi
          echo "${workflow} ${job_name} ${conclusion}: ${url}"
          echo "- ${workflow} ${job_name}: ${conclusion} (${url})" >> "$GITHUB_STEP_SUMMARY"
          return 0
        fi
        echo "${workflow} ${job_name} failed: ${conclusion} ${url}" >&2
        print_failed_run_summary "${run_id}"
        return 1
      fi
      echo "${workflow} ${job_name} still ${status}: ${url}"
    elif [[ "$run_status" == "completed" ]]; then
      if [[ "$run_conclusion" == "success" ]]; then
        if ! verify_child_run_sha "$workflow" "$run_id" "$expected_sha"; then
          return 1
        fi
        echo "${workflow} completed before ${job_name} was needed."
        echo "- ${workflow} ${job_name}: not needed" >> "$GITHUB_STEP_SUMMARY"
        return 0
      fi
      echo "${workflow} completed before ${job_name} with ${run_conclusion}." >&2
      print_failed_run_summary "${run_id}"
      return 1
    else
      echo "${workflow} waiting for ${job_name} to start: https://github.com/${GITHUB_REPOSITORY}/actions/runs/${run_id}"
    fi
    if (( SECONDS >= deadline )); then
      echo "${workflow} ${job_name} did not complete within 15 minutes." >&2
      return 1
    fi
    sleep 10
  done
}

approve_child_publish_environment() {
  local workflow="$1"
  local run_id="$2"
  local expected_sha="$3"
  local run_json status conclusion deadline approval_status

  deadline=$((SECONDS + 900))
  while true; do
    approval_status=0
    approve_pending_deployments "${workflow}" "${run_id}" "${expected_sha}" ||
      approval_status=$?
    if (( approval_status == 0 )); then
      echo "- ${workflow}: child environment gate approved" >> "$GITHUB_STEP_SUMMARY"
      return 0
    fi
    if (( approval_status > 1 )); then
      return "${approval_status}"
    fi
    if ! run_json="$(gh run view --repo "$GITHUB_REPOSITORY" "$run_id" --json status,conclusion,url)"; then
      sleep 10
      continue
    fi
    if ! status="$(printf '%s' "$run_json" | jq -er '.status | select(type == "string" and length > 0)')" ||
      ! conclusion="$(printf '%s' "$run_json" | jq -er '(.conclusion // "") | select(type == "string")')"; then
      echo "${workflow}: invalid run state while waiting for environment approval." >&2
      return 2
    fi
    if [[ "$status" == "completed" ]]; then
      if [[ "$conclusion" == "success" ]]; then
        if ! verify_child_run_sha "$workflow" "$run_id" "$expected_sha"; then
          return 2
        fi
        echo "${workflow}: completed before child environment approval was needed"
        return 0
      fi
      echo "${workflow}: completed before child environment approval with ${conclusion}" >&2
      print_failed_run_summary "${run_id}"
      return 1
    fi
    if (( SECONDS >= deadline )); then
      echo "${workflow}: child environment approval was not available within 15 minutes." >&2
      print_pending_deployments "${workflow}" "${run_id}"
      return 1
    fi
    sleep 10
  done
}

approve_clawhub_bootstrap_environments() {
  local run_id="$1"
  local expected_sha="$2"

  wait_for_job_success \
    plugin-clawhub-new.yml \
    "${run_id}" \
    "Validate release publish approval" \
    "${expected_sha}" || return 1
  approve_child_publish_environment plugin-clawhub-new.yml "${run_id}" "${expected_sha}" || return 1
  wait_for_job_success \
    plugin-clawhub-new.yml \
    "${run_id}" \
    "Validate immutable bootstrap handoff" \
    "${expected_sha}" || return 1
  approve_child_publish_environment plugin-clawhub-new.yml "${run_id}" "${expected_sha}" || return 1
}

guard_existing_public_release() {
  local release_version asset_name release_json is_draft has_sha has_proof has_asset has_canonical_body release_url release_body release_body_file

  if [[ "${PUBLISH_OPENCLAW_NPM}" != "true" ]]; then
    return 0
  fi

  if ! release_json="$(gh release view "${RELEASE_TAG}" --repo "$GITHUB_REPOSITORY" --json isDraft,assets,body,url 2>/dev/null)"; then
    return 0
  fi

  is_draft="$(printf '%s' "${release_json}" | jq -r '.isDraft')"
  if [[ "${is_draft}" == "true" ]]; then
    return 0
  fi

  release_version="${RELEASE_TAG#v}"
  asset_name="openclaw-${release_version}-dependency-evidence.zip"
  has_sha="$(printf '%s' "${release_json}" | jq --arg sha "${TARGET_SHA}" -r '.body | contains($sha)')"
  has_proof="$(printf '%s' "${release_json}" | jq -r '.body | contains("### Release verification")')"
  has_asset="$(printf '%s' "${release_json}" | jq --arg name "${asset_name}" -r 'any(.assets[]?; .name == $name)')"
  release_url="$(printf '%s' "${release_json}" | jq -r '.url')"
  release_body="$(printf '%s' "${release_json}" | jq -r '.body')"
  release_body_file="${RUNNER_TEMP}/existing-public-release-body.md"
  printf '%s' "${release_body}" > "${release_body_file}"
  has_canonical_body="false"
  if canonical_release_body_matches "${release_body_file}"; then
    has_canonical_body="true"
  fi

  if [[ "${has_asset}" == "true" &&
    "${has_sha}" == "true" &&
    "${has_proof}" == "true" &&
    "${has_canonical_body}" == "true" ]]; then
    return 0
  fi

  # The renderer omits the verification tail when the canonical body
  # already reaches GitHub's limit. A canonical proofless body with
  # intact dependency evidence is retry-safe: postpublish re-attempts
  # the proof append on this run.
  if [[ "${has_asset}" == "true" &&
    "${has_canonical_body}" == "true" &&
    "${has_proof}" != "true" ]]; then
    return 0
  fi

  {
    echo "Release ${RELEASE_TAG} already has a public GitHub release page without complete postpublish evidence for ${TARGET_SHA}."
    echo "Refusing to reuse a public prerelease tag after publication started: ${release_url}"
    echo "Create a new beta tag or delete/draft the incomplete public release before retrying."
  } >&2
  exit 1
}

resolve_openclaw_npm_publish_state() {
  local artifact_name manifest_dir manifest_path manifest_sha manifest_tarball_sha published_sha published_tarball_path published_tarball_url release_version
  local resume_state resume_url

  openclaw_npm_already_published="false"
  if [[ "${PUBLISH_OPENCLAW_NPM}" != "true" ]]; then
    return 0
  fi

  release_version="${RELEASE_TAG#v}"
  if ! npm view "openclaw@${release_version}" version >/dev/null 2>&1; then
    return 0
  fi

  # A published core package means a prior publish run already got
  # that far. Resume is only safe when the registry serves the exact
  # tarball this tag's preflight built; the same version from any
  # other artifact is immutable on npm and needs a correction tag.
  artifact_name="${PREFLIGHT_ARTIFACT_NAME:-openclaw-npm-preflight-${RELEASE_TAG}}"
  manifest_dir="${RUNNER_TEMP}/openclaw-npm-resume-preflight"
  rm -rf "${manifest_dir}"
  mkdir -p "${manifest_dir}"
  gh run download "${PREFLIGHT_RUN_ID}" \
    --repo "${GITHUB_REPOSITORY}" \
    --name "${artifact_name}" \
    --dir "${manifest_dir}"
  manifest_path="${manifest_dir}/preflight-manifest.json"
  manifest_sha="$(jq -er '.releaseSha' "${manifest_path}")"
  manifest_tarball_sha="$(jq -er '.tarballSha256' "${manifest_path}")"
  if [[ "${manifest_sha}" != "${TARGET_SHA}" ]]; then
    echo "openclaw@${release_version} is already on npm but preflight ${PREFLIGHT_RUN_ID} was built from ${manifest_sha}, not ${TARGET_SHA}; refusing to resume." >&2
    exit 1
  fi
  published_tarball_url="$(npm view "openclaw@${release_version}" dist.tarball)"
  published_tarball_path="${manifest_dir}/published.tgz"
  # Keep registry identity verification bounded if a connected
  # tarball endpoint stops transferring during a release resume.
  curl -fsSL \
    --connect-timeout 10 \
    --max-time 120 \
    --retry 3 \
    --retry-max-time 180 \
    -o "${published_tarball_path}" "${published_tarball_url}"
  published_sha="$(sha256sum "${published_tarball_path}" | awk '{print $1}')"
  if [[ "${published_sha}" != "${manifest_tarball_sha}" ]]; then
    {
      echo "openclaw@${release_version} is already published on npm but its tarball does not match this tag's preflight artifact."
      echo "Published sha256: ${published_sha}"
      echo "Preflight tarballSha256: ${manifest_tarball_sha}"
      echo "Cut a correction tag instead of resuming this publish."
    } >&2
    exit 1
  fi

  if [[ -z "${OPENCLAW_NPM_RESUME_RUN_ID//[[:space:]]/}" ]]; then
    echo "openclaw@${release_version} is already published; openclaw_npm_resume_run_id is required to bind postpublish proof to the original workflow identity." >&2
    exit 1
  fi
  resume_state="$(node --import tsx "${GITHUB_WORKSPACE}/.release-harness/scripts/openclaw-npm-resume-run.mts" \
    --repo "${GITHUB_REPOSITORY}" \
    --run-id "${OPENCLAW_NPM_RESUME_RUN_ID}" \
    --trusted-workflow-ref "${PARENT_WORKFLOW_BRANCH}" \
    --trusted-workflow-full-ref "${GITHUB_REF}")"
  resume_url="$(printf '%s' "${resume_state}" | jq -er '.url')"
  openclaw_npm_expected_workflow_ref="$(printf '%s' "${resume_state}" | jq -er '.workflowRef')"
  openclaw_npm_expected_workflow_sha="$(printf '%s' "${resume_state}" | jq -er '.workflowSha')"

  openclaw_npm_already_published="true"
  echo "openclaw@${release_version} is already published on npm with this tag's preflight tarball; resuming from ${resume_url}."
}

resolve_clawhub_release_plan() {
  clawhub_plan_path="${CLAWHUB_PLAN_PATH}"
  test -s "${clawhub_plan_path}"

  echo "Resolved OpenClaw release ClawHub dispatch plan:"
  cat "${clawhub_plan_path}"

  clawhub_workflow_ref="$(jq -r '.clawHubWorkflowRef' "${clawhub_plan_path}")"
  normal_plugins="$(jq -r '.summary.normalPlugins' "${clawhub_plan_path}")"
  bootstrap_plugins="$(jq -r '.summary.bootstrapPlugins' "${clawhub_plan_path}")"
  missing_trusted_plugins="$(jq -r '.summary.missingTrustedPlugins' "${clawhub_plan_path}")"
  normal_plugin_count="$(jq -r '.summary.normalCount' "${clawhub_plan_path}")"
  bootstrap_plugin_count="$(jq -r '.summary.bootstrapCount' "${clawhub_plan_path}")"
  missing_trusted_plugin_count="$(jq -r '.summary.missingTrustedPublisherCount' "${clawhub_plan_path}")"

  {
    echo "### ClawHub release plan"
    echo
    echo "- Normal OIDC candidates: \`${normal_plugin_count}\`"
    echo "- Bootstrap/repair candidates: \`${bootstrap_plugin_count}\`"
    echo "- Existing-package trusted-publisher repairs: \`${missing_trusted_plugin_count}\`"
    if [[ -n "${normal_plugins}" ]]; then
      echo "- Normal plugins: \`${normal_plugins}\`"
    fi
    if [[ -n "${bootstrap_plugins}" ]]; then
      echo "- Bootstrap/repair plugins: \`${bootstrap_plugins}\`"
    fi
    if [[ -n "${missing_trusted_plugins}" ]]; then
      echo "- Trusted-publisher repair plugins: \`${missing_trusted_plugins}\`"
    fi
  } >> "$GITHUB_STEP_SUMMARY"
}

append_clawhub_dispatch_args() {
  local target="$1"
  while IFS=$'\t' read -r key value; do
    clawhub_dispatch_args+=(-f "${key}=${value}")
  done < <(jq -r --arg target "${target}" '.[$target].inputs | to_entries[] | [.key, .value] | @tsv' "${clawhub_plan_path}")
}

write_clawhub_runtime_state() {
  local force_skip_clawhub="$1"
  local output_path="$2"
  node --import tsx \
    "${GITHUB_WORKSPACE}/.release-harness/scripts/openclaw-release-clawhub-runtime-state.ts" \
    --repository "${GITHUB_REPOSITORY}" \
    --wait-for-clawhub "${WAIT_FOR_CLAWHUB}" \
    --force-skip-clawhub "${force_skip_clawhub}" \
    --normal-run-id "${plugin_clawhub_run_id:-}" \
    --normal-publication-staged true \
    --bootstrap-run-id "${plugin_clawhub_bootstrap_run_id:-}" \
    --bootstrap-completed "${plugin_clawhub_bootstrap_completed:-false}" > "${output_path}"
}

render_github_release_notes() {
  local output_file="$1"
  local verification_file="${2:-}"
  local metadata_file="${3:-}"
  local changelog_file="${RUNNER_TEMP}/CHANGELOG.md"
  local -a render_args=(
    node --import tsx scripts/render-github-release-notes.mts
    --changelog "${changelog_file}"
    --tag "${RELEASE_TAG}"
    --repository "${GITHUB_REPOSITORY}"
    --output "${output_file}"
  )

  git show "${TARGET_SHA}:CHANGELOG.md" > "${changelog_file}"
  if [[ -n "${verification_file}" ]]; then
    render_args+=(--verification-file "${verification_file}")
  fi
  if [[ -n "${metadata_file}" ]]; then
    render_args+=(--metadata-output "${metadata_file}")
  fi
  "${render_args[@]}"
}

verify_release_tag_target() {
  local direct_sha peeled_sha remote_refs remote_sha
  remote_refs="$(git ls-remote --tags origin \
    "refs/tags/${RELEASE_TAG}" \
    "refs/tags/${RELEASE_TAG}^{}")"
  direct_sha="$(printf '%s\n' "${remote_refs}" |
    awk -v ref="refs/tags/${RELEASE_TAG}" '$2 == ref { print $1 }')"
  peeled_sha="$(printf '%s\n' "${remote_refs}" |
    awk -v ref="refs/tags/${RELEASE_TAG}^{}" '$2 == ref { print $1 }')"
  remote_sha="${peeled_sha:-${direct_sha}}"
  if [[ -z "${remote_sha}" ]]; then
    echo "Release tag ${RELEASE_TAG} no longer exists on origin." >&2
    exit 1
  fi
  if [[ "${remote_sha}" != "${TARGET_SHA}" ]]; then
    echo "Release tag ${RELEASE_TAG} moved: expected ${TARGET_SHA}, found ${remote_sha}." >&2
    exit 1
  fi
}

canonical_release_body_matches() {
  local body_file="$1"
  local changelog_file="${RUNNER_TEMP}/release-body-changelog.md"
  git show "${TARGET_SHA}:CHANGELOG.md" > "${changelog_file}"
  RELEASE_BODY_FILE="${body_file}" \
    RELEASE_CHANGELOG_FILE="${changelog_file}" \
    RELEASE_REPOSITORY="${GITHUB_REPOSITORY}" \
    RELEASE_TAG="${RELEASE_TAG}" \
    node --import tsx --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import {
  releaseNotesVersionForTag,
  verifyGithubReleaseNotes,
} from "./scripts/render-github-release-notes.mts";

const body = readFileSync(process.env.RELEASE_BODY_FILE, "utf8");
const changelog = readFileSync(process.env.RELEASE_CHANGELOG_FILE, "utf8");
const result = verifyGithubReleaseNotes({
  body,
  changelog,
  version: releaseNotesVersionForTag(process.env.RELEASE_TAG),
  tag: process.env.RELEASE_TAG,
  repository: process.env.RELEASE_REPOSITORY,
});
if (!result.matches) {
  process.exitCode = 1;
}
NODE
}

create_or_update_github_release() {
  local existing_body_file existing_state release_version title latest_arg prerelease_arg
  verify_release_tag_target
  release_version="${RELEASE_TAG#v}"
  title="openclaw ${release_version}"

  prerelease_arg="--prerelease=false"
  latest_arg="--latest=false"
  if [[ "${RELEASE_TAG}" == *"-alpha."* || "${RELEASE_TAG}" == *"-beta."* ]]; then
    prerelease_arg="--prerelease"
  elif [[ "${RELEASE_NPM_DIST_TAG}" == "latest" ]]; then
    latest_arg="--latest"
  fi

  if existing_state="$(gh release view "${RELEASE_TAG}" --repo "$GITHUB_REPOSITORY" --json isDraft,body 2>/dev/null)"; then
    # A public page only reaches this call after
    # guard_existing_public_release accepted it as canonical; leave
    # it untouched so a failed resume cannot strip its verification
    # proof before the proof append re-runs.
    if [[ "$(printf '%s' "${existing_state}" | jq -r '.isDraft')" != "true" ]]; then
      existing_body_file="${RUNNER_TEMP}/existing-public-release-notes.md"
      printf '%s' "$(printf '%s' "${existing_state}" | jq -r '.body')" > "${existing_body_file}"
      if canonical_release_body_matches "${existing_body_file}"; then
        echo "- GitHub release: existing public page left untouched until proof append" >> "$GITHUB_STEP_SUMMARY"
        return 0
      fi
    fi
    gh release edit "${RELEASE_TAG}" --repo "$GITHUB_REPOSITORY" \
      --title "${title}" \
      --notes-file "${prepared_release_notes_file}" \
      "${prerelease_arg}" \
      "${latest_arg}"
  else
    gh release create "${RELEASE_TAG}" --repo "$GITHUB_REPOSITORY" \
      --verify-tag \
      --draft \
      --title "${title}" \
      --notes-file "${prepared_release_notes_file}" \
      "${prerelease_arg}" \
      "${latest_arg}"
  fi
  echo "- GitHub release draft: https://github.com/${GITHUB_REPOSITORY}/releases/tag/${RELEASE_TAG}" >> "$GITHUB_STEP_SUMMARY"
}

verify_android_release_asset_contract() {
  local actual_android_assets actual_digest expected_android_assets expected_digest expected_hash release_json verify_dir
  local -a required_assets=(
    "OpenClaw-Android.apk"
    "OpenClaw-Android-SHA256SUMS.txt"
  )

  release_json="$(gh release view "${RELEASE_TAG}" --repo "${GITHUB_REPOSITORY}" --json assets,url)" || return 1
  expected_android_assets="$(printf '%s\n' "${required_assets[@]}" | jq -R . | jq -sc 'sort')"
  actual_android_assets="$(printf '%s' "${release_json}" | jq -c '
    [.assets[]? | select(.name | startswith("OpenClaw-Android")) | .name] | sort
  ')"
  if [[ "${actual_android_assets}" != "${expected_android_assets}" ]]; then
    echo "Stable release Android asset names do not match the canonical contract." >&2
    return 1
  fi

  verify_dir="${RUNNER_TEMP}/openclaw-android-release-contract"
  rm -rf "${verify_dir}"
  mkdir -p "${verify_dir}"
  gh release download "${RELEASE_TAG}" \
    --repo "${GITHUB_REPOSITORY}" \
    --pattern "OpenClaw-Android.apk" \
    --pattern "OpenClaw-Android-SHA256SUMS.txt" \
    --dir "${verify_dir}" || return 1
  (
    cd "${verify_dir}"
    sha256sum --strict --check OpenClaw-Android-SHA256SUMS.txt
  ) || return 1
  expected_hash="$(awk '$2 == "OpenClaw-Android.apk" { print $1 }' "${verify_dir}/OpenClaw-Android-SHA256SUMS.txt")"
  if [[ ! "${expected_hash}" =~ ^[a-f0-9]{64}$ ]]; then
    echo "Android checksum manifest does not contain the canonical APK entry." >&2
    return 1
  fi
  expected_digest="sha256:${expected_hash}"
  actual_digest="$(printf '%s' "${release_json}" | jq -r '.assets[]? | select(.name == "OpenClaw-Android.apk") | .digest // empty')"
  if [[ "${actual_digest}" != "${expected_digest}" ]]; then
    echo "Android release APK digest does not match its checksum manifest." >&2
    return 1
  fi
  # Explicit guard: this function doubles as an `if` predicate, where
  # bash suppresses errexit, so a failed attestation must not fall
  # through to the summary echo.
  gh attestation verify "${verify_dir}/OpenClaw-Android.apk" \
    --repo "${GITHUB_REPOSITORY}" \
    --signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/android-release.yml" \
    --source-ref "refs/tags/${RELEASE_TAG}" \
    --deny-self-hosted-runners || return 1
  echo "- Android APK asset contract: verified" >> "${GITHUB_STEP_SUMMARY}"
}

verify_windows_release_asset_contract() {
  local actual_companion_assets actual_digest asset_name expected_companion_assets expected_digest expected_hash expected_installer_names manifest_dir manifest_json manifest_path release_json
  # Add future promoted installer names, such as MSIX x64/ARM64, here.
  local -a installer_assets=(
    "OpenClawCompanion-Setup-x64.exe"
    "OpenClawCompanion-Setup-arm64.exe"
  )
  local -a required_assets=(
    "${installer_assets[@]}"
    "OpenClawCompanion-SHA256SUMS.txt"
  )

  release_json="$(gh release view "${RELEASE_TAG}" --repo "$GITHUB_REPOSITORY" --json assets,url)" || return 1
  expected_companion_assets="$(printf '%s\n' "${required_assets[@]}" | jq -R . | jq -sc 'sort')"
  actual_companion_assets="$(printf '%s' "${release_json}" | jq -c '
    [.assets[]? | select(.name | startswith("OpenClawCompanion-")) | .name] | sort
  ')"
  if [[ "${actual_companion_assets}" != "${expected_companion_assets}" ]]; then
    echo "Stable release OpenClawCompanion asset names do not exactly match the current contract." >&2
    return 1
  fi
  for asset_name in "${required_assets[@]}"; do
    if ! printf '%s' "${release_json}" | jq -e --arg name "${asset_name}" 'any(.assets[]?; .name == $name)' >/dev/null; then
      echo "Stable release is missing required Windows asset ${asset_name}." >&2
      return 1
    fi
  done

  manifest_dir="${RUNNER_TEMP}/openclaw-windows-release-contract"
  manifest_path="${manifest_dir}/OpenClawCompanion-SHA256SUMS.txt"
  rm -rf "${manifest_dir}"
  mkdir -p "${manifest_dir}"
  gh release download "${RELEASE_TAG}" \
    --repo "$GITHUB_REPOSITORY" \
    --pattern "OpenClawCompanion-SHA256SUMS.txt" \
    --dir "${manifest_dir}" || return 1
  if ! manifest_json="$(jq -Rsc '
    split("\n") as $lines |
    (if $lines[-1] == "" then $lines[0:-1] else $lines end) |
    map(sub("\r$"; "")) |
    if all(.[]; test("^(?<hash>[a-f0-9]{64})  (?<name>[^/\\\\]+)$"))
    then map(capture("^(?<hash>[a-f0-9]{64})  (?<name>[^/\\\\]+)$"))
    else error("malformed Windows checksum manifest entry")
    end
  ' "${manifest_path}")"; then
    echo "Stable release Windows checksum manifest contains malformed entries." >&2
    return 1
  fi
  expected_installer_names="$(printf '%s\n' "${installer_assets[@]}" | jq -R . | jq -sc 'sort')"
  if ! printf '%s' "${manifest_json}" | jq -e --argjson expected "${expected_installer_names}" '
    length == ($expected | length) and
    ([.[].name] | sort) == $expected and
    ([.[].name] | unique | length) == length
  ' >/dev/null; then
    echo "Stable release Windows checksum manifest does not exactly match the installer asset contract." >&2
    return 1
  fi
  for asset_name in "${installer_assets[@]}"; do
    expected_digest="$(printf '%s' "${WINDOWS_NODE_INSTALLER_DIGESTS}" | jq -r --arg name "${asset_name}" '.[$name] // empty')"
    actual_digest="$(printf '%s' "${release_json}" | jq -r --arg name "${asset_name}" '.assets[]? | select(.name == $name) | .digest // empty')"
    if [[ -z "${expected_digest}" || "${actual_digest}" != "${expected_digest}" ]]; then
      echo "Stable release Windows asset ${asset_name} does not match its pinned digest." >&2
      return 1
    fi
    expected_hash="${expected_digest#sha256:}"
    if ! printf '%s' "${manifest_json}" | jq -e --arg name "${asset_name}" --arg hash "${expected_hash}" '
      any(.[]; .name == $name and .hash == $hash)
    ' >/dev/null; then
      echo "Stable release Windows checksum manifest does not match pinned digest for ${asset_name}." >&2
      return 1
    fi
  done
  echo "- Windows Hub asset contract: verified" >> "$GITHUB_STEP_SUMMARY"
}

promote_windows_release_assets() {
  if ! is_stable_release; then
    return 0
  fi
  if [[ -z "${WINDOWS_NODE_INSTALLER_DIGESTS// }" ]]; then
    echo "Stable release is missing prevalidated Windows installer digests." >&2
    return 1
  fi
  # Retry-safe: the asset contract is the done-condition, so a prior
  # publish run's verified promotion is reused instead of re-running
  # the Windows child workflow.
  if verify_windows_release_asset_contract >/dev/null 2>&1; then
    echo "- Windows Hub promotion: assets already promoted and verified; skipping dispatch" >> "$GITHUB_STEP_SUMMARY"
    return 0
  fi

  windows_node_run_id="$(dispatch_workflow windows-node-release.yml \
    -f tag="${RELEASE_TAG}" \
    -f windows_node_tag="${WINDOWS_NODE_TAG}" \
    -f expected_installer_digests="${WINDOWS_NODE_INSTALLER_DIGESTS}")"
  # Promotion runs in a background subshell; hand the run id to the
  # parent shell for the release proof links.
  printf '%s' "${windows_node_run_id}" > "${RUNNER_TEMP}/windows-node-run-id.txt"
  echo "- Windows Node release run ID: \`${windows_node_run_id}\`" >> "$GITHUB_STEP_SUMMARY"
  wait_for_run windows-node-release.yml "${windows_node_run_id}" "${PARENT_WORKFLOW_SHA}"
}

promote_android_release_asset() {
  if ! is_android_release; then
    return 0
  fi
  # Retry-safe: the asset contract is the done-condition, so a prior
  # publish run's verified APK promotion is reused instead of
  # re-running the Android child workflow.
  if verify_android_release_asset_contract >/dev/null 2>&1; then
    android_release_note="- Android APK: previously published assets verified; https://github.com/${GITHUB_REPOSITORY}/releases/download/${RELEASE_TAG}/OpenClaw-Android.apk"
    echo "${android_release_note}" >> "${GITHUB_STEP_SUMMARY}"
    return 0
  fi

  android_release_run_id="$(dispatch_workflow_at_ref "${RELEASE_TAG}" "${TARGET_SHA}" android-release.yml \
    -f tag="${RELEASE_TAG}" \
    -f release_publish_run_id="${GITHUB_RUN_ID}" \
    -f release_publish_run_attempt="${GITHUB_RUN_ATTEMPT}" \
    -f release_publish_branch="${PARENT_WORKFLOW_BRANCH}" \
    -f release_publish_full_ref="${PARENT_WORKFLOW_FULL_REF}" \
    -f release_publish_workflow_sha="${PARENT_WORKFLOW_SHA}" \
    -f release_target_sha="${TARGET_SHA}" \
    -f direct_release_recovery=false)" || return 1
  android_release_note="- Android APK publication dispatched (completion not awaited): https://github.com/${GITHUB_REPOSITORY}/actions/runs/${android_release_run_id}"
  echo "${android_release_note}" >> "${GITHUB_STEP_SUMMARY}"
}

upload_dependency_evidence_release_asset() {
  local release_version download_dir asset_path asset_name artifact_name
  release_version="${RELEASE_TAG#v}"
  download_dir="${RUNNER_TEMP}/openclaw-release-dependency-evidence-asset"
  asset_name="openclaw-${release_version}-dependency-evidence.zip"
  asset_path="${RUNNER_TEMP}/${asset_name}"
  artifact_name="${PREFLIGHT_ARTIFACT_NAME:-openclaw-npm-preflight-${RELEASE_TAG}}"

  rm -rf "${download_dir}" "${asset_path}"
  mkdir -p "${download_dir}"
  gh run download "${PREFLIGHT_RUN_ID}" \
    --repo "${GITHUB_REPOSITORY}" \
    --name "${artifact_name}" \
    --dir "${download_dir}"

  if [[ ! -d "${download_dir}/dependency-evidence" ]]; then
    echo "Dependency evidence is missing from OpenClaw npm preflight artifact." >&2
    find "${download_dir}" -maxdepth 2 -type f -print >&2 || true
    exit 1
  fi

  (
    cd "${download_dir}"
    export TZ=UTC
    find dependency-evidence -type f -exec touch -t 198001010000 {} +
    find dependency-evidence -type f -print | LC_ALL=C sort | zip -X -q "${asset_path}" -@
  )
  attach_or_verify_release_asset "${asset_path}" "${asset_name}" zip-tree
  echo "- Dependency evidence asset: \`${asset_name}\`" >> "$GITHUB_STEP_SUMMARY"
}

release_evidence_zip_trees_match() {
  local source_path="$1"
  local existing_path="$2"
  python3 "${GITHUB_WORKSPACE}/.release-harness/scripts/compare-release-evidence-zip.py" \
    "${source_path}" "${existing_path}"
}

attach_or_verify_release_asset() {
  local source_path="$1"
  local asset_name="$2"
  local comparison_mode="${3:-exact}"
  local existing_dir="${RUNNER_TEMP}/openclaw-release-existing-assets/${asset_name}"
  local existing_path="${existing_dir}/${asset_name}"

  case "${comparison_mode}" in
    exact | zip-tree) ;;
    *)
      echo "Unknown release evidence comparison mode: ${comparison_mode}" >&2
      exit 1
      ;;
  esac

  if gh release view "${RELEASE_TAG}" --repo "${GITHUB_REPOSITORY}" --json assets |
    jq -e --arg name "${asset_name}" 'any(.assets[]?; .name == $name)' >/dev/null; then
    rm -rf "${existing_dir}"
    mkdir -p "${existing_dir}"
    gh release download "${RELEASE_TAG}" --repo "${GITHUB_REPOSITORY}" \
      --pattern "${asset_name}" --dir "${existing_dir}"
    if cmp --silent "${source_path}" "${existing_path}"; then
      return
    fi
    if [[ "${comparison_mode}" == "zip-tree" ]] &&
      release_evidence_zip_trees_match "${source_path}" "${existing_path}"; then
      return
    fi
    echo "Existing release evidence asset ${asset_name} differs from this release run." >&2
    exit 1
  fi

  gh release upload "${RELEASE_TAG}" "${source_path}#${asset_name}" --repo "${GITHUB_REPOSITORY}"
}

replace_release_asset() {
  local source_path="$1"
  local asset_name="$2"
  # Postpublish evidence embeds this run's id, so resumable retries
  # regenerate it; the newest verification replaces the asset while
  # prior copies persist as workflow artifacts.
  gh release upload "${RELEASE_TAG}" "${source_path}#${asset_name}" \
    --repo "${GITHUB_REPOSITORY}" --clobber
}

upload_release_evidence_assets() {
  local release_version manifest_path evidence_path manifest_asset evidence_asset
  release_version="${RELEASE_TAG#v}"
  evidence_path="${POSTPUBLISH_EVIDENCE_DIR}/release-postpublish-evidence.json"
  evidence_asset="openclaw-${release_version}-postpublish-evidence.json"

  if [[ "${RELEASE_EVIDENCE_MODE}" == "authorized-beta-focused-v1" ]]; then
    manifest_path="${FOCUSED_RELEASE_EVIDENCE_DIR}/evidence.json"
    manifest_asset="openclaw-${release_version}-authorized-focused-evidence.json"
  else
    manifest_path="${FULL_RELEASE_VALIDATION_MANIFEST_DIR}/full-release-validation-manifest.json"
    manifest_asset="openclaw-${release_version}-release-manifest.json"
  fi
  if [[ ! -f "${manifest_path}" ]]; then
    echo "Release evidence is missing for mode ${RELEASE_EVIDENCE_MODE}: ${manifest_path}." >&2
    exit 1
  fi
  if [[ ! -f "${evidence_path}" ]]; then
    echo "Postpublish release evidence is missing from ${POSTPUBLISH_EVIDENCE_DIR}." >&2
    exit 1
  fi

  cp "${manifest_path}" "${RUNNER_TEMP}/${manifest_asset}"
  cp "${evidence_path}" "${RUNNER_TEMP}/${evidence_asset}"
  (
    cd "${RUNNER_TEMP}"
    sha256sum "${manifest_asset}" > "${manifest_asset}.sha256"
    sha256sum "${evidence_asset}" > "${evidence_asset}.sha256"
  )

  attach_or_verify_release_asset "${RUNNER_TEMP}/${manifest_asset}" "${manifest_asset}"
  attach_or_verify_release_asset \
    "${RUNNER_TEMP}/${manifest_asset}.sha256" \
    "${manifest_asset}.sha256"
  replace_release_asset "${RUNNER_TEMP}/${evidence_asset}" "${evidence_asset}"
  replace_release_asset \
    "${RUNNER_TEMP}/${evidence_asset}.sha256" \
    "${evidence_asset}.sha256"
  {
    echo "- Immutable release evidence: \`${manifest_asset}\`"
    echo "- Postpublish evidence (latest verification): \`${evidence_asset}\`"
  } >> "$GITHUB_STEP_SUMMARY"
}

verify_published_release() {
  local release_version evidence_path skip_clawhub clawhub_runtime_state_path bootstrap_run_arg_present
  local expected_attempt expected_id run_attempt run_id run_label run_url target_sha
  local validation_file workflow_ref telegram_waiver
  local -a verify_args

  skip_clawhub="${1:-false}"

  release_version="${RELEASE_TAG#v}"
  evidence_path="${POSTPUBLISH_EVIDENCE_DIR}/release-postpublish-evidence.json"
  mkdir -p "${POSTPUBLISH_EVIDENCE_DIR}"

  verify_args=(
    "${release_version}"
    --tag "${RELEASE_TAG}"
    --dist-tag "${RELEASE_NPM_DIST_TAG}"
    --repo "${GITHUB_REPOSITORY}"
    --release-sha "${TARGET_SHA}"
    --workflow-ref "${CHILD_WORKFLOW_REF}"
    --clawhub-workflow-ref "${clawhub_workflow_ref}"
    --plugin-npm-run "${plugin_npm_run_id}"
    --evidence-out "${evidence_path}"
    --skip-github-release
  )
  # Resumed publishes have no core npm run of their own; the
  # registry package check still verifies the published state.
  if [[ -n "${openclaw_npm_run_id// }" ]]; then
    verify_args+=(--openclaw-npm-run "${openclaw_npm_run_id}")
  fi
  clawhub_runtime_state_path="${RUNNER_TEMP}/openclaw-release-clawhub-runtime-state-verify.json"
  write_clawhub_runtime_state "${skip_clawhub}" "${clawhub_runtime_state_path}"
  while IFS= read -r arg; do
    verify_args+=("${arg}")
  done < <(jq -r '.verifierArgs[]' "${clawhub_runtime_state_path}")
  bootstrap_run_arg_present="$(
    jq -r \
      '.verifierArgs | index("--plugin-clawhub-bootstrap-run") != null' \
      "${clawhub_runtime_state_path}"
  )"
  if [[ -n "${PLUGINS// }" ]]; then
    verify_args+=(--plugins "${PLUGINS}")
  fi
  if [[ -n "${bootstrap_plugins// }" && "${bootstrap_run_arg_present}" == "true" ]]; then
    verify_args+=(--clawhub-bootstrap-plugins "${bootstrap_plugins}")
  fi
  if [[ -n "${NPM_TELEGRAM_RUN_ID// }" ]]; then
    verify_args+=(--npm-telegram-run "${NPM_TELEGRAM_RUN_ID}")
  fi

  if [[ "${PUBLISH_OPENCLAW_NPM}" == "true" ]]; then
    verify_args+=(
      --postpublish-verifier
      "${GITHUB_WORKSPACE}/.release-harness/scripts/openclaw-npm-postpublish-verify.ts"
    )
  fi

  OPENCLAW_NPM_EXPECTED_WORKFLOW_REF="${openclaw_npm_expected_workflow_ref}" \
    OPENCLAW_NPM_EXPECTED_WORKFLOW_SHA="${openclaw_npm_expected_workflow_sha}" \
    node --import tsx \
      "${GITHUB_WORKSPACE}/.release-harness/scripts/release-verify-beta.ts" \
      "${verify_args[@]}"

  if [[ "${RELEASE_EVIDENCE_MODE}" == "authorized-beta-focused-v1" ]]; then
    validation_file="${FOCUSED_RELEASE_EVIDENCE_DIR}/evidence.json"
    run_id="$(jq -er '.producer.runId | select(type == "string" and test("^[1-9][0-9]*$"))' "${validation_file}")"
    run_attempt="$(jq -er '.producer.runAttempt | select(type == "number" and . >= 1) | tostring' "${validation_file}")"
    workflow_ref="$(jq -er '.producer.workflowRef | select(type == "string" and length > 0)' "${validation_file}")"
    target_sha="$(jq -er '.candidate.sha | select(type == "string" and test("^[a-f0-9]{40}$"))' "${validation_file}")"
    expected_id="${FOCUSED_RELEASE_EVIDENCE_RUN_ID}"
    expected_attempt="${FOCUSED_RELEASE_EVIDENCE_RUN_ATTEMPT}"
    run_label="Authorized Beta Focused Validation"
  else
    validation_file="${FULL_RELEASE_VALIDATION_MANIFEST_DIR}/full-release-validation-manifest.json"
    run_id="$(jq -er '.runId | select(type == "string" and length > 0)' "${validation_file}")"
    run_attempt="$(jq -er '.runAttempt | select(type == "string" and test("^[1-9][0-9]*$"))' "${validation_file}")"
    workflow_ref="$(jq -er '.workflowRef | select(type == "string" and length > 0)' "${validation_file}")"
    target_sha="$(jq -er '.targetSha | select(type == "string" and test("^[a-f0-9]{40}$"))' "${validation_file}")"
    expected_id="${FULL_RELEASE_VALIDATION_RUN_ID}"
    expected_attempt="${FULL_RELEASE_VALIDATION_RUN_ATTEMPT}"
    run_label="Full Release Validation"
  fi
  if [[ "${run_id}" != "${expected_id}" ||
    "${run_attempt}" != "${expected_attempt}" ||
    "${target_sha}" != "${TARGET_SHA}" ]]; then
    echo "Release validation evidence changed after prepublish validation." >&2
    exit 1
  fi
  telegram_waiver=""
  if [[ "${RELEASE_EVIDENCE_MODE}" != "authorized-beta-focused-v1" ]]; then
    telegram_waiver="$(jq -r '.validationInputs.telegramWaiver // ""' "${validation_file}")"
  fi
  run_url="https://github.com/${GITHUB_REPOSITORY}/actions/runs/${run_id}"
  jq \
    --arg telegram_waiver "${telegram_waiver}" \
    --arg release_publish_run_id "$GITHUB_RUN_ID" \
    --arg validation_label "${run_label}" \
    --arg validation_run_id "${run_id}" \
    --arg validation_run_attempt "${run_attempt}" \
    --arg validation_target_sha "${target_sha}" \
    --arg validation_url "${run_url}" \
    --arg validation_workflow_ref "${workflow_ref}" '
      (if $telegram_waiver == "" then . else .telegramWaiver = $telegram_waiver end) |
      .releasePublishRunId = $release_publish_run_id |
      .workflowRuns += [{
        id: $validation_run_id,
        label: $validation_label,
        runAttempt: $validation_run_attempt,
        targetSha: $validation_target_sha,
        url: $validation_url,
        workflowRef: $validation_workflow_ref
      }]
    ' \
    "${evidence_path}" > "${evidence_path}.next"
  mv "${evidence_path}.next" "${evidence_path}"
  {
    echo "- Postpublish verification: passed"
    echo "- Postpublish evidence: \`${evidence_path}\`"
  } >> "$GITHUB_STEP_SUMMARY"
}

append_release_proof_to_github_release() {
  local release_version proof_file notes_file metadata_file evidence_path tarball integrity telegram_line clawhub_line clawhub_bootstrap_line clawhub_runtime_state_path android_line windows_line

  release_version="${RELEASE_TAG#v}"
  proof_file="${RUNNER_TEMP}/release-verification.md"
  notes_file="${RUNNER_TEMP}/release-notes-with-proof.md"
  metadata_file="${RUNNER_TEMP}/release-notes-with-proof.json"
  evidence_path="${POSTPUBLISH_EVIDENCE_DIR}/release-postpublish-evidence.json"
  tarball="$(jq -er '.openclawNpmTarball | select(type == "string" and length > 0)' "${evidence_path}")"
  integrity="$(jq -er '.openclawNpmIntegrity | select(type == "string" and length > 0)' "${evidence_path}")"

  if [[ "$(jq -r '.telegramWaiver // ""' "${evidence_path}")" == "2026.8.1-owner-approved" ]]; then
    telegram_line="- Telegram integration checks: waived by the release owner for 2026.8.1 (source QA, Package Acceptance, published-package E2E); not run."
  elif [[ -n "${NPM_TELEGRAM_RUN_ID// }" ]]; then
    telegram_line="- npm Telegram beta E2E: https://github.com/${GITHUB_REPOSITORY}/actions/runs/${NPM_TELEGRAM_RUN_ID}"
  else
    telegram_line="- npm Telegram beta E2E: not supplied"
  fi
  clawhub_runtime_state_path="${RUNNER_TEMP}/openclaw-release-clawhub-runtime-state-proof.json"
  write_clawhub_runtime_state false "${clawhub_runtime_state_path}"
  clawhub_line="$(jq -r '.proofLines.normal' "${clawhub_runtime_state_path}")"
  clawhub_bootstrap_line="$(jq -r '.proofLines.bootstrap' "${clawhub_runtime_state_path}")"
  windows_line=""
  if [[ -n "${windows_node_run_id// }" ]]; then
    windows_line="- Windows Hub promotion: https://github.com/${GITHUB_REPOSITORY}/actions/runs/${windows_node_run_id} from openclaw/openclaw-windows-node@${WINDOWS_NODE_TAG}"
  fi
  android_line="${android_release_note}"
  proof_label="full release validation"
  proof_run_id="${FULL_RELEASE_VALIDATION_RUN_ID}"
  if [[ "${RELEASE_EVIDENCE_MODE}" == "authorized-beta-focused-v1" ]]; then
    proof_label="authorized beta focused validation"
    proof_run_id="${FOCUSED_RELEASE_EVIDENCE_RUN_ID}"
  fi

  RELEASE_PROOF_FILE="${proof_file}" \
    RELEASE_VERSION="${release_version}" \
    RELEASE_TAG="${RELEASE_TAG}" \
    RELEASE_SHA="${TARGET_SHA}" \
    RELEASE_REPO="${GITHUB_REPOSITORY}" \
    RELEASE_TARBALL="${tarball}" \
    RELEASE_INTEGRITY="${integrity}" \
    RELEASE_PUBLISH_RUN_ID="${GITHUB_RUN_ID}" \
    PREFLIGHT_RUN_ID="${PREFLIGHT_RUN_ID}" \
    RELEASE_VALIDATION_LABEL="${proof_label}" \
    RELEASE_VALIDATION_RUN_ID="${proof_run_id}" \
    PLUGIN_NPM_RUN_ID="${plugin_npm_run_id}" \
    OPENCLAW_NPM_RUN_ID="${openclaw_npm_run_id}" \
    CLAWHUB_LINE="${clawhub_line}" \
    CLAWHUB_BOOTSTRAP_LINE="${clawhub_bootstrap_line}" \
    TELEGRAM_LINE="${telegram_line}" \
    ANDROID_LINE="${android_line}" \
    WINDOWS_LINE="${windows_line}" \
    node --input-type=module <<'NODE'
import { writeFileSync } from "node:fs";

const proofFile = process.env.RELEASE_PROOF_FILE;
if (!proofFile) {
  throw new Error("Missing release proof file path.");
}

const section = [
  "### Release verification",
  "",
  `- npm package: https://www.npmjs.com/package/openclaw/v/${process.env.RELEASE_VERSION}`,
  `- registry tarball: ${process.env.RELEASE_TARBALL}`,
  `- integrity: \`${process.env.RELEASE_INTEGRITY}\``,
  `- release SHA: \`${process.env.RELEASE_SHA}\``,
  `- full release CI report: https://github.com/openclaw/releases/blob/main/evidence/${process.env.RELEASE_VERSION}/release-evidence.md`,
  `- release publish: https://github.com/${process.env.RELEASE_REPO}/actions/runs/${process.env.RELEASE_PUBLISH_RUN_ID}`,
  `- npm preflight: https://github.com/${process.env.RELEASE_REPO}/actions/runs/${process.env.PREFLIGHT_RUN_ID}`,
  `- ${process.env.RELEASE_VALIDATION_LABEL}: https://github.com/${process.env.RELEASE_REPO}/actions/runs/${process.env.RELEASE_VALIDATION_RUN_ID}`,
  `- plugin npm publish: https://github.com/${process.env.RELEASE_REPO}/actions/runs/${process.env.PLUGIN_NPM_RUN_ID}`,
  process.env.CLAWHUB_LINE,
  process.env.CLAWHUB_BOOTSTRAP_LINE,
  // Resumed publishes reuse the already-published npm package and
  // have no core npm run of their own to cite.
  ...(process.env.OPENCLAW_NPM_RUN_ID
    ? [
        `- OpenClaw npm publish: https://github.com/${process.env.RELEASE_REPO}/actions/runs/${process.env.OPENCLAW_NPM_RUN_ID}`,
      ]
    : []),
  process.env.TELEGRAM_LINE,
  ...(process.env.ANDROID_LINE ? [process.env.ANDROID_LINE] : []),
  ...(process.env.WINDOWS_LINE ? [process.env.WINDOWS_LINE] : []),
].join("\n");

writeFileSync(proofFile, section);
NODE

  render_github_release_notes "${notes_file}" "${proof_file}" "${metadata_file}"
  gh release edit "${RELEASE_TAG}" --repo "$GITHUB_REPOSITORY" --notes-file "${notes_file}"
  if jq -e '.verificationIncluded == true' "${metadata_file}" >/dev/null; then
    echo "- Release proof: appended to GitHub release" >> "$GITHUB_STEP_SUMMARY"
  else
    echo "::warning::Release verification proof omitted because the canonical release notes already reach GitHub's body limit."
    echo "- Release proof: omitted from body at GitHub limit; immutable evidence remains attached" >> "$GITHUB_STEP_SUMMARY"
  fi
}
