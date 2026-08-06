// Verify Stable Main Closeout tests cover stable closeout CLI behavior.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ["scripts/verify-stable-main-closeout.mjs", ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
}

describe("verify-stable-main-closeout", () => {
  it("rejects option-shaped values before checking required arguments", () => {
    const result = runCli("--tag", "-h");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--tag requires a value.");
  });
});
