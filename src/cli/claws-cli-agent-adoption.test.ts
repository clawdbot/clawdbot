import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { persistClawInstallRecord, persistClawPackageRef } from "../claws/provenance.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import * as cliTestHelpers from "./claws-cli.test-helpers.js";

const mocks = vi.hoisted(() => {
  const logs: string[] = [];
  const runtime = {
    log: vi.fn((value: unknown) => logs.push(String(value))),
    error: vi.fn(),
    writeJson: vi.fn((value: unknown, space = 2) =>
      logs.push(JSON.stringify(value, null, space > 0 ? space : undefined)),
    ),
    writeStdout: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    logs,
    runtime,
    loadConfig: vi.fn<() => Record<string, unknown>>(() => ({})),
    readConfigFileSnapshot: vi.fn(),
    listConfiguredMcpServers: vi.fn(),
    readClawStatus: vi.fn(),
    openExistingOpenClawStateDatabaseReadOnly: vi.fn(),
    applyClawAddPlan: vi.fn(),
    preflightClawPackage: vi.fn(),
  };
});

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: typeof mocks.runtime, value: unknown, space = 2) =>
    runtime.writeJson(value, space),
}));
vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  getRuntimeConfig: mocks.loadConfig,
  loadConfig: mocks.loadConfig,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));
vi.mock("../claws/lifecycle-state.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/lifecycle-state.js")>(
    "../claws/lifecycle-state.js",
  )),
  readClawStatus: mocks.readClawStatus,
}));
vi.mock("../config/mcp-config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/mcp-config.js")>("../config/mcp-config.js")),
  listConfiguredMcpServers: mocks.listConfiguredMcpServers,
}));
vi.mock("../claws/packages.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/packages.js")>("../claws/packages.js")),
  preflightClawPackage: mocks.preflightClawPackage,
}));
vi.mock("../state/openclaw-state-db.js", async () => ({
  ...(await vi.importActual<typeof import("../state/openclaw-state-db.js")>(
    "../state/openclaw-state-db.js",
  )),
  openExistingOpenClawStateDatabaseReadOnly: mocks.openExistingOpenClawStateDatabaseReadOnly,
}));
vi.mock("../claws/add.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/add.js")>("../claws/add.js")),
  applyClawAddPlan: mocks.applyClawAddPlan,
}));

const { registerClawsCli } = await import("./claws-cli.js");
const { runClawsAddCommand, runClawsStatusCommand } = await import("./claws-cli.runtime.js");
const { openExistingOpenClawStateDatabaseReadOnly } = await vi.importActual<
  typeof import("../state/openclaw-state-db.js")
>("../state/openclaw-state-db.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function runAdd(source: string, options: Parameters<typeof runClawsAddCommand>[1]) {
  try {
    await runClawsAddCommand(source, options, mocks.runtime);
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("__exit__:"))) {
      throw error;
    }
  }
}

async function prepareAdoptionResume() {
  const { root, workspace } = await cliTestHelpers.writePackageFixture(tempDirs);
  await mkdir(workspace);
  await writeFile(join(workspace, "AGENTS.md"), "# Demo\n", "utf8");
  vi.stubEnv("OPENCLAW_STATE_DIR", join(tempDirs.make("openclaw-claws-adopt-resume-"), "state"));
  mocks.loadConfig.mockReturnValue({
    agents: { entries: { "demo-agent": { name: "Demo Agent", workspace, default: true } } },
  });
  await runAdd(root, { dryRun: true, workspace, adoptExistingAgent: true, json: true });
  const plan = JSON.parse(mocks.logs[0] ?? "{}");
  const record = persistClawInstallRecord(plan, { status: "workspace_ready", nowMs: 1 });
  mocks.logs.length = 0;
  mocks.runtime.exit.mockClear();
  mocks.applyClawAddPlan.mockClear();
  return { root, workspace, plan, record };
}

