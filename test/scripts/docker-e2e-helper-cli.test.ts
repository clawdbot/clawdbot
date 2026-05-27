import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runHelper(script: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      GH_FORCE_TTY: "0",
      NO_COLOR: "1",
    },
  });
}

describe("Docker E2E helper CLIs", () => {
  it("prints scheduler helper help without throwing a stack trace", () => {
    const result = runHelper("scripts/docker-e2e.mjs", "--help");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("node scripts/docker-e2e.mjs github-outputs <plan.json>");
  });

  it("prints scheduler helper usage errors without a Node stack trace", () => {
    const result = runHelper("scripts/docker-e2e.mjs");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("node scripts/docker-e2e.mjs github-outputs <plan.json>");
    expect(result.stderr).not.toContain("Error:");
    expect(result.stderr).not.toContain("at file:");
  });

  it("prints timings help without treating --help as an artifact path", () => {
    const result = runHelper("scripts/docker-e2e-timings.mjs", "--help");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Usage: node scripts/docker-e2e-timings.mjs <summary.json|lane-timings.json>",
    );
  });

  it("prints rerun help without detecting the GitHub repository", () => {
    const result = runHelper("scripts/docker-e2e-rerun.mjs", "--help");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "node scripts/docker-e2e-rerun.mjs <run-id|summary.json|failures.json>",
    );
  });
});
