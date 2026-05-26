import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const helperPath = path.resolve("scripts/lib/openclaw-e2e-instance.sh");

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function runHelper(payload: string) {
  return spawnSync(
    "bash",
    [
      "-lc",
      [
        "set -euo pipefail",
        `source ${shellQuote(helperPath)}`,
        `openclaw_e2e_eval_test_state_from_b64 ${shellQuote(payload)}`,
        'printf "value=%s" "${OPENCLAW_E2E_INSTANCE_TEST:-unset}"',
      ].join("; "),
    ],
    { encoding: "utf8" },
  );
}

function base64(script: string): string {
  return execFileSync("base64", { input: script, encoding: "utf8" }).replace(/\s+/gu, "");
}

describe("scripts/lib/openclaw-e2e-instance.sh", () => {
  it("sources decoded test-state scripts", () => {
    const result = runHelper(base64('export OPENCLAW_E2E_INSTANCE_TEST="ok"\n'));

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("value=ok");
  });

  it("fails when the test-state payload is not valid base64", () => {
    const result = runHelper("@@@");

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("value=");
    expect(result.stderr).toContain("Invalid OpenClaw test-state base64 payload");
  });

  it("fails when the test-state payload decodes to an empty script", () => {
    const result = runHelper(base64("\n"));

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("value=");
    expect(result.stderr).toContain("decoded to an empty script");
  });
});
