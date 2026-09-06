#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
staged_dir="${HOME}/Library/Containers/com.apple.FaceTime/Data/tmp"
staged_dylib="${staged_dir}/FaceTimeHelper.dylib"
auth_dir="${HOME}/Library/Application Support/OpenClaw/FaceTime"
build_stamp_file="${auth_dir}/helper-build.sha256"
native_dirs=(
  "/opt/homebrew/opt/openclaw-facetime/libexec"
  "/usr/local/opt/openclaw-facetime/libexec"
)

if [[ $# -gt 0 && "${1}" != "--if-needed" ]]; then
  echo "Usage: $0 [--if-needed]" >&2
  exit 2
fi

installed_dir=""
for native_dir in "${native_dirs[@]}"; do
  if [[ -f "${native_dir}/FaceTimeHelper.dylib" &&
        -f "${native_dir}/FaceTimeHelper.build-id" &&
        -f "${native_dir}/native-protocol.env" ]]; then
    installed_dir="${native_dir}"
    break
  fi
done
if [[ -z "${installed_dir}" ]]; then
  echo "FaceTime native helpers are missing. Install them with: brew install openclaw/tap/openclaw-facetime" >&2
  exit 1
fi

source_dylib="${installed_dir}/FaceTimeHelper.dylib"
source_hash="$(tr -d '[:space:]' < "${installed_dir}/FaceTimeHelper.build-id")"
protocol="$(tr -d '[:space:]' < "${installed_dir}/native-protocol.env")"
if [[ ! "${source_hash}" =~ ^[0-9a-f]{64}$ ]] ||
   [[ "${protocol}" != "NATIVE_PROTOCOL_VERSION=1" ]] ||
   ! "${repo_root}/scripts/verify-native-helper.sh" "${source_dylib}" >/dev/null 2>&1 ||
   ! /usr/bin/strings "${source_dylib}" | /usr/bin/grep -Fx "${source_hash}" >/dev/null; then
  echo "Installed FaceTime native helpers failed compatibility or signature validation. Reinstall openclaw/tap/openclaw-facetime." >&2
  exit 1
fi

mkdir -p "${staged_dir}" "${auth_dir}"
"${repo_root}/scripts/ensure-helper-ipc-key.sh" >/dev/null
if [[ "${1:-}" == "--if-needed" && -f "${staged_dylib}" && -f "${build_stamp_file}" &&
      "$(tr -d '[:space:]' < "${build_stamp_file}")" == "${source_hash}" ]] &&
   "${repo_root}/scripts/verify-native-helper.sh" "${staged_dylib}" >/dev/null 2>&1; then
  echo "${staged_dylib}"
  exit 0
fi

/usr/bin/ditto "${source_dylib}" "${staged_dylib}"
"${repo_root}/scripts/verify-native-helper.sh" "${staged_dylib}"
printf '%s\n' "${source_hash}" > "${build_stamp_file}"
echo "${staged_dylib}"
