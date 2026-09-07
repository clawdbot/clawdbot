import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { persistClawInstallRecord } from "../claws/provenance.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import * as cliTestHelpers from "./claws-cli.test-helpers.js";

const mocks = vi.hoisted(() => {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = {
    log: vi.fn((value: unknown) => logs.push(String(value))),
    error: vi.fn((value: unknown) => errors.push(String(value))),
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
    errors,
    runtime,
    loadConfig: vi.fn<() => Record<string, unknown>>(() => ({})),
    listConfiguredMcpServers: vi.fn(),
    closeReadOnlyDatabase: vi.fn(),
    stateTableGet: vi.fn(),
    openExistingOpenClawStateDatabaseReadOnly: vi.fn(),
    applyClawAddPlan: vi.fn(),
    readClawStatus: vi.fn(),
    buildClawRemovePlan: vi.fn(),
    applyClawRemovePlan: vi.fn(),
    applyClawUpdatePlan: vi.fn(),
    buildClawUpdatePlan: vi.fn(),
    exportClawAgent: vi.fn(),
    callGatewayFromCli: vi.fn(),
    sleep: vi.fn(),
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
}));

vi.mock("../config/mcp-config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/mcp-config.js")>("../config/mcp-config.js")),
  listConfiguredMcpServers: mocks.listConfiguredMcpServers,
}));

vi.mock("./gateway-rpc.js", () => ({
  callGatewayFromCli: mocks.callGatewayFromCli,
}));

vi.mock("../utils/sleep.js", () => ({
  sleep: mocks.sleep,
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

vi.mock("../claws/lifecycle-state.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/lifecycle-state.js")>(
    "../claws/lifecycle-state.js",
  )),
  readClawStatus: mocks.readClawStatus,
  buildClawRemovePlan: mocks.buildClawRemovePlan,
  applyClawRemovePlan: mocks.applyClawRemovePlan,
}));

vi.mock("../claws/export.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/export.js")>("../claws/export.js")),
  exportClawAgent: mocks.exportClawAgent,
}));

vi.mock("../claws/update-plan.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/update-plan.js")>("../claws/update-plan.js")),
  buildClawUpdatePlan: mocks.buildClawUpdatePlan,
}));

vi.mock("../claws/update-apply.js", async () => ({
  ...(await vi.importActual<typeof import("../claws/update-apply.js")>("../claws/update-apply.js")),
  applyClawUpdatePlan: mocks.applyClawUpdatePlan,
}));

const { registerClawsCli } = await import("./claws-cli.js");
const { runClawsAddCommand } = await import("./claws-cli.runtime.js");
const { ClawUpdateMutationError } = await import("../claws/update-apply.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeManifest(value: unknown = cliTestHelpers.minimalManifest): Promise<string> {
  return await cliTestHelpers.writeManifestFile(tempDirs, value);
}

async function runCli(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerClawsCli(program);
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("__exit__:"))) {
      throw error;
    }
  }
}

