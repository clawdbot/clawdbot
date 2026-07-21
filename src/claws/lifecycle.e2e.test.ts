// E2E coverage for experimental grouped Claw inspection and add planning.
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function runOpenClaw(args: string[], options?: { expectFailure?: boolean }) {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-claws-lifecycle-e2e-"));
  const env = {
    ...process.env,
    HOME: stateDir,
    USERPROFILE: stateDir,
    OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
    OPENCLAW_EXPERIMENTAL_CLAWS: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
    OPENCLAW_TEST_RUNTIME_LOG: "1",
    VITEST: "",
  };
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/entry.ts", ...args],
      { cwd: process.cwd(), env, maxBuffer: 1024 * 1024 },
    );
    if (options?.expectFailure) {
      throw new Error(`expected command to fail: ${args.join(" ")}`);
    }
    return { ok: true as const, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (!options?.expectFailure) {
      throw error;
    }
    const failed = error as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      ok: false as const,
      code: failed.code,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  return JSON.parse(trimmed);
}

describe("claws lifecycle cli e2e", () => {
  const manifestPath = "src/claws/fixtures/incident-response.claw.json";

  it("inspects a grouped development manifest", async () => {
    const inspect = parseJson(
      (await runOpenClaw(["claws", "inspect", manifestPath, "--json"])).stdout,
    );

    expect(inspect).toMatchObject({
      schemaVersion: "openclaw.clawInspect.v1",
      stability: "experimental",
      valid: true,
      source: { kind: "development", version: "0.0.0-development" },
      manifest: {
        schemaVersion: 1,
        agent: { id: "incident-response" },
        packages: expect.any(Array),
      },
    });
  });

  it("builds a complete read-only plan with deferred package blockers", async () => {
    const result = await runOpenClaw(["claws", "add", manifestPath, "--dry-run", "--json"], {
      expectFailure: true,
    });
    const add = parseJson(result.stdout);

    expect(add).toMatchObject({
      schemaVersion: "openclaw.clawAddPlan.v1",
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      agent: { requestedId: "incident-response", finalId: "incident-response" },
      summary: {
        totalActions: 8,
        agentActions: 1,
        workspaceActions: 3,
        packageActions: 2,
        mcpServerActions: 1,
        cronJobActions: 1,
        blockedActions: 2,
      },
      blockers: [
        { code: "package_install_unavailable", phase: "plan" },
        { code: "package_install_unavailable", phase: "plan" },
      ],
    });
    expect(result.code).toBe(1);
  });

  it("fails closed when add is invoked without dry-run", async () => {
    const result = await runOpenClaw(["claws", "add", manifestPath], {
      expectFailure: true,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Claw add is dry-run only");
  });
});
