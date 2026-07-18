#!/usr/bin/env bash
set -Eeuo pipefail

source scripts/lib/openclaw-e2e-instance.sh
source scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh

if [ "${OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF:-0}" != "1" ]; then
  echo "blocked destructive package self-upgrade; set OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF=1 to run" >&2
  exit 2
fi

export CI=true
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_NO_PROMPT=1
export OPENCLAW_SKIP_PROVIDERS=1
export OPENCLAW_DISABLE_BONJOUR=1
export npm_config_audit=false
export npm_config_fund=false
export npm_config_loglevel=error

SOURCE_VERSION="${OPENCLAW_UPDATE_RUN_SELF_UPGRADE_SOURCE_VERSION:-2026.4.26}"
SOURCE_SPEC="openclaw@$SOURCE_VERSION"
TARGET_TAG="latest"
RESTART_NOTE="QA-UPDATE-RUN-PACKAGE-SELF-UPGRADE"
PORT=18789
QA_BUS_PORT=43123
ARTIFACT_DIR="${OPENCLAW_UPDATE_RUN_SELF_UPGRADE_ARTIFACT_DIR:-/tmp/openclaw-update-run-artifacts}"
RUNTIME_ROOT="${OPENCLAW_UPDATE_RUN_SELF_UPGRADE_RUNTIME_ROOT:-/tmp/openclaw-update-run-runtime}"
export HOME="$RUNTIME_ROOT/home"
export OPENCLAW_STATE_DIR="$HOME/.openclaw"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
export OPENCLAW_TEST_WORKSPACE_DIR="$HOME/workspace"
export npm_config_prefix="$RUNTIME_ROOT/npm-prefix"
export NPM_CONFIG_PREFIX="$npm_config_prefix"
export npm_config_cache="$RUNTIME_ROOT/npm-cache"
export NPM_CONFIG_CACHE="$npm_config_cache"
export PATH="$npm_config_prefix/bin:$PATH"

BASELINE_INSTALL_LOG="$ARTIFACT_DIR/baseline-install.log"
PLUGIN_INSTALL_LOG="$ARTIFACT_DIR/plugin-install.log"
SOURCE_PLUGIN_INSPECT_JSON="$ARTIFACT_DIR/source-plugin-inspect.json"
QA_CHANNEL_INSTALL_RECORD_JSON="$ARTIFACT_DIR/qa-channel-install-record.json"
SOURCE_PLUGIN_INDEX_JSON="$ARTIFACT_DIR/source-plugin-index.json"
TARGET_PLUGIN_INDEX_JSON="$ARTIFACT_DIR/target-plugin-index.json"
TARGET_RESOLUTION_JSON="$ARTIFACT_DIR/target-resolution.json"
GATEWAY_LOG="$ARTIFACT_DIR/gateway.log"
QA_BUS_LOG="$ARTIFACT_DIR/qa-bus.jsonl"
QA_BUS_STDIO_LOG="$ARTIFACT_DIR/qa-bus.log"
QA_BUS_READY_FILE="$RUNTIME_ROOT/qa-bus.ready"
UPDATE_RPC_JSON="$ARTIFACT_DIR/update-rpc.json"
UPDATE_RPC_ERR="$ARTIFACT_DIR/update-rpc.err"
UPDATE_STATUS_JSON="$ARTIFACT_DIR/update-status.json"
UPDATE_STATUS_ERR="$ARTIFACT_DIR/update-status.err"
HEALTHZ_JSON="$ARTIFACT_DIR/healthz.json"
READYZ_JSON="$ARTIFACT_DIR/readyz.json"
GATEWAY_STATUS_JSON="$ARTIFACT_DIR/gateway-status.json"
GATEWAY_STATUS_ERR="$ARTIFACT_DIR/gateway-status.err"
CHANNELS_STATUS_JSON="$ARTIFACT_DIR/channels-status.json"
CHANNELS_STATUS_ERR="$ARTIFACT_DIR/channels-status.err"
SUMMARY_JSON="$ARTIFACT_DIR/summary.json"
SYSTEMCTL_SHIM_LOG="$ARTIFACT_DIR/systemctl-shim.log"
SYSTEMCTL_SHIM_SETUP_LOG="$ARTIFACT_DIR/systemctl-shim-setup.log"
SYSTEMCTL_SHIM_PID_FILE="$ARTIFACT_DIR/systemctl-shim.pid"
SYSTEMCTL_SHIM_DAEMON_LOG="$ARTIFACT_DIR/systemctl-shim-gateway.log"
SUPERVISOR_MONITOR_LOG="$ARTIFACT_DIR/supervisor-monitor.log"
SERVICE_INSTALL_JSON="$ARTIFACT_DIR/gateway-service-install.json"
SERVICE_INSTALL_ERR="$ARTIFACT_DIR/gateway-service-install.err"
SERVICE_UNIT_ARTIFACT="$ARTIFACT_DIR/openclaw-gateway.service"
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG="$SYSTEMCTL_SHIM_LOG"
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE="$SYSTEMCTL_SHIM_PID_FILE"
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG="$SYSTEMCTL_SHIM_DAEMON_LOG"
gateway_pid=""
qa_bus_pid=""
supervisor_monitor_pid=""