describe("claws configured-agent adoption CLI", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    mocks.logs.length = 0;
    mocks.runtime.exit.mockClear();
    mocks.loadConfig.mockReset();
    mocks.readConfigFileSnapshot.mockReset();
    mocks.readConfigFileSnapshot.mockImplementation(async () => ({
      sourceConfig: mocks.loadConfig(),
    }));
    mocks.listConfiguredMcpServers.mockResolvedValue({ ok: true, mcpServers: {} });
    mocks.readClawStatus.mockReset();
    mocks.openExistingOpenClawStateDatabaseReadOnly.mockReturnValue(undefined);
    mocks.preflightClawPackage.mockResolvedValue({
      ok: true,
      action: "reuse",
      integrity: `sha256:${"a".repeat(64)}`,
    });
    mocks.applyClawAddPlan.mockReset();
    mocks.applyClawAddPlan.mockImplementation(async (plan) => ({
      schemaVersion: "openclaw.clawAddResult.v1",
      stability: "experimental",
      status: "complete",
      planIntegrity: plan.planIntegrity,
      agent: plan.agent,
    }));
  });

  it("registers the explicit adoption flag", () => {
    const program = new Command();
    registerClawsCli(program);
    const add = program.commands
      .find((command) => command.name() === "claws")
      ?.commands.find((command) => command.name() === "add");
    expect(add?.options.some((option) => option.long === "--adopt-existing-agent")).toBe(true);
  });

  it("passes the exact configured entry into adoption planning", async () => {
    const { root, workspace, plan } = await prepareAdoptionResume();
    expect(plan.agent.config).toMatchObject({ default: true, workspace });
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent", action: "adopt", blocked: false }),
        expect.objectContaining({ kind: "workspace", action: "adopt", blocked: false }),
      ]),
    );
    expect(root).toBeTruthy();
  });

  it("normalizes configured roster ids before exact adoption matching", async () => {
    const { root, workspace } = await cliTestHelpers.writePackageFixture(tempDirs);
    await mkdir(workspace);
    await writeFile(join(workspace, "AGENTS.md"), "# Demo\n", "utf8");
    mocks.loadConfig.mockReturnValue({
      agents: { entries: { "DEMO-AGENT": { name: "Demo Agent", workspace } } },
    });

    await runAdd(root, { dryRun: true, workspace, adoptExistingAgent: true, json: true });

    const plan = JSON.parse(mocks.logs[0] ?? "{}");
    expect(plan.blockers).toEqual([]);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "demo-agent", action: "adopt" }),
    );
  });

  it("retains the implicit main workspace in collision planning", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
    const workspace = tempDirs.make("openclaw-claws-implicit-main-");
    mocks.loadConfig.mockReturnValue({ agents: { defaults: { workspace } } });

    await runAdd(root, { dryRun: true, workspace, json: true });

    const plan = JSON.parse(mocks.logs[0] ?? "{}");
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "workspace_collision", path: "$.workspace" }),
    );
  });

  it("blocks a raw workspace spelling that only canonicalizes to the requested path", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
    const home = tempDirs.make("openclaw-claws-agent-raw-workspace-");
    const workspace = join(home, "existing");
    await mkdir(workspace);
    await writeFile(join(workspace, "AGENTS.md"), "# Demo\n", "utf8");
    vi.stubEnv("HOME", home);
    mocks.loadConfig.mockReturnValue({
      agents: { entries: { "demo-agent": { name: "Demo Agent", workspace } } },
    });
    mocks.readConfigFileSnapshot.mockResolvedValue({
      sourceConfig: {
        agents: { entries: { "demo-agent": { name: "Demo Agent", workspace: "~/existing" } } },
      },
    });

    await runAdd(root, {
      dryRun: true,
      workspace,
      adoptExistingAgent: true,
      json: true,
    });
    const plan = JSON.parse(mocks.logs[0] ?? "{}");
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "agent_config_conflict", path: "$.agent" }),
    );

    mocks.logs.length = 0;
    await runAdd(root, {
      yes: true,
      workspace,
      adoptExistingAgent: true,
      planIntegrity: plan.planIntegrity,
      json: true,
    });
    expect(mocks.applyClawAddPlan).not.toHaveBeenCalled();
  });

  it("renders adopted ownership in text status", async () => {
    mocks.readClawStatus.mockResolvedValue({
      summary: { claws: 1 },
      records: [
        {
          install: {
            agentId: "demo-agent",
            claw: { name: "@acme/demo", version: "1.0.0" },
            status: "complete",
          },
          agentOrigin: "adopted",
          agentState: "present",
          bootstrapState: "complete",
          workspaceFiles: [],
          packages: [],
        },
      ],
    });

    await runClawsStatusCommand(undefined, {}, mocks.runtime);

    expect(mocks.logs).toContain("demo-agent: @acme/demo@1.0.0 (complete; agent adopted)");
  });

  it("resumes exact v3 adoption only with the flag and recorded plan", async () => {
    const { root, workspace, plan, record } = await prepareAdoptionResume();
    expect(record).toMatchObject({
      agentOrigin: "adopted",
      schemaVersion: "openclaw.clawInstallRecord.v3",
    });
    await runAdd(root, {
      yes: true,
      workspace,
      adoptExistingAgent: true,
      planIntegrity: plan.planIntegrity,
      json: true,
    });
    expect(mocks.applyClawAddPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planIntegrity: plan.planIntegrity, blockers: [] }),
      expect.objectContaining({
        resumeRecord: expect.objectContaining({ agentOrigin: "adopted" }),
      }),
    );
  });

  it("reconstructs a consented plugin install when an adopted add resumes after installation", async () => {
    const { root, workspace } = await cliTestHelpers.writePackageFixture(tempDirs);
    const manifestPath = join(root, "openclaw.claw.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        packages: [
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@acme/demo-plugin",
            version: "1.0.0",
          },
        ],
      }),
      "utf8",
    );
    await mkdir(workspace);
    await writeFile(join(workspace, "AGENTS.md"), "# Demo\n", "utf8");
    vi.stubEnv("OPENCLAW_STATE_DIR", join(tempDirs.make("openclaw-claws-plugin-resume-"), "state"));
    mocks.loadConfig.mockReturnValue({
      agents: { entries: { "demo-agent": { name: "Demo Agent", workspace, default: true } } },
    });
    const integrity = `sha256:${"b".repeat(64)}`;
    mocks.preflightClawPackage.mockResolvedValue({ ok: true, action: "install", integrity });
    await runAdd(root, { dryRun: true, workspace, adoptExistingAgent: true, json: true });
    const originalPlan = JSON.parse(mocks.logs[0] ?? "{}");
    persistClawInstallRecord(originalPlan, { status: "workspace_ready", nowMs: 1 });
    persistClawPackageRef(
      originalPlan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "@acme/demo-plugin",
        version: "1.0.0",
        integrity,
      },
      { nowMs: 1, origin: "claw-introduced" },
    );
    mocks.logs.length = 0;
    mocks.runtime.exit.mockClear();
    mocks.applyClawAddPlan.mockClear();
    mocks.preflightClawPackage.mockResolvedValue({
      ok: true,
      action: "reuse",
      integrity,
      installedIntegrity: integrity,
      installedAt: new Date(1).toISOString(),
    });

    await runAdd(root, {
      yes: true,
      workspace,
      adoptExistingAgent: true,
      planIntegrity: originalPlan.planIntegrity,
      json: true,
    });

    expect(mocks.applyClawAddPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        planIntegrity: originalPlan.planIntegrity,
        actions: expect.arrayContaining([
          expect.objectContaining({
            kind: "package",
            action: "install",
            details: expect.objectContaining({ ref: "@acme/demo-plugin" }),
          }),
        ]),
      }),
      expect.objectContaining({
        resumeRecord: expect.objectContaining({ agentOrigin: "adopted" }),
      }),
    );
  });

  it("blocks resume without the flag or after full-config drift", async () => {
    const first = await prepareAdoptionResume();
    await runAdd(first.root, {
      yes: true,
      workspace: first.workspace,
      planIntegrity: first.plan.planIntegrity,
      json: true,
    });
    expect(mocks.applyClawAddPlan).not.toHaveBeenCalled();

    closeOpenClawStateDatabaseForTest();
    const second = await prepareAdoptionResume();
    mocks.loadConfig.mockReturnValue({
      agents: {
        entries: {
          "demo-agent": { name: "Locally changed", workspace: second.workspace, default: true },
        },
      },
    });
    await runAdd(second.root, {
      yes: true,
      workspace: second.workspace,
      adoptExistingAgent: true,
      planIntegrity: second.plan.planIntegrity,
      json: true,
    });
    expect(mocks.applyClawAddPlan).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "package version",
      mutate: async (root: string) => {
        const packagePath = join(root, "package.json");
        const pkg = JSON.parse(await readFile(packagePath, "utf8"));
        await writeFile(packagePath, JSON.stringify({ ...pkg, version: "1.2.4" }), "utf8");
      },
    },
    {
      name: "package integrity",
      mutate: async (root: string) => {
        const manifestPath = join(root, "openclaw.claw.json");
        await writeFile(manifestPath, `${await readFile(manifestPath, "utf8")}\n`, "utf8");
      },
    },
  ])("blocks a partial adopted resume after changed $name", async ({ mutate }) => {
    const { root, workspace } = await prepareAdoptionResume();
    closeOpenClawStateDatabaseForTest();
    mocks.openExistingOpenClawStateDatabaseReadOnly.mockImplementation(
      openExistingOpenClawStateDatabaseReadOnly,
    );
    await mutate(root);
    mocks.logs.length = 0;

    await runAdd(root, {
      dryRun: true,
      workspace,
      adoptExistingAgent: true,
      json: true,
    });
    const plan = JSON.parse(mocks.logs[0] ?? "{}");
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({ code: "claw_resume_plan_mismatch" }),
    );
    expect(mocks.applyClawAddPlan).not.toHaveBeenCalled();
  });
});
