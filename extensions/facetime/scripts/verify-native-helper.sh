#!/usr/bin/env bash
set -euo pipefail

expected_team_id="FWJYW4S8P8"
expected_authority="Developer ID Application: OpenClaw Foundation (${expected_team_id})"

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <FaceTimeHelper.dylib>" >&2
  exit 2
fi

helper_path=$1
if [[ -L "${helper_path}" || ! -f "${helper_path}" ]]; then
  echo "FaceTime helper must be a regular non-symlink file: ${helper_path}" >&2
  exit 1
fi

developer_id_requirement="anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"${expected_team_id}\" and certificate leaf[subject.CN] = \"${expected_authority}\""
if ! /usr/bin/codesign --verify --strict \
  --test-requirement="=${developer_id_requirement}" "${helper_path}"; then
  echo "FaceTime helper is not signed by ${expected_authority}" >&2
  exit 1
fi

if ! /usr/bin/codesign --verify --strict --check-notarization \
  -R=notarized "${helper_path}"; then
  echo "FaceTime helper does not have an accepted Apple notarization ticket" >&2
  exit 1
fi
