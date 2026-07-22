// E2E coverage for experimental grouped Claw inspection and add planning.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function runOpenClaw(
  args: string[],
  options?: { expectFailure?: boolean; stateDir?: string },
) {
  const stateDir = options?.stateDir ?? tempDirs.make("openclaw-claws-lifecycle-e2e-");
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
    return { ok: true as const, stdout: result.stdout, stderr: result.stderr, stateDir };
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
      stateDir,
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

  it("preserves implicit main and creates exactly one agent after explicit consent", async () => {
    const preview = await runOpenClaw([
      "claws",
      "add",
      "src/claws/fixtures/minimal-agent.claw.json",
      "--dry-run",
      "--json",
    ]);
    const plan = parseJson(preview.stdout) as { planIntegrity: string };
    const result = await runOpenClaw(
      [
        "claws",
        "add",
        "src/claws/fixtures/minimal-agent.claw.json",
        "--yes",
        "--plan-integrity",
        plan.planIntegrity,
        "--json",
      ],
      { stateDir: preview.stateDir },
    );

    expect(parseJson(result.stdout)).toMatchObject({
      schemaVersion: "openclaw.clawAddResult.v1",
      stability: "experimental",
      status: "complete",
      agent: { finalId: "internal-triage" },
      workspaceCreated: true,
      configCommitted: true,
      installRecord: { agentId: "internal-triage", status: "complete" },
    });
    const config = JSON.parse(await readFile(join(result.stateDir, "openclaw.json"), "utf8"));
    expect(config.agents.list).toEqual([
      { id: "main", default: true },
      expect.objectContaining({
        id: "internal-triage",
        name: "Internal Triage",
        workspace: join(result.stateDir, ".openclaw", "workspace-internal-triage"),
      }),
    ]);
  });

  it("creates declared bootstrap and supporting files in the new workspace", async () => {
    const preview = await runOpenClaw([
      "claws",
      "add",
      "src/claws/fixtures/workspace-agent.claw.json",
      "--dry-run",
      "--json",
    ]);
    const plan = parseJson(preview.stdout) as { planIntegrity: string };
    const result = await runOpenClaw(
      [
        "claws",
        "add",
        "src/claws/fixtures/workspace-agent.claw.json",
        "--yes",
        "--plan-integrity",
        plan.planIntegrity,
        "--json",
      ],
      { stateDir: preview.stateDir },
    );
    const payload = parseJson(result.stdout);
    const workspace = join(result.stateDir, ".openclaw", "workspace-workspace-agent");

    expect(payload).toMatchObject({
      schemaVersion: "openclaw.clawAddResult.v1",
      status: "complete",
      agent: { finalId: "workspace-agent", workspace },
      workspaceFiles: [
        expect.objectContaining({ path: "SOUL.md" }),
        expect.objectContaining({ path: "HEARTBEAT.md" }),
        expect.objectContaining({ path: "reference/policy.md" }),
      ],
      installRecord: { agentId: "workspace-agent", status: "complete" },
    });
    await expect(readFile(join(workspace, "SOUL.md"), "utf8")).resolves.toContain(
      "Incident Response",
    );
    await expect(readFile(join(workspace, "HEARTBEAT.md"), "utf8")).resolves.toContain(
      "Incident Heartbeat",
    );
    await expect(readFile(join(workspace, "reference", "policy.md"), "utf8")).resolves.toContain(
      "operator settings",
    );
  });

  it("blocks mutation when declared components need later lifecycle slices", async () => {
    const preview = await runOpenClaw(["claws", "add", manifestPath, "--dry-run", "--json"], {
      expectFailure: true,
    });
    const plan = parseJson(preview.stdout) as { planIntegrity: string };
    const result = await runOpenClaw(
      ["claws", "add", manifestPath, "--yes", "--plan-integrity", plan.planIntegrity, "--json"],
      {
        expectFailure: true,
        stateDir: preview.stateDir,
      },
    );

    expect(result.code).toBe(1);
    expect(parseJson(result.stdout)).toMatchObject({
      schemaVersion: "openclaw.clawAddPlan.v1",
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: "package_install_unavailable" }),
      ]),
    });
  });

  it("fails closed when add is invoked without dry-run or consent", async () => {
    const result = await runOpenClaw(["claws", "add", manifestPath], {
      expectFailure: true,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Claw add requires explicit consent");
  });
});
