// Docker E2E Observability tests cover docker e2e observability script behavior.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-docker-e2e-observability-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function successTail(scriptPath: string): string {
  const script = readFileSync(scriptPath, "utf8");
  const index = script.lastIndexOf('if [ "$status" -ne 0 ]; then');
  if (index === -1) {
    throw new Error(`missing status tail in ${scriptPath}`);
  }
  return script.slice(index);
}

function runSuccessTail(scriptPath: string) {
  const tempDir = makeTempDir();
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
  it.each(["scripts/e2e/mcp-channels-docker.sh", "scripts/e2e/cron-mcp-cleanup-docker.sh"])(
    "prints successful MCP client proof logs from %s",
    (scriptPath) => {
      const result = runSuccessTail(scriptPath);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual(["LOG:client proof log", "OK"]);
    },
  );
});
