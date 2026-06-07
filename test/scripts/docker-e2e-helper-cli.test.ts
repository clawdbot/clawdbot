// Docker E2E Helper Cli tests cover docker e2e helper cli script behavior.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

  it("rejects malformed timings limits without a Node stack trace", () => {
    const result = runHelper("scripts/docker-e2e-timings.mjs", "summary.json", "--limit=1e3");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--limit must be a positive integer");
    expect(result.stderr).not.toContain("Error:");
    expect(result.stderr).not.toContain("at file:");
  });

  it("rejects missing timings limits without a Node stack trace", () => {
    const result = runHelper("scripts/docker-e2e-timings.mjs", "summary.json", "--limit");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--limit requires a value");
    expect(result.stderr).not.toContain("Error:");
    expect(result.stderr).not.toContain("at file:");
  });

  it("prints rerun help without detecting the GitHub repository", () => {
    const result = runHelper("scripts/docker-e2e-rerun.mjs", "--help");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "node scripts/docker-e2e-rerun.mjs <run-id|summary.json|failures.json>",
    );
  });

  it.each(["summary.json", "failures.json"])(
    "prints local cleanup reruns without synthesizing Docker lane reruns from %s",
    (fileName) => {
      const root = mkdtempSync(`${tmpdir()}/openclaw-docker-e2e-rerun-`);
      try {
        const cleanupFailure = {
          lane: "cleanup-smoke",
          logFile: "cleanup-smoke.log",
          name: "cleanup-smoke",
          rerunCommand: "pnpm test:docker:cleanup",
          status: 42,
          targetable: false,
        };
        const payload =
          fileName === "summary.json"
            ? {
                failures: [cleanupFailure],
                lanes: [
                  {
                    name: "gateway-network",
                    status: 0,
                  },
                ],
                status: "failed",
              }
            : {
                lanes: [cleanupFailure],
                status: "failed",
              };
        const file = path.join(root, fileName);
        writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

        const result = runHelper("scripts/docker-e2e-rerun.mjs", file, "--ref", "abc123");

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("Failed Docker E2E entries: cleanup-smoke");
        expect(result.stdout).toContain("No targetable failed Docker E2E lanes found.");
        expect(result.stdout).toContain("- cleanup-smoke: pnpm test:docker:cleanup");
        expect(result.stdout).not.toContain("docker_lanes='cleanup-smoke'");
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );
});