mkdir -p \
  "$ARTIFACT_DIR" \
  "$HOME" \
  "$OPENCLAW_STATE_DIR" \
  "$OPENCLAW_TEST_WORKSPACE_DIR" \
  "$npm_config_prefix" \
  "$npm_config_cache"
rm -f \
  "$QA_BUS_READY_FILE" \
  "$QA_BUS_LOG" \
  "$UPDATE_STATUS_JSON" \
  "$UPDATE_STATUS_ERR" \
  "$ARTIFACT_DIR/update-status.candidate.json" \
  "$SUMMARY_JSON"
: >"$SYSTEMCTL_SHIM_DAEMON_LOG"

cleanup() {
  if [ -n "${supervisor_monitor_pid:-}" ]; then
    kill "$supervisor_monitor_pid" >/dev/null 2>&1 || true
    wait "$supervisor_monitor_pid" >/dev/null 2>&1 || true
  fi
  openclaw_e2e_terminate_gateways "${gateway_pid:-}"
  if [ -s "$SYSTEMCTL_SHIM_PID_FILE" ]; then
    openclaw_e2e_terminate_gateways "$(cat "$SYSTEMCTL_SHIM_PID_FILE" 2>/dev/null || true)"
  fi
  if [ -n "${qa_bus_pid:-}" ]; then
    kill "$qa_bus_pid" >/dev/null 2>&1 || true
    wait "$qa_bus_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

package_root() {
  printf '%s/lib/node_modules/openclaw\n' "$npm_config_prefix"
}

read_installed_version() {
  node -p \
    'JSON.parse(require("node:fs").readFileSync(process.argv[1] + "/package.json", "utf8")).version' \
    "$(package_root)"
}

echo "Installing declared source package $SOURCE_SPEC"
openclaw_e2e_maybe_timeout 600s \
  npm install -g --prefix "$npm_config_prefix" "$SOURCE_SPEC" --no-fund --no-audit \
  >"$BASELINE_INSTALL_LOG" 2>&1

installed_source_version="$(read_installed_version)"
if [ "$installed_source_version" != "$SOURCE_VERSION" ]; then
  echo "source package version mismatch: expected $SOURCE_VERSION, got $installed_source_version" >&2
  exit 1
fi
if ! openclaw --version | grep -Fq "$SOURCE_VERSION"; then
  echo "source openclaw --version did not report $SOURCE_VERSION" >&2
  exit 1
fi

target_version="$(
  npm view "openclaw@$TARGET_TAG" version --json --prefer-online --cache "$npm_config_cache" |
    node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => (raw += chunk));
      process.stdin.on("end", () => {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "string" || !parsed.trim()) process.exit(1);
        process.stdout.write(parsed.trim());
      });
    '
)"
if [ "$target_version" = "$SOURCE_VERSION" ]; then
  echo "resolved target $TARGET_TAG is a no-op at $target_version" >&2
  exit 1
