// Docker E2E Observability tests cover docker e2e observability script behavior.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function successTail(scriptPath: string): string {
  const script = readFileSync(scriptPath, "utf8");
  const index = script.lastIndexOf('if [ "$status" -ne 0 ]; then');
  if (index === -1) {
    throw new Error(`missing status tail in ${scriptPath}`);
  }
  return script.slice(index);
}

function runSuccessTail(scriptPath: string) {
  const tempDir = tempDirs.make("openclaw-docker-e2e-observability-");
  const clientLog = path.join(tempDir, "client.log");
  writeFileSync(clientLog, "client proof log\n", "utf8");
  const harness = [
    "set -euo pipefail",
    `CLIENT_LOG=${JSON.stringify(clientLog)}`,
    "status=0",
    "docker_e2e_print_log() {",
    '  printf \'LOG:%s\\n\' "$(cat "$1")"',
    "}",
    successTail(scriptPath),
  ].join("\n");

  return spawnSync("bash", ["-c", harness], { encoding: "utf8" });
}

describe("Docker E2E observability", () => {
  it("prints the bounded heartbeat log before signal cleanup", () => {
    const tempDir = tempDirs.make("openclaw-heartbeat-signal-log-");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
source scripts/lib/docker-e2e-logs.sh
run_logged_print_heartbeat signal-proof 30 bash -c 'printf "old log head%0256drecent failure tail\\n" 0; kill -TERM "$PPID"'
`,
      ],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, TMPDIR: tempDir, OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES: "64" },
      },
    );
    expect(result.status, result.stderr).toBe(143);
    expect(result.stdout).not.toContain("old log head");
    expect(result.stdout.match(/recent failure tail/g)).toHaveLength(1);
    expect(result.stdout).toContain("showing last 64");
    expect(readdirSync(tempDir)).toEqual([]);
  });

  it.each([
    [0, "", true],
    [1, "", true],
    [143, "TERM", false],
    [143, "TERM", true],
    [130, "INT", false],
    [129, "HUP", false],
  ] as const)(
    "preserves redirected Codex run diagnostics on exit %i (%s, long=%s)",
    (status, signal, long) => {
      const tempDir = tempDirs.make("openclaw-codex-run-cleanup-");
      const script = readFileSync("scripts/e2e/codex-npm-plugin-live-docker.sh", "utf8");
      const cleanupSetup = script.slice(
        script.indexOf('run_log=""'),
        script.indexOf("trap cleanup EXIT") + "trap cleanup EXIT".length,
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
set -Eeuo pipefail
# Bound the pre-fix self-copy if EXIT cleanup still writes into its input log.
ulimit -f 8
source scripts/lib/docker-e2e-package.sh
proof_status="$1"
proof_signal="$2"
proof_long="$3"
docker_e2e_docker_cmd() {
  printf '%s\\n' "$*" >>"$TMPDIR/docker-cleanup"
}
docker_e2e_docker_run_cmd() {
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --cidfile ]; then
      printf 'proof-container\\n' >"$2"
      break
    fi
    shift
  done
  cat >"$TMPDIR/container-stdin"
  if [ "$proof_long" = true ]; then
    printf 'old log head%0256d' 0
  fi
  printf 'recent failure tail\\n'
  if [ -n "$proof_signal" ]; then
    kill -"$proof_signal" "$$"
  else
    return "$proof_status"
  fi
}
${cleanupSetup}
run_log="$TMPDIR/run.log"
# Use the actual harness: its signal trap exits inside this function redirection.
if ! docker_e2e_run_with_harness image-name bash -s >"$run_log" 2>&1 <<'SH'; then
container stdin proof
SH
  exit 1
fi
`,
          "bash",
          String(status),
          signal,
          String(long),
        ],
        {
          encoding: "utf8",
          timeout: 5_000,
          killSignal: "SIGKILL",
          env: { ...process.env, TMPDIR: tempDir, OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES: "64" },
        },
      );
      expect(result.status, JSON.stringify({ stderr: result.stderr, signal: result.signal })).toBe(
        status,
      );
      expect(readFileSync(path.join(tempDir, "container-stdin"), "utf8")).toBe(
        "container stdin proof\n",
      );
      const dockerCommands = readFileSync(path.join(tempDir, "docker-cleanup"), "utf8");
      expect(dockerCommands.trimEnd().split("\n").at(-1)).toBe("rm -f proof-container");
      expect(readdirSync(tempDir).sort()).toEqual(["container-stdin", "docker-cleanup"]);
      expect(result.stdout).not.toContain("old log head");
      if (status === 0) {
        expect(result.stdout).toBe("");
      } else {
        expect(result.stdout.match(/recent failure tail/g)).toHaveLength(1);
        expect(result.stdout.includes("showing last 64")).toBe(long);
      }
    },
  );

  it("feeds the cron CLI Docker proof body through container stdin", () => {
    const script = readFileSync("scripts/e2e/cron-cli-docker.sh", "utf8");

    expect(script).toMatch(
      /docker_e2e_run_with_harness[\s\S]*\n {2}-i \\\n {2}"\$IMAGE_NAME" \\\n {2}bash -s >"\$CLIENT_LOG" 2>&1 <<'INNER'/u,
    );
  });

  it.each([
    "scripts/e2e/mcp-channels-docker.sh",
    "scripts/e2e/cron-cli-docker.sh",
    "scripts/e2e/cron-mcp-cleanup-docker.sh",
  ])("prints successful MCP client proof logs from %s", (scriptPath) => {
    const result = runSuccessTail(scriptPath);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["LOG:client proof log", "OK"]);
  });
});
