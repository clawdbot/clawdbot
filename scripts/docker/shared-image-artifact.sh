#!/usr/bin/env bash
set -euo pipefail

command_name="${1:?command is required}"
shift
artifact_dir=""
artifact_kind=""
target_sha=""
workflow_sha=""
image_refs=()
shared_package_sha256="${OPENCLAW_SHARED_IMAGE_PACKAGE_SHA256:-}"
shared_archive_sha256="${OPENCLAW_SHARED_IMAGE_ARCHIVE_SHA256:-}"
shared_run_id="${OPENCLAW_SHARED_IMAGE_RUN_ID:-}"
shared_run_attempt="${OPENCLAW_SHARED_IMAGE_RUN_ATTEMPT:-}"

archive_name="shared-images.tar.zst"
manifest_path=""
archive_path=""

fail() {
  echo "$*" >&2
  exit 1
}

require_sha() {
  local label="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[a-f0-9]{40}$ ]]; then
    fail "$label must be a lowercase full commit SHA."
  fi
}

require_positive_decimal() {
  local label="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    fail "$label must be a positive decimal integer."
  fi
}

configure_image_artifact_inputs() {
  if [[ "$#" -lt 5 ]]; then
    fail "usage: $0 <pack|load> <artifact-dir> <kind> <target-sha> <workflow-sha> <image-ref>..."
  fi
  artifact_dir="$1"
  artifact_kind="$2"
  target_sha="$3"
  workflow_sha="$4"
  image_refs=("${@:5}")
  manifest_path="${artifact_dir}/shared-image-artifact.json"
  archive_path="${artifact_dir}/${archive_name}"
}

verify_uploaded_artifact() {
  if [[ "$#" -ne 6 ]]; then
    fail "usage: $0 verify-upload <label> <artifact-id> <artifact-name> <artifact-digest> <run-id> <run-attempt>"
  fi

  local artifact_label="$1"
  local artifact_id="$2"
  local artifact_name="$3"
  local artifact_digest="$4"
  local artifact_run_id="$5"
  local artifact_run_attempt="$6"
  require_positive_decimal "$artifact_label artifact ID" "$artifact_id"
  require_positive_decimal "$artifact_label producer run ID" "$artifact_run_id"
  require_positive_decimal "$artifact_label producer run attempt" "$artifact_run_attempt"
  if [[ ! "$artifact_digest" =~ ^[a-f0-9]{64}$ ]]; then
    fail "$artifact_label artifact digest must be a lowercase SHA-256."
  fi
  if [[ -z "${artifact_name// }" || "$artifact_name" == *$'\n'* || "$artifact_name" == *$'\r'* ]]; then
    fail "$artifact_label artifact name is missing or invalid."
  fi
  if [[ "$artifact_name" != *"-${artifact_run_id}-${artifact_run_attempt}" ]]; then
    fail "$artifact_label artifact name does not bind the producer run attempt."
  fi
  if [[ ! "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    fail "GITHUB_REPOSITORY is missing or invalid."
  fi
  if [[ -z "${GH_TOKEN:-}" ]]; then
    fail "GH_TOKEN is required to verify the uploaded artifact."
  fi
  command -v gh >/dev/null
  command -v jq >/dev/null

  local artifact_json attempt_json
  artifact_json="$(gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts/${artifact_id}")"
  jq -e \
    --arg digest "sha256:${artifact_digest}" \
    --arg id "$artifact_id" \
    --arg name "$artifact_name" \
    --arg run_id "$artifact_run_id" \
    '
      (.id | tostring) == $id and
      .name == $name and
      .expired == false and
      .digest == $digest and
      (.workflow_run.id | tostring) == $run_id
    ' <<< "$artifact_json" >/dev/null ||
    fail "$artifact_label artifact identity does not match the immutable producer tuple."

  attempt_json="$(
    gh api \
      "repos/${GITHUB_REPOSITORY}/actions/runs/${artifact_run_id}/attempts/${artifact_run_attempt}"
  )"
  jq -e \
    --arg attempt "$artifact_run_attempt" \
    --arg run_id "$artifact_run_id" \
    '(.id | tostring) == $run_id and (.run_attempt | tostring) == $attempt' \
    <<< "$attempt_json" >/dev/null ||
    fail "$artifact_label producer run attempt does not match the immutable tuple."
}