fi
TARGET_VERSION="$target_version" TARGET_TAG="$TARGET_TAG" node -e '
  const fs = require("node:fs");
  fs.writeFileSync(
    process.argv[1],
    `${JSON.stringify({ tag: process.env.TARGET_TAG, version: process.env.TARGET_VERSION }, null, 2)}\n`,
  );
' "$TARGET_RESOLUTION_JSON"

qa_plugin_source="/tmp/openclaw-update-run-build/dist/extensions/qa-channel"
qa_plugin_dir="$qa_plugin_source"
if [ ! -f "$qa_plugin_source/openclaw.plugin.json" ] || [ ! -f "$qa_plugin_source/index.js" ]; then
  echo "compiled tagged QA channel fixture is missing" >&2
  exit 1
fi
QA_PLUGIN_SOURCE="$qa_plugin_source" node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(process.env.QA_PLUGIN_SOURCE, "package.json"), "utf8"),
  );
  const entries = [
    ...(packageJson.openclaw?.extensions ?? []),
    packageJson.openclaw?.setupEntry,
  ].filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => /\.[cm]?ts$/u.test(entry))) {
    throw new Error(`compiled QA channel retained TypeScript entrypoints: ${JSON.stringify(entries)}`);
  }
  for (const entry of entries) {
    const relative = entry.replace(/^\.\//u, "");
    if (!fs.existsSync(path.join(process.env.QA_PLUGIN_SOURCE, relative))) {
      throw new Error(`compiled QA channel entry is missing: ${entry}`);
    }
  }
'
openclaw_e2e_maybe_timeout 300s \
  openclaw plugins install "$qa_plugin_source" --link \
  >"$PLUGIN_INSTALL_LOG" 2>&1
openclaw plugins inspect qa-channel --json >"$SOURCE_PLUGIN_INSPECT_JSON"
node -e '
  const fs = require("node:fs");
  const inspect = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (inspect?.plugin?.status !== "loaded") {
    throw new Error(`source plugin inspection did not load qa-channel: ${JSON.stringify(inspect)}`);
  }
' "$SOURCE_PLUGIN_INSPECT_JSON"
  QA_PLUGIN_SOURCE="$qa_plugin_source" \
  QA_PLUGIN_INSTALL="$qa_plugin_dir" \
  QA_PLUGIN_RECORD_OUT="$QA_CHANNEL_INSTALL_RECORD_JSON" \
  SOURCE_PLUGIN_INDEX_OUT="$SOURCE_PLUGIN_INDEX_JSON" \
  node -e '
    const fs = require("node:fs");
    const indexPath = `${process.env.OPENCLAW_STATE_DIR}/plugins/installs.json`;
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const record = index.installRecords?.["qa-channel"];
    if (
    record?.source !== "path" ||
    record.sourcePath !== process.env.QA_PLUGIN_SOURCE ||
    record.installPath !== process.env.QA_PLUGIN_INSTALL ||
      record.version !== "2026.4.25"
    ) {
      throw new Error(`unexpected qa-channel install record: ${JSON.stringify(record)}`);
    }
    fs.writeFileSync(process.env.QA_PLUGIN_RECORD_OUT, `${JSON.stringify(record, null, 2)}\n`);
    fs.copyFileSync(indexPath, process.env.SOURCE_PLUGIN_INDEX_OUT);
  '

node scripts/e2e/lib/upgrade-survivor/mock-server.mjs \
  --port "$QA_BUS_PORT" \
  --ready-file "$QA_BUS_READY_FILE" \
  --log-file "$QA_BUS_LOG" \
  >"$QA_BUS_STDIO_LOG" 2>&1 &
qa_bus_pid="$!"
for _ in $(seq 1 100); do
  if [ -s "$QA_BUS_READY_FILE" ]; then
    break
  fi
  if ! kill -0 "$qa_bus_pid" 2>/dev/null; then
    openclaw_e2e_print_log "$QA_BUS_STDIO_LOG" >&2
    exit 1
  fi
  sleep 0.1
done
if [ ! -s "$QA_BUS_READY_FILE" ]; then
  echo "timed out waiting for QA bus fixture" >&2
  exit 1
fi

CONFIG_PATH="$OPENCLAW_CONFIG_PATH" \
  QA_BUS_PORT="$QA_BUS_PORT" \
  node -e '
    const fs = require("node:fs");
    const existing = fs.existsSync(process.env.CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf8"))
      : {};
    const config = {
      ...existing,
      gateway: {
        mode: "local",
        port: 18789,
        bind: "loopback",
        auth: { mode: "token", token: "test-token" },
      },
      update: { channel: "stable" },
      plugins: {
        ...existing.plugins,
        allow: [...new Set([...(existing.plugins?.allow ?? []), "qa-channel"])],
        entries: {
          ...existing.plugins?.entries,
          "qa-channel": { enabled: true },
        },
      },
      channels: {
        "qa-channel": {
          enabled: true,
          baseUrl: `http://127.0.0.1:${process.env.QA_BUS_PORT}`,
          botUserId: "openclaw",
          botDisplayName: "OpenClaw QA",
          allowFrom: ["*"],
          pollTimeoutMs: 250,
        },
      },
    };
    fs.writeFileSync(process.env.CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  '

openclaw config validate >"$ARTIFACT_DIR/config-validate.log" 2>&1

install_update_restart_systemctl_shim
if ! openclaw_e2e_maybe_timeout 120s \
  openclaw gateway install --force --json \
  >"$SERVICE_INSTALL_JSON" 2>"$SERVICE_INSTALL_ERR"; then
  echo "historical Gateway service install failed" >&2
  openclaw_e2e_print_log "$SERVICE_INSTALL_ERR" >&2
  exit 1
fi
service_unit="$HOME/.config/systemd/user/openclaw-gateway.service"
if [ ! -f "$service_unit" ] || ! grep -q '^ExecStart=' "$service_unit"; then
  echo "historical Gateway install did not create a service unit" >&2
  exit 1
fi
if grep -q 'OPENCLAW_SKIP_PROVIDERS' "$service_unit"; then
  echo "service-owned target environment unexpectedly suppresses providers" >&2
  exit 1
fi
if ! grep -q 'OPENCLAW_SYSTEMD_UNIT=openclaw-gateway.service' "$service_unit"; then
  echo "service-owned target environment omitted its systemd marker" >&2
  exit 1
fi
cp "$service_unit" "$SERVICE_UNIT_ARTIFACT"
systemctl --user stop openclaw-gateway.service
if systemctl --user is-active openclaw-gateway.service >/dev/null 2>&1; then
  echo "setup service remained active before the update.run proof" >&2
  exit 1
fi
if [ -s "$SYSTEMCTL_SHIM_PID_FILE" ]; then
  echo "setup service PID remained recorded before the update.run proof" >&2
  exit 1
fi
cp "$SYSTEMCTL_SHIM_LOG" "$SYSTEMCTL_SHIM_SETUP_LOG"
: >"$SYSTEMCTL_SHIM_LOG"

env \
  OPENCLAW_SYSTEMD_UNIT=openclaw-gateway.service \
  openclaw gateway --port "$PORT" --bind loopback --allow-unconfigured \
  >"$GATEWAY_LOG" 2>&1 &
gateway_pid="$!"
printf '%s\n' "$gateway_pid" >"$SYSTEMCTL_SHIM_PID_FILE"
openclaw_e2e_wait_gateway_ready "$gateway_pid" "$GATEWAY_LOG" 360 "$PORT"

gateway_call() {
  local method="$1"
  local params="$2"
  local output="$3"
  local error_output="$4"
  local timeout_ms="${5:-30000}"
  openclaw gateway call "$method" \
    --url "ws://127.0.0.1:$PORT" \
    --token "test-token" \
    --timeout "$timeout_ms" \
    --json \
    --params "$params" \
    >"$output" 2>"$error_output"
}

gateway_call channels.status '{"probe":false,"timeoutMs":2000}' \
  "$ARTIFACT_DIR/channels-status-before.json" \
  "$ARTIFACT_DIR/channels-status-before.err"

update_params="$(
  RESTART_NOTE="$RESTART_NOTE" node -e '
    process.stdout.write(
      JSON.stringify({
        note: process.env.RESTART_NOTE,
        restartDelayMs: 0,
        timeoutMs: 1200000,
      }),
    );
  '
)"

source_gateway_pid="$gateway_pid"
(
  while kill -0 "$source_gateway_pid" >/dev/null 2>&1; do
    source_state="$(ps -o stat= -p "$source_gateway_pid" 2>/dev/null | tr -d '[:space:]' || true)"
    [[ "$source_state" == Z* ]] && break
    sleep 0.1
  done
  if ! grep -q 'restart mode: update process respawn (supervisor restart)' "$GATEWAY_LOG"; then
    echo "source Gateway did not select the supervised update handoff" >&2
    exit 1
  fi
  if grep -q 'restart mode: update process respawn (spawned pid' "$GATEWAY_LOG"; then
    echo "source Gateway unexpectedly detached-spawned a target" >&2
    exit 1
  fi
  echo "source Gateway exited through supervised update handoff"
  echo "starting installed service without provider suppression"
  env \
    -u OPENCLAW_SKIP_PROVIDERS \
    systemctl --user start openclaw-gateway.service
  service_pid="$(cat "$SYSTEMCTL_SHIM_PID_FILE" 2>/dev/null || true)"
  [[ "$service_pid" =~ ^[0-9]+$ ]] || exit 1
  echo "service Gateway started pid=$service_pid"
) >"$SUPERVISOR_MONITOR_LOG" 2>&1 &
supervisor_monitor_pid="$!"

echo "Invoking authenticated Gateway RPC update.run"
gateway_call update.run "$update_params" "$UPDATE_RPC_JSON" "$UPDATE_RPC_ERR" 1200000
update_rpc_completed_at_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
if ! wait "$source_gateway_pid"; then
  echo "historical Gateway did not exit cleanly for supervised update handoff" >&2
  exit 1
fi
gateway_pid=""
if ! wait "$supervisor_monitor_pid"; then
  echo "service monitor did not restart the target Gateway" >&2
  openclaw_e2e_print_log "$SUPERVISOR_MONITOR_LOG" >&2
  exit 1
fi
supervisor_monitor_pid=""
gateway_pid="$(cat "$SYSTEMCTL_SHIM_PID_FILE" 2>/dev/null || true)"
if ! [[ "$gateway_pid" =~ ^[0-9]+$ ]]; then
  echo "target service Gateway PID was not recorded" >&2
  exit 1
fi

openclaw_e2e_wait_gateway_ready "$gateway_pid" "$SYSTEMCTL_SHIM_DAEMON_LOG" 180 "$PORT"

deadline=$((SECONDS + 180))
update_status_candidate="$ARTIFACT_DIR/update-status.candidate.json"
while [ "$SECONDS" -lt "$deadline" ]; do
  if gateway_call update.status '{}' "$update_status_candidate" "$UPDATE_STATUS_ERR"; then
    if TARGET_VERSION="$target_version" RESTART_NOTE="$RESTART_NOTE" node -e '
      const fs = require("node:fs");
      const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const sentinel = payload?.sentinel;
      if (
        sentinel?.kind === "update" &&
        sentinel.status === "ok" &&
        sentinel.message === process.env.RESTART_NOTE &&
        sentinel.stats?.after?.version === process.env.TARGET_VERSION
      ) {
        process.exit(0);
      }
      process.exit(1);
    ' "$update_status_candidate"; then
      mv "$update_status_candidate" "$UPDATE_STATUS_JSON"
      break
    fi
  fi
  sleep 1
done
if [ ! -f "$UPDATE_STATUS_JSON" ]; then
  echo "timed out waiting for target Gateway update sentinel" >&2
  openclaw_e2e_print_log "$UPDATE_STATUS_ERR" >&2
  openclaw_e2e_print_log "$GATEWAY_LOG" >&2
  openclaw_e2e_print_log "$SYSTEMCTL_SHIM_DAEMON_LOG" >&2
  exit 1
fi

post_restart_observed_at_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$deadline" ]; do
  if POST_RESTART_AT_MS="$post_restart_observed_at_ms" node -e '
    const fs = require("node:fs");
    const lines = fs.existsSync(process.argv[1])
      ? fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean)
      : [];
    const count = lines
      .map((line) => JSON.parse(line))
      .filter((event) => event.path === "/v1/poll" && event.atMs >= Number(process.env.POST_RESTART_AT_MS))
      .length;
    process.exit(count > 0 ? 0 : 1);
  ' "$QA_BUS_LOG"; then
    break
  fi
  sleep 0.25
done

node scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs \
  --base-url "http://127.0.0.1:$PORT" \
  --path /healthz \
  --expect live \
  --out "$HEALTHZ_JSON"
node scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs \
  --base-url "http://127.0.0.1:$PORT" \
  --path /readyz \
  --expect ready \
  --out "$READYZ_JSON"

openclaw gateway status \
  --url "ws://127.0.0.1:$PORT" \
  --token "test-token" \
  --timeout 30000 \
  --json \
  >"$GATEWAY_STATUS_JSON" 2>"$GATEWAY_STATUS_ERR"
gateway_call channels.status '{"probe":false,"timeoutMs":2000}' \
  "$CHANNELS_STATUS_JSON" \
  "$CHANNELS_STATUS_ERR"

TARGET_PLUGIN_INDEX_OUT="$TARGET_PLUGIN_INDEX_JSON" node --input-type=module -e '
  import fs from "node:fs";
  import { readPluginInstallIndex } from "./scripts/e2e/lib/plugin-index-sqlite.mjs";
  const index = readPluginInstallIndex();
  const record = index.installRecords?.["qa-channel"];
  if (
    record?.source !== "path" ||
    record.installPath !== "/tmp/openclaw-update-run-build/dist/extensions/qa-channel"
  ) {
    throw new Error(`target SQLite index omitted qa-channel path install: ${JSON.stringify(record)}`);
  }
  fs.writeFileSync(process.env.TARGET_PLUGIN_INDEX_OUT, `${JSON.stringify(index, null, 2)}\n`);
'

installed_version="$(read_installed_version)"
SOURCE_VERSION="$SOURCE_VERSION" \
  SOURCE_SPEC="$SOURCE_SPEC" \
  TARGET_TAG="$TARGET_TAG" \
  TARGET_VERSION="$target_version" \
  INSTALLED_VERSION="$installed_version" \
  RESTART_NOTE="$RESTART_NOTE" \
  UPDATE_RPC_COMPLETED_AT_MS="$update_rpc_completed_at_ms" \
  POST_RESTART_OBSERVED_AT_MS="$post_restart_observed_at_ms" \
  UPDATE_RPC_JSON="$UPDATE_RPC_JSON" \
  UPDATE_STATUS_JSON="$UPDATE_STATUS_JSON" \
  QA_CHANNEL_INSTALL_RECORD_JSON="$QA_CHANNEL_INSTALL_RECORD_JSON" \
  TARGET_PLUGIN_INDEX_JSON="$TARGET_PLUGIN_INDEX_JSON" \
  SOURCE_PLUGIN_INSPECT_JSON="$SOURCE_PLUGIN_INSPECT_JSON" \
  SYSTEMCTL_SHIM_LOG="$SYSTEMCTL_SHIM_LOG" \
  SUPERVISOR_MONITOR_LOG="$SUPERVISOR_MONITOR_LOG" \
  SERVICE_PID="$gateway_pid" \
  HEALTHZ_JSON="$HEALTHZ_JSON" \
  READYZ_JSON="$READYZ_JSON" \
  GATEWAY_STATUS_JSON="$GATEWAY_STATUS_JSON" \
  CHANNELS_STATUS_JSON="$CHANNELS_STATUS_JSON" \
  QA_BUS_LOG="$QA_BUS_LOG" \
  SUMMARY_JSON="$SUMMARY_JSON" \
  node -e '
    const fs = require("node:fs");
    const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
    const readJsonLines = (file) =>
      fs.existsSync(file)
        ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
        : [];
    const updateStatus = readJson(process.env.UPDATE_STATUS_JSON);
    const readLines = (file) =>
      fs.existsSync(file)
        ? fs.readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
        : [];
    const postRestartAtMs = Number(process.env.POST_RESTART_OBSERVED_AT_MS);
    const qaBusPollsAfterRestart = readJsonLines(process.env.QA_BUS_LOG).filter(
      (event) => event.path === "/v1/poll" && event.atMs >= postRestartAtMs,
    ).length;
    const summary = {
      status: "passed",
      source: {
        spec: process.env.SOURCE_SPEC,
        version: process.env.SOURCE_VERSION,
      },
      target: {
        tag: process.env.TARGET_TAG,
        resolvedVersion: process.env.TARGET_VERSION,
      },
      installedVersion: process.env.INSTALLED_VERSION,
      expectedRestartNote: process.env.RESTART_NOTE,
      updateRpcCompletedAtMs: Number(process.env.UPDATE_RPC_COMPLETED_AT_MS),
      postRestartObservedAtMs: postRestartAtMs,
      updateRpcResult: readJson(process.env.UPDATE_RPC_JSON),
      restartSentinel: updateStatus.sentinel,
      qaChannelInstallRecord: readJson(process.env.QA_CHANNEL_INSTALL_RECORD_JSON),
      sourcePluginInspect: readJson(process.env.SOURCE_PLUGIN_INSPECT_JSON),
      targetPluginIndex: readJson(process.env.TARGET_PLUGIN_INDEX_JSON),
      supervisorHandoff: {
        servicePid: Number(process.env.SERVICE_PID),
        systemctlInvocations: readLines(process.env.SYSTEMCTL_SHIM_LOG),
        monitorEvents: readLines(process.env.SUPERVISOR_MONITOR_LOG),
      },
      gateway: {
        healthz: readJson(process.env.HEALTHZ_JSON),
        readyz: readJson(process.env.READYZ_JSON),
        status: readJson(process.env.GATEWAY_STATUS_JSON),
      },
      qaChannel: {
        status: readJson(process.env.CHANNELS_STATUS_JSON),
        busPollsAfterRestart: qaBusPollsAfterRestart,
      },
    };
    fs.writeFileSync(process.env.SUMMARY_JSON, `${JSON.stringify(summary, null, 2)}\n`);
  '

node scripts/e2e/lib/upgrade-survivor/assertions.mjs \
  assert-update-run-self-upgrade \
  "$SUMMARY_JSON"

echo "Gateway update.run package self-upgrade passed source=$SOURCE_VERSION target=$target_version installed=$installed_version note=$RESTART_NOTE."