describe("claws cli", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    mocks.logs.length = 0;
    mocks.errors.length = 0;
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.writeJson.mockClear();
    mocks.runtime.exit.mockClear();
    mocks.loadConfig.mockReset();
    mocks.loadConfig.mockReturnValue({});
    mocks.listConfiguredMcpServers.mockReset();
    mocks.listConfiguredMcpServers.mockResolvedValue({
      ok: true,
      path: "config",
      config: {},
      mcpServers: {},
    });
    mocks.callGatewayFromCli.mockReset();
    mocks.sleep.mockReset();
    mocks.sleep.mockResolvedValue(undefined);
    mocks.preflightClawPackage.mockReset();
    mocks.preflightClawPackage.mockResolvedValue({
      ok: false,
      code: "package_install_unavailable",
      message: "Package preflight is unavailable.",
    });
    mocks.closeReadOnlyDatabase.mockReset();
    mocks.stateTableGet.mockReset();
    mocks.stateTableGet.mockReturnValue({ 1: 1 });
    mocks.openExistingOpenClawStateDatabaseReadOnly.mockReset();
    mocks.openExistingOpenClawStateDatabaseReadOnly.mockReturnValue({
      db: {
        prepare: (sql: string) => ({
          get: sql.includes("sqlite_master") ? mocks.stateTableGet : vi.fn(() => undefined),
          all: vi.fn(() => [
            { name: "bootstrap_source_path" },
            { name: "bootstrap_content_digest" },
          ]),
        }),
      },
      path: "state.sqlite",
      walMaintenance: { checkpoint: () => false, close: mocks.closeReadOnlyDatabase },
    });
    mocks.applyClawAddPlan.mockReset();
    mocks.applyClawAddPlan.mockImplementation(async (plan) => ({
      schemaVersion: "openclaw.clawAddResult.v1",
      stability: "experimental",
      dryRun: false,
      mutationAllowed: true,
      planIntegrity: plan.planIntegrity,
      status: "complete",
      claw: plan.claw,
      agent: plan.agent,
      workspaceCreated: true,
      configCommitted: true,
      installRecord: { agentId: plan.agent.finalId },
    }));
    mocks.readClawStatus.mockReset();
    mocks.readClawStatus.mockResolvedValue({
      schemaVersion: "openclaw.clawStatus.v1",
      records: [],
      summary: { claws: 0, partial: 0, missingAgents: 0, driftedFiles: 0, packageRefs: 0 },
    });
    mocks.buildClawRemovePlan.mockReset();
    mocks.buildClawRemovePlan.mockResolvedValue({
      schemaVersion: "openclaw.clawRemovePlan.v1",
      dryRun: true,
      mutationAllowed: false,
      planIntegrity: "sha256:remove-plan",
      target: "demo-agent",
      agentId: "demo-agent",
      actions: [
        {
          kind: "agent",
          id: "demo-agent",
          action: "remove",
          target: 'agents.entries["demo-agent"]',
          blocked: false,
        },
      ],
      blockers: [],
    });
    mocks.applyClawRemovePlan.mockReset();
    mocks.applyClawRemovePlan.mockResolvedValue({
      schemaVersion: "openclaw.clawRemoveResult.v1",
      dryRun: false,
      status: "complete",
      agentId: "demo-agent",
      agentRemoved: true,
      workspaceFiles: [],
      packages: [],
      mcpServers: [],
      cronJobs: [],
      packageRefsReleased: 1,
    });
    mocks.buildClawUpdatePlan.mockReset();
    mocks.buildClawUpdatePlan.mockResolvedValue({
      schemaVersion: "openclaw.clawUpdatePlan.v1",
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      planIntegrity: "sha256:update-plan",
      found: true,
      agentId: "demo-agent",
      currentClaw: { name: "@acme/demo-agent", version: "1.0.0", integrity: "sha256:old" },
      targetClaw: { name: "@acme/demo-agent", version: "1.2.3", integrity: "sha256:new" },
      summary: {
        totalActions: 1,
        added: 0,
        changed: 1,
        removed: 0,
        released: 0,
        unchanged: 0,
        manual: 0,
        blocked: 0,
        capabilityChanges: 1,
        capabilityEscalations: 1,
      },
      actions: [],
      capabilityChanges: [
        {
          kind: "agent",
          id: "demo-agent",
          path: "agent.sandbox.mode",
          action: "change",
          classification: "escalation",
          requiresDistinctConsent: true,
          reason: "Agent capability field sandbox.mode changes in the target manifest.",
          effect: { path: "sandbox.mode", current: "non-main", desired: "all" },
          current: { summary: "non-main", digest: "sha256:current" },
          desired: { summary: "all", digest: "sha256:desired" },
        },
      ],
      readiness: cliTestHelpers.pluginSetupReadiness,
      blockers: [],
      diagnostics: [],
    });
    mocks.applyClawUpdatePlan.mockReset();
    mocks.applyClawUpdatePlan.mockResolvedValue({
      schemaVersion: "openclaw.clawUpdateResult.v1",
      stability: "experimental",
      dryRun: false,
      mutationAllowed: true,
      status: "complete",
      agentId: "demo-agent",
      previousClaw: { name: "@acme/demo-agent", version: "1.0.0", integrity: "sha256:old" },
      targetClaw: { name: "@acme/demo-agent", version: "1.2.3", integrity: "sha256:new" },
      appliedActions: [],
      installRecord: { agentId: "demo-agent" },
    });
    mocks.exportClawAgent.mockReset();
    mocks.exportClawAgent.mockResolvedValue({
      schemaVersion: "openclaw.clawExportResult.v1",
      stability: "experimental",
      agentId: "demo-agent",
      outputDirectory: "/tmp/exported",
      manifest: {
        schemaVersion: 1,
        agent: { id: "demo-agent" },
        workspace: { bootstrapFiles: {}, files: [] },
        packages: [],
        mcpServers: {},
        cronJobs: [],
      },
      filesWritten: ["package.json", "openclaw.claw.json"],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
  });

  it("does not register without the process opt-in", () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
    const program = new Command();

    registerClawsCli(program);

    expect(program.commands.map((command) => command.name())).not.toContain("claws");
  });

  it("registers the experimental grouped lifecycle without prototype apply or feed commands", () => {
    const program = new Command();
    registerClawsCli(program);
    const claws = program.commands.find((command) => command.name() === "claws");

    expect(claws?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["inspect", "add", "status", "update", "remove", "export"]),
    );
  });

  it("prints versioned experimental JSON for a development manifest", async () => {
    const manifestPath = await writeManifest();

    await runCli(["claws", "inspect", manifestPath, "--json"]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawInspect.v1",
      stability: "experimental",
      valid: true,
      source: { kind: "development", version: "0.0.0-development" },
      manifest: { schemaVersion: 1, agent: { id: "demo-agent" } },
    });
  });

  it("takes identity from package.json and plans one new agent", async () => {
    const { root, workspace } = await cliTestHelpers.writePackageFixture(tempDirs);
    const expectedWorkspace = await cliTestHelpers.canonicalFuturePath(workspace);

    await runCli(["claws", "add", root, "--dry-run", "--workspace", workspace, "--json"]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawAddPlan.v1",
      stability: "experimental",
      claw: { kind: "package", name: "@acme/demo-agent", version: "1.2.3" },
      agent: { finalId: "demo-agent", workspace: expectedWorkspace },
      summary: { agentActions: 1, workspaceActions: 2, packageActions: 1, blockedActions: 1 },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("redacts credential-bearing remote MCP URLs in add previews", async () => {
    const manifestPath = await writeManifest({
      schemaVersion: 1,
      agent: { id: "demo-agent", name: "Demo Agent" },
      mcpServers: {
        remote: {
          url: "https://example.com/mcp?token=abc123&mode=ok",
          transport: "streamable-http",
        },
      },
    });
    const workspace = join(tempDirs.make("openclaw-claws-add-"), "workspace");

    await runClawsAddCommand(manifestPath, { dryRun: true, workspace }, mocks.runtime);

    const output = mocks.logs.join("\n");
    expect(output).toContain("MCP remote:");
    expect(output).toContain("example.com");
    expect(output).not.toContain("abc123");
    expect(output).toContain("token=***");
  });

  it("blocks adding into an existing agent instead of merging", async () => {
    const { root, workspace } = await cliTestHelpers.writePackageFixture(tempDirs);
    mocks.loadConfig.mockReturnValue({ agents: { entries: { "demo-agent": {} } } });

    await runCli(["claws", "add", root, "--dry-run", "--workspace", workspace, "--json"]);

    const payload = JSON.parse(mocks.logs[0] ?? "{}");
    expect(payload.blockers).toContainEqual(
      expect.objectContaining({ code: "agent_id_collision" }),
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("honors an explicit unused agent id in the plan", async () => {
    const { root, workspace } = await cliTestHelpers.writePackageFixture(tempDirs);
    mocks.loadConfig.mockReturnValue({ agents: { entries: { "demo-agent": {} } } });

    await runCli([
      "claws",
      "add",
      root,
      "--dry-run",
      "--agent-id",
      "demo-agent-two",
      "--workspace",
      workspace,
      "--json",
    ]);

    expect(JSON.parse(mocks.logs[0] ?? "{}").agent).toMatchObject({
      requestedId: "demo-agent",
      finalId: "demo-agent-two",
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("discloses capability escalations in the human dry-run", async () => {
    const root = tempDirs.make("openclaw-claws-cli-profile-");
    await mkdir(join(root, "profiles"));
    await writeFile(
      join(root, "profiles", "openclaw.yml"),
      "schemaVersion: 1\nagent:\n  tools:\n    allow: [read]\n",
      "utf8",
    );
    const path = join(root, "openclaw.claw.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        agent: { id: "demo-agent" },
        mcpServers: {
          docs: {
            command: "node",
            env: { API_TOKEN: "${GITHUB_TOKEN}" },
            toolFilter: { include: ["search_*"] },
          },
        },
      }),
      "utf8",
    );

    await runCli(["claws", "add", path, "--dry-run"]);

    expect(mocks.logs).toContain("Capability escalations (2):");
    expect(mocks.logs.some((line) => line.startsWith("  ! agent:demo-agent"))).toBe(true);
    expect(mocks.logs.some((line) => line.startsWith("  ! mcpServer:docs"))).toBe(true);
    expect(mocks.logs.some((line) => line.includes('"env":["API_TOKEN"]'))).toBe(true);
    expect(mocks.logs).toContain("The plan integrity binds every capability line above.");
  });

  it("applies a minimal Claw only after explicit consent", async () => {
    const manifestPath = await writeManifest();
    const workspace = join(tempDirs.make("openclaw-claws-add-"), "workspace");
    await runCli(["claws", "add", manifestPath, "--dry-run", "--workspace", workspace, "--json"]);
    const plan = JSON.parse(mocks.logs[0] ?? "{}");
    mocks.logs.length = 0;

    await runCli([
      "claws",
      "add",
      manifestPath,
      "--yes",
      "--plan-integrity",
      plan.planIntegrity,
      "--workspace",
      workspace,
    ]);

    expect(mocks.applyClawAddPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planIntegrity: plan.planIntegrity }),
      expect.objectContaining({ consentPlanIntegrity: plan.planIntegrity }),
    );
    expect(mocks.logs[0]).toBe(
      "Experimental: Claws contracts may change while RFC 0016 is under review.",
    );
    expect(mocks.runtime.log.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.applyClawAddPlan.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.logs).toContain("Added agent: demo-agent");
    expect(mocks.logs.some((line) => line.startsWith("Workspace: "))).toBe(true);
    mocks.callGatewayFromCli.mockResolvedValue({
      config: { agents: { entries: { "demo-agent": {} } } },
      configRevisionHash: "applied",
      appliedConfigHash: "applied",
    });
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValue(20_000);
    const [, options] = mocks.applyClawAddPlan.mock.calls[0]!;
    await expect(
      options.cronGateway.waitUntilAgentAvailable(plan.agent.finalId),
    ).resolves.toBeUndefined();
  });

  it("resumes consented add with the matching in-flight workspace on disk", async () => {
    const manifestPath = await writeManifest();
    const workspace = join(tempDirs.make("openclaw-claws-add-"), "workspace");
    const stateRoot = tempDirs.make("openclaw-claws-state-");
    vi.stubEnv("OPENCLAW_STATE_DIR", join(stateRoot, "state"));

    await runCli(["claws", "add", manifestPath, "--dry-run", "--workspace", workspace, "--json"]);
    const plan = JSON.parse(mocks.logs[0] ?? "{}");
    persistClawInstallRecord(plan, { status: "workspace_ready", nowMs: 1 });
    await mkdir(workspace);
    await writeFile(join(workspace, "leftover.txt"), "keep", "utf8");
    mocks.logs.length = 0;
    mocks.runtime.exit.mockClear();
    mocks.applyClawAddPlan.mockClear();
    mocks.loadConfig.mockReturnValue({});

    await runCli([
      "claws",
      "add",
      manifestPath,
      "--yes",
      "--plan-integrity",
      plan.planIntegrity,
      "--workspace",
      workspace,
      "--json",
    ]);

    expect(mocks.applyClawAddPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planIntegrity: plan.planIntegrity, blockers: [] }),
      expect.objectContaining({ consentPlanIntegrity: plan.planIntegrity }),
    );
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
  });

  it("resumes when config committed before the workspace-ready phase advanced", async () => {
    const manifestPath = await writeManifest();
    const workspace = join(tempDirs.make("openclaw-claws-add-"), "workspace");
    const stateRoot = tempDirs.make("openclaw-claws-state-");
    vi.stubEnv("OPENCLAW_STATE_DIR", join(stateRoot, "state"));

    await runCli(["claws", "add", manifestPath, "--dry-run", "--workspace", workspace, "--json"]);
    const plan = JSON.parse(mocks.logs[0] ?? "{}");
    persistClawInstallRecord(plan, { status: "workspace_ready", nowMs: 1 });
    await mkdir(workspace);
    mocks.logs.length = 0;
    mocks.runtime.exit.mockClear();
    mocks.applyClawAddPlan.mockClear();
    mocks.loadConfig.mockReturnValue({ agents: { list: [plan.agent.config] } });

    await runCli([
      "claws",
      "add",
      manifestPath,
      "--yes",
      "--plan-integrity",
      plan.planIntegrity,
      "--workspace",
      workspace,
      "--json",
    ]);

    expect(mocks.applyClawAddPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planIntegrity: plan.planIntegrity, blockers: [] }),
      expect.objectContaining({ consentPlanIntegrity: plan.planIntegrity }),
    );
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
  });

  it("does not claim an on-disk workspace for a partial record without workspace ownership", async () => {
    const manifestPath = await writeManifest();
    const workspace = join(tempDirs.make("openclaw-claws-add-"), "workspace");
    const stateRoot = tempDirs.make("openclaw-claws-state-");
    vi.stubEnv("OPENCLAW_STATE_DIR", join(stateRoot, "state"));

    await runCli(["claws", "add", manifestPath, "--dry-run", "--workspace", workspace, "--json"]);
    const plan = JSON.parse(mocks.logs[0] ?? "{}");
    persistClawInstallRecord(plan, { status: "partial", nowMs: 1 });
    await mkdir(workspace);
    mocks.logs.length = 0;
    mocks.runtime.exit.mockClear();
    mocks.applyClawAddPlan.mockClear();

    await runCli([
      "claws",
      "add",
      manifestPath,
      "--yes",
      "--plan-integrity",
      plan.planIntegrity,
      "--workspace",
      workspace,
      "--json",
    ]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      blockers: [expect.objectContaining({ code: "workspace_collision" })],
    });
    expect(mocks.applyClawAddPlan).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("preserves a real agent collision while an add is still pending", async () => {
    const manifestPath = await writeManifest();
    const workspace = join(tempDirs.make("openclaw-claws-add-"), "workspace");
    const stateRoot = tempDirs.make("openclaw-claws-state-");
    vi.stubEnv("OPENCLAW_STATE_DIR", join(stateRoot, "state"));

    await runCli(["claws", "add", manifestPath, "--dry-run", "--workspace", workspace, "--json"]);
    const plan = JSON.parse(mocks.logs[0] ?? "{}");
    persistClawInstallRecord(plan, { status: "pending", nowMs: 1 });
    mocks.logs.length = 0;
    mocks.runtime.exit.mockClear();
    mocks.applyClawAddPlan.mockClear();
    mocks.loadConfig.mockReturnValue({ agents: { list: [{ id: "demo-agent", workspace }] } });

    await runCli([
      "claws",
      "add",
      manifestPath,
      "--yes",
      "--plan-integrity",
      plan.planIntegrity,
      "--workspace",
      workspace,
      "--json",
    ]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      blockers: expect.arrayContaining([expect.objectContaining({ code: "agent_id_collision" })]),
    });
    expect(mocks.applyClawAddPlan).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("does not resume through another agent's configured workspace", async () => {
    const manifestPath = await writeManifest();
    const workspace = join(tempDirs.make("openclaw-claws-add-"), "workspace");
    const stateRoot = tempDirs.make("openclaw-claws-state-");
    vi.stubEnv("OPENCLAW_STATE_DIR", join(stateRoot, "state"));

    await runCli(["claws", "add", manifestPath, "--dry-run", "--workspace", workspace, "--json"]);
    const plan = JSON.parse(mocks.logs[0] ?? "{}");
    persistClawInstallRecord(plan, { status: "workspace_ready", nowMs: 1 });
    mocks.logs.length = 0;
    mocks.runtime.exit.mockClear();
    mocks.applyClawAddPlan.mockClear();
    mocks.loadConfig.mockReturnValue({ agents: { list: [{ id: "other-agent", workspace }] } });

    await runCli([
      "claws",
      "add",
      manifestPath,
      "--yes",
      "--plan-integrity",
      plan.planIntegrity,
      "--workspace",
      workspace,
      "--json",
    ]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      blockers: [expect.objectContaining({ code: "workspace_collision" })],
    });
    expect(mocks.applyClawAddPlan).not.toHaveBeenCalled();
  });

  it("requires the exact dry-run plan identity with explicit consent", async () => {
    const manifestPath = await writeManifest();

    await runCli(["claws", "add", manifestPath, "--yes", "--json"]);
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      error: { code: "plan_integrity_required" },
    });
    expect(mocks.applyClawAddPlan).not.toHaveBeenCalled();

    mocks.logs.length = 0;
    await runCli([
      "claws",
      "add",
      manifestPath,
      "--yes",
      "--plan-integrity",
      "sha256:stale",
      "--json",
    ]);
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      status: "failed",
      error: { code: "plan_integrity_mismatch" },
    });
    expect(mocks.applyClawAddPlan).not.toHaveBeenCalled();
  });

  it("fails closed when add is invoked without dry-run or consent", async () => {
    const path = await writeManifest();

    await runCli(["claws", "add", path, "--json"]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      stability: "experimental",
      ok: false,
      error: { code: "consent_required" },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("reports installed Claw status by agent id", async () => {
    mocks.readClawStatus.mockResolvedValue({
      schemaVersion: "openclaw.clawStatus.v1",
      target: "demo-agent",
      records: [
        {
          install: { agentId: "demo-agent" },
          agentState: "present",
          workspaceFiles: [],
          packages: [],
        },
      ],
      summary: { claws: 1, partial: 0, missingAgents: 0, driftedFiles: 0, packageRefs: 0 },
    });

    await runCli(["claws", "status", "demo-agent", "--json"]);

    expect(mocks.readClawStatus).toHaveBeenCalledWith("demo-agent");
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawStatus.v1",
      summary: { claws: 1 },
    });
  });

  it("prints a read-only remove plan without applying it", async () => {
    await runCli(["claws", "remove", "demo-agent", "--dry-run", "--json"]);

    expect(mocks.buildClawRemovePlan).toHaveBeenCalledWith("demo-agent", {
      monitorGateway: expect.objectContaining({
        inspect: expect.any(Function),
        quiesce: expect.any(Function),
        drain: expect.any(Function),
      }),
      referencedCleanup: { mode: "retain" },
    });
    expect(mocks.applyClawRemovePlan).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawRemovePlan.v1",
      mutationAllowed: false,
    });
  });

  it("prints a read-only grouped update plan", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);

    await runCli(["claws", "update", "demo-agent", "--from", root, "--dry-run", "--json"]);

    expect(mocks.buildClawUpdatePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "demo-agent",
        targetManifest: expect.objectContaining({
          agent: { id: "demo-agent", name: "Demo Agent" },
        }),
        targetSource: expect.objectContaining({ name: "@acme/demo-agent", version: "1.2.3" }),
        config: {},
        sourceMcpServers: {},
      }),
    );
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawUpdatePlan.v1",
      dryRun: true,
      mutationAllowed: false,
      agentId: "demo-agent",
    });
  });

  it("prints capability escalation details in human update previews", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);

    await runCli(["claws", "update", "demo-agent", "--from", root, "--dry-run"]);

    const output = mocks.logs.join("\n");
    expect(output).toContain("Capability changes: 1; escalations requiring explicit review: 1");
    expect(output).toContain("MARKET_DATA_TOKEN");
    expect(output).toContain(
      "Capability consent: the exact plan-integrity token binds every ! change disclosed below.",
    );
    expect(output).toContain("! agent.sandbox.mode: non-main -> all (change)");
    expect(output).toContain(
      'effect: {"path":"sandbox.mode","current":"non-main","desired":"all"}',
    );
  });

  it("returns failure when an update plan contains blocked actions", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
    mocks.buildClawUpdatePlan.mockResolvedValueOnce({
      schemaVersion: "openclaw.clawUpdatePlan.v1",
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      planIntegrity: "sha256:blocked-plan",
      found: true,
      agentId: "demo-agent",
      summary: {
        totalActions: 1,
        added: 0,
        changed: 0,
        removed: 0,
        released: 0,
        unchanged: 0,
        manual: 1,
        blocked: 1,
        capabilityChanges: 0,
        capabilityEscalations: 0,
      },
      capabilityChanges: [],
      readiness: { ready: true, requirements: [] },
      actions: [
        {
          kind: "workspaceFile",
          id: "SOUL.md",
          action: "manual",
          target: "workspace:SOUL.md",
          blocked: true,
          reason: "Local content changed.",
        },
      ],
      blockers: [],
      diagnostics: [],
    });

    await runCli(["claws", "update", "demo-agent", "--from", root, "--dry-run", "--json"]);

    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("uses the source recorded by the installed Claw when --from is omitted", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
    await mkdir(join(root, "profiles"));
    await writeFile(
      join(root, "profiles", "openclaw.yml"),
      "schemaVersion: 1\nagent:\n  tools:\n    profile: coding\n",
      "utf8",
    );
    mocks.readClawStatus.mockResolvedValue({
      schemaVersion: "openclaw.clawStatus.v1",
      records: [
        {
          install: {
            agentId: "demo-agent",
            claw: {
              kind: "package",
              name: "@acme/demo-agent",
              version: "1.0.0",
              packageRoot: root,
              manifestPath: join(root, "openclaw.claw.json"),
              integrity: "sha256:old",
            },
          },
          workspaceFiles: [],
          packages: [],
          mcpServers: [],
          cronJobs: [],
        },
      ],
      summary: { claws: 1 },
    });

    await runCli(["claws", "update", "demo-agent", "--dry-run", "--json"]);

    expect(mocks.readClawStatus).toHaveBeenCalledWith(
      "demo-agent",
      expect.objectContaining({ readOnly: true, sourceMcpServers: {} }),
    );
    expect(mocks.closeReadOnlyDatabase).toHaveBeenCalled();
    expect(mocks.buildClawUpdatePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "demo-agent",
        targetSource: expect.objectContaining({ name: "@acme/demo-agent", version: "1.2.3" }),
        targetOpenClawProfile: expect.objectContaining({
          agent: {
            tools: expect.objectContaining({
              profile: "full",
              allow: expect.not.arrayContaining(["bundle-mcp"]),
            }),
          },
        }),
      }),
    );
  });

  it("returns not found for a supported state database without Claws tables", async () => {
    mocks.stateTableGet.mockReturnValue(undefined);

    await runCli(["claws", "update", "demo-agent", "--dry-run", "--json"]);

    expect(mocks.readClawStatus).not.toHaveBeenCalled();
    expect(mocks.closeReadOnlyDatabase).toHaveBeenCalled();
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      diagnostics: [expect.objectContaining({ code: "claw_not_found", phase: "plan" })],
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("fails closed when update is invoked without dry-run", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);

    await runCli(["claws", "update", "demo-agent", "--from", root, "--json"]);

    expect(mocks.buildClawUpdatePlan).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawUpdatePlan.v1",
      error: { code: "consent_required" },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("requires exact plan integrity with update consent", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);

    await runCli(["claws", "update", "demo-agent", "--from", root, "--yes", "--json"]);

    expect(mocks.buildClawUpdatePlan).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      error: { code: "consent_required" },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("applies a supported update only after explicit consent", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
    const applyUpdate = mocks.applyClawUpdatePlan.getMockImplementation();
    if (!applyUpdate) {
      throw new Error("missing update fixture implementation");
    }
    mocks.applyClawUpdatePlan.mockImplementationOnce(async (...args) => {
      const options = args[2] as { runtime?: typeof mocks.runtime };
      (options.runtime ?? mocks.runtime).log("Installed plugin: demo");
      return await applyUpdate(...args);
    });

    await runCli([
      "claws",
      "update",
      "demo-agent",
      "--from",
      root,
      "--yes",
      "--plan-integrity",
      "sha256:update-plan",
      "--json",
    ]);

    expect(mocks.applyClawUpdatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "demo-agent" }),
      expect.objectContaining({
        targetManifest: expect.objectContaining({
          agent: { id: "demo-agent", name: "Demo Agent" },
        }),
      }),
      expect.objectContaining({
        config: {},
        sourceMcpServers: {},
        consentPlanIntegrity: "sha256:update-plan",
        packagePreflight: expect.any(Function),
        cronGateway: expect.objectContaining({
          add: expect.any(Function),
          get: expect.any(Function),
          remove: expect.any(Function),
        }),
      }),
    );
    expect(mocks.logs).toHaveLength(1);
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawUpdateResult.v1",
      status: "complete",
      agentId: "demo-agent",
    });
    mocks.callGatewayFromCli.mockResolvedValue({
      config: { agents: { entries: { "demo-agent": {} } } },
      configRevisionHash: "applied",
      appliedConfigHash: "applied",
    });
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValue(20_000);
    const [plan, , options] = mocks.applyClawUpdatePlan.mock.calls[0]!;
    await expect(
      options.cronGateway.waitUntilAgentAvailable(plan.agentId),
    ).resolves.toBeUndefined();
  });

  it("reports uncertain update mutations as partial JSON", async () => {
    const { root } = await cliTestHelpers.writePackageFixture(tempDirs);
    mocks.applyClawUpdatePlan.mockRejectedValueOnce(
      new ClawUpdateMutationError("update_partial", "artifact outcome requires reconciliation"),
    );

    await runCli([
      "claws",
      "update",
      "demo-agent",
      "--from",
      root,
      "--yes",
      "--plan-integrity",
      "sha256:update-plan",
      "--json",
    ]);

    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawUpdateResult.v1",
      status: "partial",
      error: { code: "update_partial" },
    });
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("applies remove only after explicit consent", async () => {
    await runCli([
      "claws",
      "remove",
      "demo-agent",
      "--yes",
      "--plan-integrity",
      "sha256:remove-plan",
      "--json",
    ]);

    expect(mocks.applyClawRemovePlan).toHaveBeenCalledWith(
      expect.objectContaining({ planIntegrity: "sha256:remove-plan" }),
      expect.objectContaining({
        consentPlanIntegrity: "sha256:remove-plan",
        referencedCleanup: { mode: "retain" },
      }),
    );
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawRemoveResult.v1",
      status: "complete",
      agentId: "demo-agent",
    });
  });

  it("requires the exact dry-run identity with remove consent", async () => {
    await runCli(["claws", "remove", "demo-agent", "--yes", "--json"]);

    expect(mocks.buildClawRemovePlan).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawRemovePlan.v1",
      error: { code: "plan_integrity_required" },
    });
  });

  it("binds selected referenced cleanup and its conflict override into the plan", async () => {
    await runCli([
      "claws",
      "remove",
      "demo-agent",
      "--dry-run",
      "--remove-referenced",
      "plugin:@acme/audit@1.0.0",
      "--force-referenced",
      "--json",
    ]);

    expect(mocks.buildClawRemovePlan).toHaveBeenCalledWith("demo-agent", {
      monitorGateway: expect.objectContaining({
        inspect: expect.any(Function),
        quiesce: expect.any(Function),
        drain: expect.any(Function),
      }),
      referencedCleanup: {
        mode: "remove-selected",
        selected: ["plugin:@acme/audit@1.0.0"],
        allowConflicts: true,
      },
    });
  });

  it("rejects ambiguous referenced cleanup modes", async () => {
    await runCli([
      "claws",
      "remove",
      "demo-agent",
      "--dry-run",
      "--remove-unused",
      "--remove-referenced",
      "plugin:@acme/audit@1.0.0",
      "--json",
    ]);

    expect(mocks.buildClawRemovePlan).not.toHaveBeenCalled();
    expect(mocks.errors).toContain(
      "Choose either --remove-unused or --remove-referenced, not both.",
    );
  });

  it("fails closed when remove has neither preview nor consent", async () => {
    await runCli(["claws", "remove", "demo-agent", "--json"]);

    expect(mocks.buildClawRemovePlan).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      error: { code: "consent_required" },
    });
  });

  it("exports one installed agent to a new package directory", async () => {
    await runCli(["claws", "export", "demo-agent", "--out", "/e", "--bootstrap", "/b", "--json"]);

    expect(mocks.exportClawAgent.mock.calls[0]?.slice(0, 2)).toEqual(["demo-agent", "/e"]);
    expect(mocks.exportClawAgent.mock.calls[0]?.[2]).toMatchObject({ bootstrapPath: "/b" });
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawExportResult.v1",
      stability: "experimental",
      agentId: "demo-agent",
    });
  });
});
