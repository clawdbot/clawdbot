// OpenClaw release ClawHub runtime-state script tests cover its CLI-only parser.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/openclaw-release-clawhub-runtime-state.ts";

function runRuntimeStateScript(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT_PATH, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("scripts/openclaw-release-clawhub-runtime-state.ts", () => {
  it("emits verifier args and proof lines for awaited ClawHub runs", () => {
    const result = runRuntimeStateScript([
      "--repository",
      "openclaw/openclaw",
      "--wait-for-clawhub",
      "true",
      "--force-skip-clawhub",
      "false",
      "--normal-run-id",
      "123",
      "--bootstrap-run-id",
      "456",
      "--bootstrap-completed",
      "true",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      verifierArgs: ["--plugin-clawhub-run", "123", "--plugin-clawhub-bootstrap-run", "456"],
      proofLines: {
        normal: "- plugin ClawHub publish: https://github.com/openclaw/openclaw/actions/runs/123",
        bootstrap:
          "- plugin ClawHub bootstrap: https://github.com/openclaw/openclaw/actions/runs/456",
      },
    });
    expect(result.stderr).toBe("");
  });

  it("rejects invalid boolean flag values before emitting runtime state", () => {
    const result = runRuntimeStateScript([
      "--repository",
      "openclaw/openclaw",
      "--wait-for-clawhub",
      "yes",
      "--force-skip-clawhub",
      "false",
      "--bootstrap-completed",
      "false",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--wait-for-clawhub must be true or false.");
    expect(result.stdout).toBe("");
  });

  it("requires the workflow repository argument", () => {
    const result = runRuntimeStateScript([
      "--wait-for-clawhub",
      "true",
      "--force-skip-clawhub",
      "false",
      "--bootstrap-completed",
      "false",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--repository is required.");
    expect(result.stdout).toBe("");
  });
});
