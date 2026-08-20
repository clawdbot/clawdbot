#!/usr/bin/env bash
set -euo pipefail

tool_name="resolve-release-check-artifacts"
tmp_file=""
cleanup() {
  local exit_code=$?
  [[ -z "$tmp_file" ]] || rm -f "$tmp_file"
  if [[ "$exit_code" -ne 0 ]]; then
    echo "[${tool_name}] FAILED (exit ${exit_code})" >&2
  fi
}
trap cleanup EXIT

fail() {
  echo "${tool_name}: $*" >&2
  exit 1
}

command_name="${1:-}"
[[ -n "$command_name" ]] || fail "usage: ${tool_name} <resolve|validate> [options]"
shift

repository=""
run_id=""
consumer_attempt=""
target_sha=""
selection_file=""
status_dir=""
validated_file=""
github_output=""
pairs=()
while [[ $# -gt 0 ]]; do
  option="$1"
  [[ "$option" == --* && -n "${2:-}" ]] || fail "${option} requires a value"
  value="$2"
  shift 2
  case "$option" in
    --repository) repository="$value" ;;
    --run-id) run_id="$value" ;;
    --consumer-attempt) consumer_attempt="$value" ;;
    --target-sha) target_sha="$value" ;;
    --selection-file) selection_file="$value" ;;
    --status-dir) status_dir="$value" ;;
    --validated-file) validated_file="$value" ;;
    --github-output) github_output="$value" ;;
    --pair) pairs+=("$value") ;;
    *) fail "unknown ${command_name} argument: ${option}" ;;
  esac
done

