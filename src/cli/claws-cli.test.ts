// Tests for the experimental grouped Claws CLI.
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { persistClawInstallRecord } from "../claws/provenance.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";

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
    applyClawAddPlan: vi.fn(),
    readClawStatus: vi.fn(),
    buildClawRemovePlan: vi.fn(),
    applyClawRemovePlan: vi.fn(),
    exportClawAgent: vi.fn(),
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

const { registerClawsCli } = await import("./claws-cli.js");
const { runClawsAddCommand } = await import("./claws-cli.runtime.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const minimalManifest = { schemaVersion: 1, agent: { id: "demo-agent", name: "Demo Agent" } };

async function writeManifest(value: unknown = minimalManifest): Promise<string> {
  const dir = tempDirs.make("openclaw-claws-cli-");
  const path = join(dir, "openclaw.claw.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

async function writePackage(): Promise<{ root: string; workspace: string }> {
  const root = tempDirs.make("openclaw-claws-cli-package-");
  await mkdir(join(root, "workspace"));
  await writeFile(join(root, "workspace", "AGENTS.md"), "# Demo\n", "utf8");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@acme/demo-agent",
      version: "1.2.3",
      openclaw: { claw: "openclaw.claw.json" },
    }),
    "utf8",
  );
  await writeFile(
    join(root, "openclaw.claw.json"),
    JSON.stringify({
      schemaVersion: 1,
      agent: { id: "demo-agent", name: "Demo Agent" },
      workspace: {
        bootstrapFiles: { "AGENTS.md": { source: "workspace/AGENTS.md" } },
      },
      packages: [
        {
          kind: "skill",
          source: "clawhub",
          ref: "@acme/demo-skill",
          version: "1.0.0",
        },
      ],
    }),
    "utf8",
  );
  return { root, workspace: join(root, "target-workspace") };
}

async function canonicalFuturePath(target: string): Promise<string> {
  return join(await realpath(dirname(target)), basename(target));
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
          target: "agents.list[demo-agent]",
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

    expect(claws?.commands.map((command) => command.name())).toEqual([
      "inspect",
      "add",
      "status",
      "remove",
      "export",
    ]);
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
    const { root, workspace } = await writePackage();
    const expectedWorkspace = await canonicalFuturePath(workspace);

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
    const { root, workspace } = await writePackage();
    mocks.loadConfig.mockReturnValue({ agents: { entries: { "demo-agent": {} } } });

    await runCli(["claws", "add", root, "--dry-run", "--workspace", workspace, "--json"]);

    const payload = JSON.parse(mocks.logs[0] ?? "{}");
    expect(payload.blockers).toContainEqual(
      expect.objectContaining({ code: "agent_id_collision" }),
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("honors an explicit unused agent id in the plan", async () => {
    const { root, workspace } = await writePackage();
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
    const path = await writeManifest({
      schemaVersion: 1,
      agent: { id: "demo-agent", tools: { allow: ["read"] } },
      mcpServers: {
        docs: {
          command: "node",
          env: { API_TOKEN: "${GITHUB_TOKEN}" },
          toolFilter: { include: ["search_*"] },
        },
      },
    });

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
    const expectedWorkspace = await canonicalFuturePath(workspace);
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
      "--json",
    ]);

    expect(mocks.applyClawAddPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planIntegrity: plan.planIntegrity }),
      expect.objectContaining({ consentPlanIntegrity: plan.planIntegrity }),
    );
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawAddResult.v1",
      stability: "experimental",
      status: "complete",
      agent: { finalId: "demo-agent", workspace: expectedWorkspace },
    });
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
      referencedCleanup: { mode: "retain" },
    });
    expect(mocks.applyClawRemovePlan).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawRemovePlan.v1",
      mutationAllowed: false,
    });
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
    await runCli(["claws", "export", "demo-agent", "--out", "/tmp/exported", "--json"]);

    expect(mocks.exportClawAgent).toHaveBeenCalledWith("demo-agent", "/tmp/exported", {
      config: {},
      sourceMcpServers: {},
    });
    expect(JSON.parse(mocks.logs[0] ?? "{}")).toMatchObject({
      schemaVersion: "openclaw.clawExportResult.v1",
      stability: "experimental",
      agentId: "demo-agent",
    });
  });
});