require_common_inputs() {
  require_sha "target SHA" "$target_sha"
  require_sha "workflow SHA" "$workflow_sha"
  if [[ -n "$shared_package_sha256" && ! "$shared_package_sha256" =~ ^[a-f0-9]{64}$ ]]; then
    fail "shared package SHA-256 must be a lowercase digest."
  fi
  if [[ ! "$artifact_kind" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    fail "artifact kind must contain only lowercase letters, digits, and hyphens."
  fi
  if [[ "${#image_refs[@]}" -eq 0 ]]; then
    fail "at least one image ref is required."
  fi
  local image_ref
  declare -A seen_refs=()
  for image_ref in "${image_refs[@]}"; do
    if [[ ! "$image_ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/@:-]*$ ]]; then
      fail "image ref contains unsupported characters: $image_ref"
    fi
    if [[ -n "${seen_refs[$image_ref]:-}" ]]; then
      fail "duplicate image ref: $image_ref"
    fi
    seen_refs["$image_ref"]=1
  done
}

require_safe_pack_destination() {
  if [[ -z "${RUNNER_TEMP:-}" || "$RUNNER_TEMP" != /* ]]; then
    fail "RUNNER_TEMP must be an absolute path for artifact packing."
  fi
  if [[ "$artifact_dir" != /* ]]; then
    fail "artifact directory must be absolute for artifact packing."
  fi

  local artifact_basename artifact_parent resolved_artifact_parent resolved_runner_temp runner_temp
  runner_temp="${RUNNER_TEMP%/}"
  artifact_basename="$(basename "$artifact_dir")"
  artifact_parent="$(dirname "$artifact_dir")"
  if [[ ! "$artifact_basename" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    fail "artifact directory name contains unsupported characters."
  fi
  resolved_runner_temp="$(cd "$RUNNER_TEMP" && pwd -P)"
  resolved_artifact_parent="$(cd "$artifact_parent" && pwd -P)"
  if [[ "$resolved_artifact_parent" != "$resolved_runner_temp" ]]; then
    fail "artifact directory must be a child of RUNNER_TEMP."
  fi
  if [[ "$artifact_parent" != "$runner_temp" ||
    "$artifact_dir" != "${runner_temp}/${artifact_basename}" ||
    -L "$artifact_dir" ]]; then
    fail "artifact directory must be a normalized path without symlink or parent traversal."
  fi
}

pack_artifact() {
  require_common_inputs
  require_safe_pack_destination
  command -v docker >/dev/null
  command -v node >/dev/null
  command -v sha256sum >/dev/null
  command -v zstd >/dev/null

  local image_list image_ref image_id image_tar archive_sha256 archive_size_bytes
  local stage_dir stage_manifest_path stage_archive_path
  image_list="$(mktemp)"
  image_tar="$(mktemp)"
  stage_dir="$(mktemp -d "${RUNNER_TEMP}/shared-image-artifact.XXXXXX")"
  stage_manifest_path="${stage_dir}/shared-image-artifact.json"
  stage_archive_path="${stage_dir}/${archive_name}"
  cleanup_pack() {
    rm -f "$image_list" "$image_tar"
    if [[ -n "${stage_dir:-}" ]]; then
      rm -rf -- "$stage_dir"
    fi
  }
  trap cleanup_pack EXIT

  for image_ref in "${image_refs[@]}"; do
    image_id="$(docker image inspect --format '{{.Id}}' "$image_ref")"
    if [[ ! "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]]; then
      fail "image has an invalid config digest: $image_ref"
    fi
    printf '%s\t%s\n' "$image_ref" "$image_id" >> "$image_list"
  done

  docker image save --output "$image_tar" "${image_refs[@]}"
  zstd -T0 -10 --no-progress -f "$image_tar" -o "$stage_archive_path"
  zstd -t "$stage_archive_path"
  archive_sha256="$(sha256sum "$stage_archive_path" | awk '{print $1}')"
  archive_size_bytes="$(wc -c < "$stage_archive_path" | tr -d '[:space:]')"

  ARCHIVE_SHA256="$archive_sha256" \
    ARCHIVE_SIZE_BYTES="$archive_size_bytes" \
    node - "$stage_manifest_path" "$image_list" <<'NODE'
const fs = require("node:fs");

const [manifestPath, imageListPath] = process.argv.slice(2);
const images = fs
  .readFileSync(imageListPath, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [ref, id] = line.split("\t");
    return { ref, id };
  });
const manifest = {
  schema: "openclaw.shared-docker-image-artifact/v1",
  schemaVersion: 1,
  kind: process.env.ARTIFACT_KIND,
  targetSha: process.env.TARGET_SHA,
  workflowSha: process.env.WORKFLOW_SHA,
  packageSha256: process.env.SHARED_PACKAGE_SHA256 || null,
  packageSourceSha: process.env.SHARED_PACKAGE_SHA256 ? process.env.TARGET_SHA : null,
  runId: Number(process.env.GITHUB_RUN_ID),
  runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  archive: {
    filename: process.env.ARCHIVE_NAME,
    format: "docker-tar+zstd",
    sha256: process.env.ARCHIVE_SHA256,
    sizeBytes: Number(process.env.ARCHIVE_SIZE_BYTES),
  },
  images,
  conclusion: "success",
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

  rm -rf -- "$artifact_dir"
  mv -- "$stage_dir" "$artifact_dir"
  stage_dir=""
  cleanup_pack
  trap - EXIT
}

load_artifact() {
  require_common_inputs
  if [[ ! "$shared_archive_sha256" =~ ^[a-f0-9]{64}$ ]]; then
    fail "expected shared image archive SHA-256 must be a lowercase digest."
  fi
  command -v docker >/dev/null
  command -v node >/dev/null
  command -v sha256sum >/dev/null
  command -v zstd >/dev/null
  [[ -f "$manifest_path" ]] || fail "shared Docker image artifact manifest is missing: $manifest_path"
  [[ -f "$archive_path" ]] || fail "shared Docker image archive is missing: $archive_path"

  local validated_path
  validated_path="$(mktemp)"
  cleanup_load() {
    rm -f "$validated_path"
  }
  trap cleanup_load EXIT

  EXPECTED_IMAGES_JSON="$(
    printf '%s\0' "${image_refs[@]}" |
      node -e '
        const fs = require("node:fs");
        const refs = fs.readFileSync(0).toString("utf8").split("\0").filter(Boolean);
        process.stdout.write(JSON.stringify(refs));
      '
  )" node - "$manifest_path" > "$validated_path" <<'NODE'
const fs = require("node:fs");

const [manifestPath] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const expectedRefs = JSON.parse(process.env.EXPECTED_IMAGES_JSON);
const fail = (message) => {
  throw new Error(`invalid shared Docker image artifact: ${message}`);
};

if (value.schema !== "openclaw.shared-docker-image-artifact/v1") fail("schema");
if (value.schemaVersion !== 1) fail("schemaVersion");
if (value.kind !== process.env.ARTIFACT_KIND) fail("kind");
if (value.targetSha !== process.env.TARGET_SHA) fail("target SHA");
if (value.workflowSha !== process.env.WORKFLOW_SHA) fail("workflow SHA");
const expectedPackageSha256 = process.env.SHARED_PACKAGE_SHA256 || null;
const expectedPackageSourceSha = expectedPackageSha256 ? process.env.TARGET_SHA : null;
if (value.packageSha256 !== expectedPackageSha256) fail("package SHA-256");
if (value.packageSourceSha !== expectedPackageSourceSha) fail("package source SHA");
if (value.runId !== Number(process.env.SHARED_RUN_ID)) fail("run ID");
if (value.runAttempt !== Number(process.env.SHARED_RUN_ATTEMPT)) fail("run attempt");
if (value.conclusion !== "success") fail("conclusion");
if (value.archive?.filename !== "shared-images.tar.zst") fail("archive filename");
if (value.archive?.format !== "docker-tar+zstd") fail("archive format");
if (!/^[a-f0-9]{64}$/.test(value.archive?.sha256 ?? "")) fail("archive sha256");
if (value.archive.sha256 !== process.env.SHARED_ARCHIVE_SHA256) fail("expected archive sha256");
if (!Number.isSafeInteger(value.archive?.sizeBytes) || value.archive.sizeBytes <= 0) {
  fail("archive size");
}
if (!Array.isArray(value.images) || value.images.length !== expectedRefs.length) {
  fail("image count");
}
for (let index = 0; index < expectedRefs.length; index += 1) {
  const image = value.images[index];
  if (image?.ref !== expectedRefs[index]) fail(`image ref ${index}`);
  if (!/^sha256:[a-f0-9]{64}$/.test(image?.id ?? "")) fail(`image id ${index}`);
}

process.stdout.write(`${value.archive.sha256}\n${value.archive.sizeBytes}\n`);
for (const image of value.images) {
  process.stdout.write(`${image.ref}\t${image.id}\n`);
}
NODE

  mapfile -t validated < "$validated_path"
  if [[ "${#validated[@]}" -ne $((2 + ${#image_refs[@]})) ]]; then
    fail "invalid shared Docker image artifact: validated manifest output length"
  fi
  local actual_archive_sha256 actual_archive_size
  actual_archive_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
  actual_archive_size="$(wc -c < "$archive_path" | tr -d '[:space:]')"
  if [[ "$actual_archive_sha256" != "${validated[0]}" ]]; then
    fail "shared Docker image artifact archive SHA-256 mismatch."
  fi
  if [[ "$actual_archive_size" != "${validated[1]}" ]]; then
    fail "shared Docker image artifact archive size mismatch."
  fi
  zstd -t "$archive_path"
  zstd -d --stdout "$archive_path" | docker image load

  local index expected_ref expected_id actual_id
  for index in "${!image_refs[@]}"; do
    IFS=$'\t' read -r expected_ref expected_id <<< "${validated[$((index + 2))]}"
    if [[ "$expected_ref" != "${image_refs[$index]}" ]]; then
      fail "shared Docker image artifact ref mismatch after validation: ${image_refs[$index]}"
    fi
    actual_id="$(docker image inspect --format '{{.Id}}' "$expected_ref")"
    if [[ "$actual_id" != "$expected_id" ]]; then
      fail "shared Docker image artifact loaded ID mismatch for $expected_ref."
    fi
  done

  cleanup_load
  trap - EXIT
}

case "$command_name" in
  pack | load)
    configure_image_artifact_inputs "$@"
    export ARTIFACT_KIND="$artifact_kind"
    export TARGET_SHA="$target_sha"
    export WORKFLOW_SHA="$workflow_sha"
    export ARCHIVE_NAME="$archive_name"
    export SHARED_PACKAGE_SHA256="$shared_package_sha256"
    export SHARED_ARCHIVE_SHA256="$shared_archive_sha256"
    if [[ "$command_name" == "pack" ]]; then
      require_positive_decimal "GITHUB_RUN_ID" "${GITHUB_RUN_ID:-}"
      require_positive_decimal "GITHUB_RUN_ATTEMPT" "${GITHUB_RUN_ATTEMPT:-}"
      export SHARED_RUN_ID="$GITHUB_RUN_ID"
      export SHARED_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT"
      export ARCHIVE_SHA256=""
      export ARCHIVE_SIZE_BYTES=""
      pack_artifact
    else
      require_positive_decimal "OPENCLAW_SHARED_IMAGE_RUN_ID" "$shared_run_id"
      require_positive_decimal "OPENCLAW_SHARED_IMAGE_RUN_ATTEMPT" "$shared_run_attempt"
      export SHARED_RUN_ID="$shared_run_id"
      export SHARED_RUN_ATTEMPT="$shared_run_attempt"
      load_artifact
    fi
    ;;
  verify-upload)
    verify_uploaded_artifact "$@"
    ;;
  *)
    echo "usage: $0 <pack|load|verify-upload> ..." >&2
    exit 1
    ;;
esac
