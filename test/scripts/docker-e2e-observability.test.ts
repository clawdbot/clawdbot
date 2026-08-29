// Docker E2E Observability tests cover docker e2e observability script behavior.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

  it.each([0, 1, 143])("preserves Codex run diagnostics on exit %i", (status) => {
    const tempDir = tempDirs.make("openclaw-codex-run-cleanup-");
    const log = path.join(tempDir, "run.log");
    writeFileSync(log, `old log head${"x".repeat(256)}recent failure tail\n`);
    const script = readFileSync("scripts/e2e/codex-npm-plugin-live-docker.sh", "utf8");
    const cleanup = script.slice(
      script.indexOf("cleanup() {"),
      script.indexOf("trap cleanup EXIT"),
    );
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          "source scripts/lib/docker-e2e-logs.sh",
          `run_log=${JSON.stringify(log)}`,
          "OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES=64",
          cleanup,
          "trap cleanup EXIT",
          // The Docker harness exits from its signal handler before the outer failure branch.
          status === 143 ? "trap 'exit 143' TERM; kill -TERM $$" : `exit ${status}`,
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(status);
    expect(existsSync(log)).toBe(false);
    expect(result.stdout).not.toContain("old log head");
    if (status === 0) {
      expect(result.stdout).toBe("");
    } else {
      expect(result.stdout.match(/recent failure tail/g)).toHaveLength(1);
      expect(result.stdout).toContain("showing last 64");
    }
  });

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
