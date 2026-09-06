#!/usr/bin/env bash
set -euo pipefail

auth_dir="${HOME}/Library/Application Support/OpenClaw/FaceTime"
ipc_key_file="${auth_dir}/helper-ipc-key"
temporary_key=""

discard_temporary_key() {
  if [[ -n "${temporary_key}" && -e "${temporary_key}" ]]; then
    : > "${temporary_key}"
    if [[ -x /usr/bin/trash ]]; then
      /usr/bin/trash "${temporary_key}" >/dev/null 2>&1 || true
    else
      /usr/bin/python3 -c 'import os, sys; os.unlink(sys.argv[1])' \
        "${temporary_key}" >/dev/null 2>&1 || true
    fi
  fi
}
trap discard_temporary_key EXIT HUP INT TERM

if [[ -L "${auth_dir}" || ( -e "${auth_dir}" && ! -d "${auth_dir}" ) ]]; then
  echo "FaceTime helper authentication path must be a real directory: ${auth_dir}" >&2
  exit 1
fi
mkdir -p "${auth_dir}"
chmod 700 "${auth_dir}"

if [[ ! -e "${ipc_key_file}" ]]; then
  umask 077
  temporary_key="$(mktemp "${auth_dir}/helper-ipc-key.XXXXXX")"
  /usr/bin/openssl rand -hex 32 > "${temporary_key}"
  chmod 600 "${temporary_key}"
  /bin/mv -n "${temporary_key}" "${ipc_key_file}"
  if [[ -e "${temporary_key}" ]]; then
    discard_temporary_key
  fi
  temporary_key=""
fi

if [[ -L "${ipc_key_file}" || ! -f "${ipc_key_file}" ]]; then
  echo "FaceTime helper IPC key must be a regular non-symlink file: ${ipc_key_file}" >&2
  exit 1
fi
owner_uid="$(/usr/bin/stat -f '%u' "${ipc_key_file}")"
file_mode="$(/usr/bin/stat -f '%Lp' "${ipc_key_file}")"
if [[ "${owner_uid}" != "$(id -u)" || "${file_mode}" != "600" ]]; then
  echo "FaceTime helper IPC key must be owned by the current user with mode 0600" >&2
  exit 1
fi
ipc_key="$(tr -d '[:space:]' < "${ipc_key_file}")"
if [[ ! "${ipc_key}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Invalid FaceTime helper IPC key at ${ipc_key_file}" >&2
  exit 1
fi

printf '%s\n' "${ipc_key_file}"
