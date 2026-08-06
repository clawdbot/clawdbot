import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const instanceHelper = path.resolve("scripts/lib/openclaw-e2e-instance.sh");
const gatewayHelper = path.resolve("scripts/e2e/lib/upgrade-survivor/gateway-start.sh");
const updateRestartHelper = path.resolve("scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh");
const refusal =
  "OpenClaw plugin migration inputs changed during startup convergence; refusing to report the gateway ready. Restart OpenClaw so state migrations run against the final config and plugin inventory.";

function quote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function runScenario(sequence: string, staleLog = "", prepare = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-gateway-"));
  const executable = path.join(root, "openclaw");
  const log = path.join(root, "gateway.log");
  const count = path.join(root, "count");
  const trace = path.join(root, "trace");
  const install = path.join(root, "install");
  const pidFile = path.join(root, "gateway.pid");
  fs.writeFileSync(log, staleLog);
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "doctor" ]; then exit 0; fi
if [ "\${1:-}" = "gateway" ] && [ "\${2:-}" = "install" ]; then
  printf 'install\n' >>"$FAKE_INSTALL"
  exit 0
fi
if [ "\${1:-}" = "gateway" ]; then shift; fi
attempt=0
[ ! -f "$FAKE_COUNT" ] || attempt="$(cat "$FAKE_COUNT")"
attempt=$((attempt + 1))
printf '%s\n' "$attempt" >"$FAKE_COUNT"
{
  printf 'pid=%s\nmarker=%s\nstate=%s\nconfig=%s\nargc=%s\n' \
    "$$" "$FAKE_MARKER" "$OPENCLAW_STATE_DIR" "$OPENCLAW_CONFIG_PATH" "$#"
  printf 'arg=%s\n' "$@"
  printf '%s\n' ---
} >>"$FAKE_TRACE"
IFS=, read -r -a steps <<<"$FAKE_SEQUENCE"
behavior="\${steps[$((attempt - 1))]:-missing}"
case "$behavior" in
  success)
    printf '[gateway] ready ws://127.0.0.1:24567\n'
    trap 'exit 0' TERM INT
    while :; do sleep 1; done
    ;;
  exact1) printf '%s\n' ${quote(refusal)}; exit 1 ;;
  exact2) printf '%s\n' ${quote(refusal)}; exit 2 ;;
  near1) printf '%s extra\n' ${quote(refusal)}; exit 1 ;;
  unrelated1) printf 'unrelated startup failure\n'; exit 1 ;;
  *) exit 64 ;;
esac
`,
    { mode: 0o755 },
  );

  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      `
set -euo pipefail
source ${quote(instanceHelper)}
source ${quote(gatewayHelper)}
openclaw_e2e_probe_http() { return 0; }
openclaw_e2e_maybe_timeout() { shift; "$@"; }
gateway_pid=""
export PATH=${quote(root)}:"$PATH"
export FAKE_COUNT=${quote(count)} FAKE_TRACE=${quote(trace)} FAKE_INSTALL=${quote(install)}
export FAKE_SEQUENCE=${quote(sequence)} FAKE_MARKER=preserved
export OPENCLAW_STATE_DIR=/state/cohort OPENCLAW_CONFIG_PATH=/config/openclaw.json
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE=${quote(pidFile)}
export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON=${quote(path.join(root, "install.json"))}
export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR=${quote(path.join(root, "install.err"))}
${
  prepare
    ? `source ${quote(updateRestartHelper)}
install_update_restart_systemctl_shim() { :; }
seed_update_restart_probe_device_auth() { :; }
write_update_restart_service_auth_env() { :; }
command=(prepare_update_restart_probe_current_install 24567 ${quote(log)})`
    : `command=(upgrade_survivor_start_gateway ${quote(log)} 8 24567 strict ${quote(executable)} --port 24567 --flag "two words")`
}
if "\${command[@]}"; then
  helper_status=0
else
  helper_status=$?
fi
printf 'gateway_pid=%s\n' "$gateway_pid"
printf 'shim_pid=%s\n' "$(cat ${quote(pidFile)} 2>/dev/null || true)"
if [ -n "$gateway_pid" ]; then
  kill "$gateway_pid" >/dev/null 2>&1 || true
  wait "$gateway_pid" >/dev/null 2>&1 || true
fi
exit "$helper_status"
`,
    ],
    { encoding: "utf8" },
  );
  const traceText = fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "";
  const logText = fs.readFileSync(log, "utf8");
  const installCount = fs.existsSync(install)
    ? fs.readFileSync(install, "utf8").trim().split("\n").length
    : 0;
  const pidText = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : "";
  fs.rmSync(root, { force: true, recursive: true });
  return { result, traceText, logText, installCount, pidText };
}

describe("upgrade survivor gateway convergence launcher", () => {
  it("retries the exact refusal once with identical launch identity and a new pid", () => {
    const { result, traceText } = runScenario("exact1,success");
    const attempts = traceText.split("---\n").filter(Boolean);

    expect(result.status, result.stderr).toBe(0);
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect(attempt).toContain("marker=preserved");
      expect(attempt).toContain("state=/state/cohort");
      expect(attempt).toContain("config=/config/openclaw.json");
      expect(attempt).toContain("argc=4");
      expect(attempt).toContain("arg=--port\narg=24567\narg=--flag\narg=two words");
    }
    expect(attempts[0]?.match(/pid=(\d+)/u)?.[1]).not.toBe(attempts[1]?.match(/pid=(\d+)/u)?.[1]);
  });

  it("returns immediately after a successful first launch", () => {
    const { result, traceText } = runScenario("success");

    expect(result.status, result.stderr).toBe(0);
    expect(traceText.split("---\n").filter(Boolean)).toHaveLength(1);
  });

  it("prepares update restart after convergence and records only the ready pid", () => {
    const { result, traceText, installCount, pidText } = runScenario("exact1,success", "", true);

    expect(result.status, result.stderr).toBe(0);
    expect(traceText.split("---\n").filter(Boolean)).toHaveLength(2);
    expect(pidText).toBe(result.stdout.match(/gateway_pid=(\d+)/u)?.[1]);
    expect(installCount).toBe(1);
  });

  it("stops update restart preparation after an unrelated startup failure", () => {
    const { result, traceText, installCount, pidText } = runScenario("unrelated1", "", true);

    expect(result.status).toBe(1);
    expect(traceText.split("---\n").filter(Boolean)).toHaveLength(1);
    expect(installCount).toBe(0);
    expect(pidText).toBe("");
  });

  it.each([
    ["near match", "near1", "", 1],
    ["unrelated status 1", "unrelated1", "", 1],
    ["exact text with status 2", "exact2", "", 1],
    ["second exact refusal", "exact1,exact1", "", 2],
    ["stale prior refusal", "unrelated1", `${refusal}\n`, 1],
  ])("does not retry %s", (_label, sequence, staleLog, expectedAttempts) => {
    const { result, traceText, logText } = runScenario(sequence, staleLog);

    expect(result.status).toBe(1);
    expect(traceText.split("---\n").filter(Boolean)).toHaveLength(expectedAttempts);
    if (staleLog) {
      expect(logText).not.toContain(refusal);
    }
  });
});