case "$command_name" in
  resolve)
    [[ "$repository" =~ ^[^/]+/[^/]+$ ]] ||
      fail "--repository must use owner/repository form"
    [[ "$run_id" =~ ^[1-9][0-9]*$ ]] || fail "--run-id must be a positive integer"
    [[ "$consumer_attempt" =~ ^[1-9][0-9]*$ ]] ||
      fail "--consumer-attempt must be a positive integer"
    [[ "$target_sha" =~ ^[0-9a-f]{40}$ ]] ||
      fail "--target-sha must be a lowercase full commit SHA"
    [[ -n "$selection_file" ]] || fail "--selection-file is required"
    mkdir -p "$(dirname "$selection_file")"

    pairs_json="[]"
    if [[ "${#pairs[@]}" -gt 0 ]]; then
      if ! pairs_json="$(
        printf '%s\n' "${pairs[@]}" | jq -Rn '
          [inputs | split("|")] |
          if all(.[];
            length == 4 and .[0] != "" and .[2] != "" and .[3] != ""
          ) then
            map({job: .[0], variant: .[1], status_base: .[2], payload_base: .[3]})
          else
            error("invalid --pair value")
          end
        '
      )"; then
        fail "invalid artifact pair specification"
      fi
    fi

    if [[ "$pairs_json" == "[]" ]]; then
      printf '[]\n' > "$selection_file"
    elif ! gh api --paginate \
      "repos/${repository}/actions/runs/${run_id}/artifacts?per_page=100" |
      jq -e -s \
        --argjson pairs "$pairs_json" \
        --arg run_id "$run_id" \
        --arg target_sha "$target_sha" \
        --argjson consumer_attempt "$consumer_attempt" '
          def selected_artifact($matches; $name; $label):
            if ($matches | length) != 1 then
              error("\($label) requires exactly one \($name) artifact; found \($matches | length)")
            else
              $matches[0]
              | if ((.id | type) == "number" and .id > 0 and (.id | floor) == .id) then .
                else error("\($name) has a missing or invalid artifact id") end
              | if ((.workflow_run.id | tostring) == $run_id) then .
                else error("\($name) does not belong to workflow run \($run_id)") end
              | if .expired == false then .
                else error("\($name) is expired or has invalid expiry metadata") end
            end;
          def select_pair($artifacts; $pair):
            ($pair.job + (if $pair.variant == "" then "" else "/" + $pair.variant end)) as $label
            | ($pair.status_base + "-") as $status_prefix
            | ($pair.payload_base + "-") as $payload_prefix
            | [
                $artifacts[]
                | select((.name | type) == "string")
                | select((.name | startswith($status_prefix)) or
                    (.name | startswith($payload_prefix)))
                | (
                    if (.name | startswith($status_prefix))
                    then .name | ltrimstr($status_prefix)
                    else .name | ltrimstr($payload_prefix)
                    end) as $attempt
                | if ($attempt | test("^[1-9][0-9]*$")) then ($attempt | tonumber)
                  else error("\($label) has malformed producer attempt in artifact \(.name)") end
              ] as $attempts
            | [$attempts[] | select(. <= $consumer_attempt)] as $eligible
            | if ($eligible | length) == 0 then
                error("no \($label) evidence exists through consumer attempt \($consumer_attempt)")
              else
                ($eligible | max) as $attempt
                | ($pair.status_base + "-" + ($attempt | tostring)) as $status_name
                | ($pair.payload_base + "-" + ($attempt | tostring)) as $payload_name
                | selected_artifact(
                    [$artifacts[] | select(.name == $status_name)];
                    $status_name; $label) as $status
                | selected_artifact(
                    [$artifacts[] | select(.name == $payload_name)];
                    $payload_name; $label) as $payload
                | {run_id: $run_id, target_sha: $target_sha, job: $pair.job,
                    variant: $pair.variant, producer_attempt: $attempt,
                    status_id: $status.id, status_name: $status_name,
                    payload_id: $payload.id, payload_name: $payload_name}
              end;
          if all(.[]; (.artifacts | type) == "array") then
            [.[].artifacts[]] as $artifacts
            | [$pairs[] | select_pair($artifacts; .)] as $selected
            | [$selected[] | .status_id, .payload_id] as $ids
            | if ($ids | length) == ($ids | unique | length) then $selected
              else error("logical producers reuse a selected artifact id") end
          else
            error("invalid workflow artifact response")
          end
        ' > "$selection_file"; then
      fail "artifact resolution failed"
    fi

    if [[ -n "$github_output" ]]; then
      {
        printf 'selection_file=%s\n' "$selection_file"
        printf 'status_ids=%s\n' \
          "$(jq -r 'map(.status_id | tostring) | join(",")' "$selection_file")"
        printf 'payload_ids=%s\n' \
          "$(jq -r 'map(.payload_id | tostring) | join(",")' "$selection_file")"
      } >> "$github_output"
    fi
    ;;

  validate)
    [[ -f "$selection_file" ]] || fail "selection file is missing: ${selection_file}"
    [[ -d "$status_dir" ]] || fail "status directory is missing: ${status_dir}"
    [[ -n "$validated_file" ]] || fail "--validated-file is required"
    if ! jq -e '
      type == "array" and
      all(.[];
        (.run_id | type) == "string" and (.target_sha | test("^[0-9a-f]{40}$")) and
        (.job | type) == "string" and (.job | length) > 0 and (.variant | type) == "string" and
        (.producer_attempt | type) == "number" and .producer_attempt > 0 and
        (.producer_attempt | floor) == .producer_attempt and
        (.status_id | type) == "number" and .status_id > 0 and
        (.payload_id | type) == "number" and .payload_id > 0
      ) and
      ([.[] | [.job, .variant] | @tsv] | length) ==
        ([.[] | [.job, .variant] | @tsv] | unique | length)
    ' "$selection_file" >/dev/null; then
      fail "selection file has invalid or duplicate entries"
    fi

    mkdir -p "$(dirname "$validated_file")"
    tmp_file="$(mktemp)"
    while IFS= read -r selection; do
      expected_name="$(
        jq -r '
          .job +
          (if .variant == "" then "" else "-" + .variant end) +
          "-" + .run_id + "-" + (.producer_attempt | tostring) + ".env"
        ' <<< "$selection"
      )"
      status_file="${status_dir}/${expected_name}"
      [[ -f "$status_file" ]] ||
        fail "${expected_name} requires exactly one downloaded status file; found 0"
      if ! jq -Rsc --argjson selection "$selection" '
        def field($key):
          [split("\n")[] | select(startswith($key + "=")) | .[($key | length) + 1:]]
          | if length == 1 then .[0]
            else error("\($key) is duplicate or missing") end;
        {
          run_id: field("run_id"),
          run_attempt: field("run_attempt"),
          target_sha: field("target_sha"),
          job: field("job"),
          variant: field("variant"),
          status: field("status")
        } as $actual
        | if (
            $actual.run_id == $selection.run_id and
            $actual.run_attempt == ($selection.producer_attempt | tostring) and
            $actual.target_sha == $selection.target_sha and
            $actual.job == $selection.job and
            $actual.variant == $selection.variant and
            ($actual.status | IN("success", "failure", "cancelled", "skipped"))
          )
          then $selection + {status: $actual.status}
          else error("status metadata does not match selected evidence")
          end
      ' "$status_file" >> "$tmp_file"; then
        fail "${expected_name} has invalid status metadata"
      fi
    done < <(jq -c '.[]' "$selection_file")
    jq -s '.' "$tmp_file" > "$validated_file"
    if [[ -n "$github_output" ]]; then
      printf 'validated_file=%s\n' "$validated_file" >> "$github_output"
    fi
    ;;

  *)
    fail "usage: ${tool_name} <resolve|validate> [options]"
    ;;
esac
