#!/usr/bin/env bash
set -euo pipefail
test -f scripts/e2e/telegram-user-driver.py
node_bin="$(command -v node)"
corepack_bin="$(command -v corepack)"
corepack_root="$(dirname "$(dirname "$(readlink -f "$corepack_bin")")")"
uv_bin="$(command -v uv)"
recorder_user="$(id -un)"
toolchain_build="${RUNNER_TEMP}/mantis-toolchain-build"
mkdir -p "$toolchain_build/scripts/e2e" "$toolchain_build/scripts/mantis"
node_modules/.bin/esbuild scripts/e2e/telegram-mantis-lane.ts \
  --bundle --platform=node --format=esm --target=node24 \
  --outfile="$toolchain_build/scripts/e2e/telegram-mantis-lane.mjs"
node_modules/.bin/esbuild scripts/e2e/telegram-bot-api-proxy.ts \
  --bundle --platform=node --format=esm --target=node24 \
  --outfile="$toolchain_build/scripts/e2e/telegram-bot-api-proxy.mjs"
node_modules/.bin/esbuild scripts/e2e/mock-openai-server.mjs \
  --bundle --platform=node --format=esm --target=node24 \
  --outfile="$toolchain_build/scripts/e2e/mock-openai-server.mjs"
node_modules/.bin/esbuild scripts/e2e/telegram-desktop-recorder.ts \
  --bundle --platform=node --format=esm --target=node24 \
  --outfile="$toolchain_build/scripts/e2e/telegram-desktop-recorder.mjs"
node_modules/.bin/esbuild scripts/mantis/mantis-sut-lifecycle-controller.ts \
  --bundle --platform=node --format=esm --target=node24 \
  --outfile="$toolchain_build/scripts/mantis/mantis-sut-lifecycle-controller.mjs"
cp scripts/windows-cmd-helpers.mjs "$toolchain_build/scripts/windows-cmd-helpers.mjs"

sudo groupadd --system mantis-proof
sudo usermod -aG mantis-proof "$recorder_user"
sudo useradd --system --create-home --home-dir /var/lib/mantis-sut \
  --shell /usr/sbin/nologin --gid mantis-proof mantis-sut
session_root="/tmp/openclaw-mantis-proof-sessions-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
sudo install -d -m 2770 -o mantis-sut -g mantis-proof "$session_root"
sudo setfacl -m "u:${recorder_user}:rwx,u:mantis-sut:rwx" "$session_root"
sudo setfacl -d -m "u:${recorder_user}:rwx,u:mantis-sut:rwx" "$session_root"

"$node_bin" "$corepack_bin" pnpm --version >/dev/null
cat >"${RUNNER_TEMP}/mantis-pnpm" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec /usr/local/lib/mantis-toolchain/node \
  /usr/local/lib/mantis-toolchain/corepack/dist/corepack.js pnpm "\$@"
EOF
cat >"${RUNNER_TEMP}/telegram-user-driver" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec env -i \
  HOME="${HOME}" \
  PATH=/usr/local/lib/mantis-toolchain:/usr/local/bin:/usr/bin:/bin \
  TELEGRAM_USER_DRIVER_STATE_DIR="/tmp/openclaw-mantis-telegram-user-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}/user-driver" \
  /usr/local/lib/mantis-toolchain/uv run --script \
  "${GITHUB_WORKSPACE}/scripts/e2e/telegram-user-driver.py" "\$@"
EOF
cat >"${RUNNER_TEMP}/openclaw-telegram-user-driver" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [ "\$(id -un)" = "${recorder_user}" ]; then
  exec /usr/local/lib/mantis-toolchain/telegram-user-driver "\$@"
fi
exec sudo -n -u ${recorder_user} /usr/local/lib/mantis-toolchain/telegram-user-driver "\$@"
EOF
cat >"${RUNNER_TEMP}/telegram-desktop-recorder-exec" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "/tmp/openclaw-mantis-proof-sessions-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
exec env -i \
  HOME="${HOME}" \
  OPENCLAW_TELEGRAM_USER_CRABBOX_BIN=/usr/local/bin/crabbox \
  PATH=/usr/local/lib/mantis-toolchain:/usr/local/bin:/usr/bin:/bin \
  TELEGRAM_USER_DRIVER_STATE_DIR="/tmp/openclaw-mantis-telegram-user-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}/user-driver" \
  /usr/local/lib/mantis-toolchain/node \
  /usr/local/lib/mantis-toolchain/scripts/e2e/telegram-desktop-recorder.mjs "\$@"
EOF
cat >"${RUNNER_TEMP}/openclaw-telegram-desktop-recorder" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [ "\$(id -un)" = "${recorder_user}" ]; then
  exec /usr/local/lib/mantis-toolchain/telegram-desktop-recorder "\$@"
