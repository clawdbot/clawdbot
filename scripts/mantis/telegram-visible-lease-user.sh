#!/usr/bin/env bash
set -euo pipefail
tdlib_dir="${RUNNER_TEMP}/mantis-tdlib"
credential_dir="/tmp/openclaw-mantis-telegram-user-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
mkdir -p "$tdlib_dir" "$credential_dir/user-driver" "$credential_dir/desktop"
tdlib_url=http://artifacts.openclaw.ai/tdlib-v1.8.0-linux-x64.tgz
tdlib_sha256=943518ad39f67e20f843713ba5c88fedbd06111fbc314c61bfb2fc3f1a45743e
curl --fail --location --retry 3 --output "$tdlib_dir/tdlib.tgz" "$tdlib_url"
printf '%s  %s\n' "$tdlib_sha256" "$tdlib_dir/tdlib.tgz" | sha256sum --check --strict
tar -xzf "$tdlib_dir/tdlib.tgz" -C "$tdlib_dir"
sudo install -m 0755 "$tdlib_dir/tdlib-v1.8.0-linux-x64/lib/libtdjson.so" /usr/local/lib/libtdjson.so

echo "lease_file=$credential_dir/lease.json" >> "$GITHUB_OUTPUT"
lease_deadline=$(( SECONDS + 4 * 60 * 60 ))
until node --import tsx scripts/e2e/telegram-user-credential.ts lease-restore \
  --user-driver-dir "$credential_dir/user-driver" \
  --desktop-workdir "$credential_dir/desktop" \
  --lease-file "$credential_dir/lease.json" \
  --payload-output "$credential_dir/payload.json" \
  --credential-role ci; do
  if ((SECONDS >= lease_deadline)); then
    echo "::error::The shared QA Telegram account remained busy for four hours."
    exit 1
  fi
  sleep 15
done
keepalive_pid_file="$credential_dir/lease-keepalive.pid"
lease_lost_marker="$credential_dir/lease.json.lost"
keepalive_log="$credential_dir/lease-keepalive.log"
/usr/bin/setsid /usr/local/lib/mantis-toolchain/node --import tsx \
  scripts/e2e/telegram-user-credential.ts heartbeat-loop \
  --lease-file "$credential_dir/lease.json" --credential-role ci --interval-ms 30000 \
  </dev/null >"$keepalive_log" 2>&1 &
printf '%s\n' "$!" >"$keepalive_pid_file"
chmod 0700 "$credential_dir" "$credential_dir/user-driver"

sut_credential_dir="/tmp/openclaw-mantis-sut-credential-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
session_root="/tmp/openclaw-mantis-proof-sessions-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
sudo install -d -m 0710 -o root -g mantis-proof "$sut_credential_dir"
jq -e '
  {groupId,sutToken,testerUserId} |
  select((.groupId | type) == "string" and (.groupId | length) > 0) |
  select((.sutToken | type) == "string" and (.sutToken | length) > 0) |
  select(.testerUserId != null)
' "$credential_dir/payload.json" \
  | sudo install -m 0400 -o mantis-sut -g mantis-proof /dev/stdin "$sut_credential_dir/credential.json"
rm -f "$credential_dir/payload.json"
{
  echo "credential_dir=$credential_dir"
  echo "lease_keepalive_pid_file=$keepalive_pid_file"
  echo "lease_lost_marker=$lease_lost_marker"
  echo "session_root=$session_root"
  echo "sut_credential_dir=$sut_credential_dir"
} >> "$GITHUB_OUTPUT"
