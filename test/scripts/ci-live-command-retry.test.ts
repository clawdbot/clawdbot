// CI live command retry tests cover transient provider failure classification.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve("scripts/ci-live-command-retry.sh");
const tempDirs: string[] = [];

function writeCommand(
  prefix: string,
  lines: string[],
): { commandPath: string; counterPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  const commandPath = path.join(dir, "command.sh");
  const counterPath = path.join(dir, "attempts.txt");
  writeFileSync(commandPath, ["#!/bin/bash", "set -euo pipefail", ...lines, ""].join("\n"));
  chmodSync(commandPath, 0o755);
  return { commandPath, counterPath };
}

function runRetryHelper(commandPath: string, counterPath: string) {
  const env = { ...process.env };
  delete env.OPENCLAW_LIVE_COMMAND_RETRY_PATTERN;
  delete env.OPENCLAW_LIVE_COMMAND_RATE_LIMIT_PATTERN;
  return spawnSync("/bin/bash", [SCRIPT_PATH], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...env,
      OPENCLAW_LIVE_COMMAND: `/bin/bash ${JSON.stringify(commandPath)}`,
      OPENCLAW_LIVE_COMMAND_ATTEMPTS: "2",
      OPENCLAW_LIVE_COMMAND_RETRY_DELAY_SECONDS: "0",
      OPENCLAW_LIVE_COMMAND_RATE_LIMIT_RETRY_DELAY_SECONDS: "0",
      OPENCLAW_RETRY_TEST_COUNTER: counterPath,
    },
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe("scripts/ci-live-command-retry.sh", () => {
  it("retries a provider-internal RPC timeout", () => {
    const { commandPath, counterPath } = writeCommand("openclaw-ci-live-rpc-timeout-", [
      'attempts="$(cat "$OPENCLAW_RETRY_TEST_COUNTER" 2>/dev/null || printf 0)"',
      'attempts="$((attempts + 1))"',
      'printf "%s" "$attempts" > "$OPENCLAW_RETRY_TEST_COUNTER"',
      'if [[ "$attempts" -eq 1 ]]; then',
      '  echo "MiniMax image generation API error (1000): rpc timeout: timeout=1m0s" >&2',
      "  exit 42",
      "fi",
    ]);

    const result = runRetryHelper(commandPath, counterPath);

    expect(result.status).toBe(0);
    expect(readFileSync(counterPath, "utf8")).toBe("2");
    expect(result.stderr).toContain(
      "Live command failed with a retryable provider/network error; retrying (1/2)",
    );
  });

  it("does not retry a MiniMax authentication failure", () => {
    const { commandPath, counterPath } = writeCommand("openclaw-ci-live-auth-failure-", [
      'attempts="$(cat "$OPENCLAW_RETRY_TEST_COUNTER" 2>/dev/null || printf 0)"',
      'attempts="$((attempts + 1))"',
      'printf "%s" "$attempts" > "$OPENCLAW_RETRY_TEST_COUNTER"',
      'echo "MiniMax image generation API error (1004): authentication failed" >&2',
      "exit 42",
    ]);

    const result = runRetryHelper(commandPath, counterPath);

    expect(result.status).toBe(42);
    expect(readFileSync(counterPath, "utf8")).toBe("1");
    expect(result.stderr).not.toContain("retrying");
  });
});