fi
exec sudo -n -u ${recorder_user} /usr/local/lib/mantis-toolchain/telegram-desktop-recorder "\$@"
EOF
cat >"${RUNNER_TEMP}/telegram-mantis-lane" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec /usr/bin/setsid env -i \
  HOME=/var/lib/mantis-sut \
  OPENCLAW_BUILD_PRIVATE_QA=1 \
  OPENCLAW_ENABLE_PRIVATE_QA_CLI=1 \
  OPENCLAW_MANTIS_CREDENTIAL_FILE="/tmp/openclaw-mantis-sut-credential-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}/credential.json" \
  OPENCLAW_MANTIS_OUTPUT_ROOT="${GITHUB_WORKSPACE}/${MANTIS_OUTPUT_DIR}" \
  OPENCLAW_MANTIS_SESSION_ROOT="/tmp/openclaw-mantis-proof-sessions-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}" \
  OPENCLAW_TELEGRAM_DESKTOP_RECORDER_CMD=/usr/local/bin/openclaw-telegram-desktop-recorder \
  OPENCLAW_TELEGRAM_USER_DRIVER_CMD=/usr/local/bin/openclaw-telegram-user-driver \
  PATH=/usr/local/lib/mantis-toolchain:/usr/local/bin:/usr/bin:/bin \
  /usr/local/lib/mantis-toolchain/node \
  /usr/local/lib/mantis-toolchain/scripts/e2e/telegram-mantis-lane.mjs "\$@"
EOF
cat >"${RUNNER_TEMP}/openclaw-telegram-mantis-lane" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec sudo -n -u mantis-sut /usr/local/lib/mantis-toolchain/telegram-mantis-lane "\$@"
EOF

chmod 0755 "${RUNNER_TEMP}"/{mantis-pnpm,telegram-user-driver,openclaw-telegram-user-driver,telegram-desktop-recorder-exec,openclaw-telegram-desktop-recorder,telegram-mantis-lane,openclaw-telegram-mantis-lane}
sudo apt-get update
sudo apt-get install -y ffmpeg
sudo install -d -m 0755 /usr/local/lib/mantis-toolchain/scripts/e2e \
  /usr/local/lib/mantis-toolchain/scripts/mantis
sudo install -m 0755 "$node_bin" /usr/local/lib/mantis-toolchain/node
sudo cp -a "$corepack_root" /usr/local/lib/mantis-toolchain/corepack
sudo chown -R root:root /usr/local/lib/mantis-toolchain/corepack
sudo find /usr/local/lib/mantis-toolchain/corepack -xdev ! -type l -perm /222 -exec chmod a-w {} +
sudo install -m 0755 "${RUNNER_TEMP}/mantis-pnpm" /usr/local/lib/mantis-toolchain/pnpm
sudo install -m 0755 "$uv_bin" /usr/local/lib/mantis-toolchain/uv
sudo install -m 0444 "$toolchain_build/scripts/windows-cmd-helpers.mjs" /usr/local/lib/mantis-toolchain/scripts/windows-cmd-helpers.mjs
for file in telegram-mantis-lane telegram-bot-api-proxy mock-openai-server telegram-desktop-recorder; do
  sudo install -m 0444 "$toolchain_build/scripts/e2e/${file}.mjs" "/usr/local/lib/mantis-toolchain/scripts/e2e/${file}.mjs"
done
sudo install -m 0444 "$toolchain_build/scripts/mantis/mantis-sut-lifecycle-controller.mjs" \
  /usr/local/lib/mantis-toolchain/scripts/mantis/mantis-sut-lifecycle-controller.mjs
sudo ln -s /usr/bin/ffmpeg /usr/local/lib/mantis-toolchain/ffmpeg
sudo ln -s /usr/bin/ffprobe /usr/local/lib/mantis-toolchain/ffprobe
sudo install -m 0755 "${RUNNER_TEMP}/telegram-mantis-lane" /usr/local/lib/mantis-toolchain/telegram-mantis-lane
sudo install -m 0755 "${RUNNER_TEMP}/openclaw-telegram-mantis-lane" /usr/local/bin/openclaw-telegram-mantis-lane
sudo install -m 0755 "${RUNNER_TEMP}/telegram-desktop-recorder-exec" /usr/local/lib/mantis-toolchain/telegram-desktop-recorder
sudo install -m 0755 "${RUNNER_TEMP}/openclaw-telegram-desktop-recorder" /usr/local/bin/openclaw-telegram-desktop-recorder
sudo install -m 0755 "${RUNNER_TEMP}/telegram-user-driver" /usr/local/lib/mantis-toolchain/telegram-user-driver
sudo install -m 0755 "${RUNNER_TEMP}/openclaw-telegram-user-driver" /usr/local/bin/openclaw-telegram-user-driver
sudo install -m 0755 scripts/mantis/mantis-sut-container.sh /usr/local/sbin/openclaw-mantis-sut-container

printf '/tmp/openclaw-mantis-proof-worktrees-%s-%s\n' "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" | sudo tee /etc/openclaw-mantis-sut-worktrees >/dev/null
runtime_parent="/tmp/openclaw-mantis-sut-runtime-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
sudo install -d -m 0711 -o root -g root "$runtime_parent"
sudo install -d -m 0700 -o root -g root "$runtime_parent/attestations"
printf '%s\n' "$runtime_parent" | sudo tee /etc/openclaw-mantis-sut-runtime-root >/dev/null
sudo chmod 0444 /etc/openclaw-mantis-sut-worktrees /etc/openclaw-mantis-sut-runtime-root
sudo -u mantis-sut /usr/local/lib/mantis-toolchain/telegram-mantis-lane --help >/dev/null
