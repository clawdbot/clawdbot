import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
let gatewaySnapshots: typeof import("../skills/runtime/session-snapshot.js");
let gatewayRefreshState: typeof import("../skills/runtime/refresh-state.js");
let gatewayWorkshop: typeof import("../skills/workshop/service.js");
let registerSkillsCli: (typeof import("./skills-cli.js"))["registerSkillsCli"];

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  config: {} as { gateway?: { mode: "local" | "remote" } },
  gatewayApply: undefined as
    | ((request: {
        method: string;
        params?: { proposalId?: string; expectedRevisionHash?: string };
      }) => Promise<unknown>)
    | undefined,
  acquireGatewayLock: vi.fn(),
  releaseGatewayLock: vi.fn(),
  workspaceDir: "",
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  },
}));

vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.defaultRuntime }));
vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
  isGatewayCredentialsRequiredError: (error: unknown) =>
    error instanceof Error && error.name === "GatewayCredentialsRequiredError",
  isGatewayTransportError: () => false,
}));
vi.mock("../infra/gateway-lock.js", () => ({
  acquireGatewayLock: mocks.acquireGatewayLock,
}));
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => mocks.config,
  resetConfigRuntimeState: () => undefined,
}));
vi.mock("../agents/agent-scope.js", () => ({
  resolveConfiguredAgentId: (_config: unknown, agentId: string) => agentId,
  resolveAgentIdByWorkspacePath: () => undefined,
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => mocks.workspaceDir,
}));

describe("skills workshop CLI gateway snapshot invalidation", () => {
  beforeAll(async () => {
    // Keep one module graph for each process role. Reusing the graphs preserves
    // the Gateway/CLI cache boundary without rebuilding the full CLI per test.
    vi.resetModules();
    gatewaySnapshots = await import("../skills/runtime/session-snapshot.js");
    gatewayRefreshState = await import("../skills/runtime/refresh-state.js");
    gatewayWorkshop = await import("../skills/workshop/service.js");
    vi.resetModules();
    ({ registerSkillsCli } = await import("./skills-cli.js"));
  });

  afterAll(() => {
    vi.resetModules();
  });

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skills-cli-workshop-cache-",
    });
    mocks.workspaceDir = await tempDirs.make("openclaw-skills-cli-workshop-cache-");
    delete mocks.config.gateway;
    mocks.gatewayApply = undefined;
    mocks.releaseGatewayLock.mockReset();
    mocks.acquireGatewayLock.mockReset().mockResolvedValue({ release: mocks.releaseGatewayLock });
    mocks.defaultRuntime.error.mockClear();
    mocks.defaultRuntime.exit.mockClear();
    mocks.callGateway.mockReset().mockImplementation(async (request) => {
      if (!mocks.gatewayApply) {
        throw new Error("gateway unavailable");
      }
      return await mocks.gatewayApply(request);
    });
  });

  afterEach(async () => {
    await testState.cleanup();
    await tempDirs.cleanup();
  });

  it("applies through the gateway process that owns the cached session skill index", async () => {
    // This first module graph stands in for the long-running Gateway process.
    const proposal = await gatewayWorkshop.proposeCreateSkill({
      workspaceDir: mocks.workspaceDir,
      name: "Gateway Visible",
      description: "Visible in sessions without restarting the gateway",
      content: "# Gateway Visible\n\nUse the newly applied workflow.\n",
    });
    const beforeApply = gatewaySnapshots.resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: mocks.workspaceDir,
      config: mocks.config,
      watch: false,
    }).snapshot;
    expect(beforeApply.skills.map((skill) => skill.name)).not.toContain("gateway-visible");

    // Session persistence strips resolvedSkills; the Gateway rehydrates that field
    // from its process cache when the snapshot version has not advanced.
    const { resolvedSkills: _runtimeOnly, ...persistedSnapshot } = beforeApply;
    const beforeVersion = gatewayRefreshState.getSkillsSnapshotVersion(mocks.workspaceDir);
    mocks.gatewayApply = async (request) => {
      if (request.method === "skills.proposals.inspect") {
        return await gatewayWorkshop.inspectSkillProposal(proposal.record.id);
      }
      expect(request.method).toBe("skills.proposals.apply");
      return await gatewayWorkshop.applySkillProposal({
        workspaceDir: mocks.workspaceDir,
        config: mocks.config,
        proposalId: request.params?.proposalId ?? "",
        expectedRevisionHash: request.params?.expectedRevisionHash,
      });
    };

    // A fresh module graph models the short-lived CLI process. Direct application
    // here would bump only the CLI's refresh-state map, leaving the Gateway stale.
    const program = new Command();
    program.exitOverride();
    registerSkillsCli(program);
    await program.parseAsync(["skills", "workshop", "apply", proposal.record.id], {
      from: "user",
    });

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "skills.proposals.apply",
        params: {
          agentId: "main",
          proposalId: proposal.record.id,
          expectedRevisionHash: proposal.revisionHash,
        },
        timeoutMs: 1_850_000,
      }),
    );
    expect(gatewayRefreshState.getSkillsSnapshotVersion(mocks.workspaceDir)).toBeGreaterThan(
      beforeVersion,
    );
    const newSession = gatewaySnapshots.resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: mocks.workspaceDir,
      config: mocks.config,
      existingSnapshot: persistedSnapshot,
      watch: false,
    }).snapshot;
    expect(newSession.skills.map((skill) => skill.name)).toContain("gateway-visible");
  });

  it("does not replay a dispatched gateway apply failure in the CLI process", async () => {
    const proposal = await gatewayWorkshop.proposeCreateSkill({
      workspaceDir: mocks.workspaceDir,
      name: "Single Dispatch",
      description: "Apply only in the process that owns snapshot state",
      content: "# Single Dispatch\n\nDo not replay this mutation.\n",
    });
    mocks.gatewayApply = async (request) => {
      if (request.method === "skills.proposals.inspect") {
        return await gatewayWorkshop.inspectSkillProposal(proposal.record.id);
      }
      throw new Error("gateway apply failed");
    };

    const program = new Command();
    program.exitOverride();
    registerSkillsCli(program);
    await expect(
      program.parseAsync(["skills", "workshop", "apply", proposal.record.id], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.callGateway.mock.calls.map(([request]) => request.method)).toEqual([
      "skills.proposals.inspect",
      "skills.proposals.apply",
    ]);
    await expect(gatewayWorkshop.inspectSkillProposal(proposal.record.id)).resolves.toMatchObject({
      record: { status: "pending" },
    });
  });

  it("preserves configless offline apply when no local gateway is listening", async () => {
    const proposal = await gatewayWorkshop.proposeCreateSkill({
      workspaceDir: mocks.workspaceDir,
      name: "Offline Upgrade",
      description: "Keep shipped configless Workshop apply behavior",
      content: "# Offline Upgrade\n\nApply without a running gateway.\n",
    });
    const authError = Object.assign(new Error("gateway proposal inspection requires credentials"), {
      name: "GatewayCredentialsRequiredError",
      method: "skills.proposals.inspect",
      configPath: "/tmp/openclaw.json",
    });
    mocks.callGateway.mockRejectedValueOnce(authError);

    const program = new Command();
    program.exitOverride();
    registerSkillsCli(program);
    await program.parseAsync(["skills", "workshop", "apply", proposal.record.id], {
      from: "user",
    });

    expect(mocks.callGateway).toHaveBeenCalledTimes(1);
    expect(mocks.acquireGatewayLock).toHaveBeenCalledWith({
      allowInTests: true,
      port: 18789,
      role: "skill-workshop-apply",
      timeoutMs: 250,
    });
    expect(mocks.releaseGatewayLock).toHaveBeenCalledTimes(1);
    await expect(gatewayWorkshop.inspectSkillProposal(proposal.record.id)).resolves.toMatchObject({
      record: { status: "applied" },
    });
  });

  it("does not bypass Gateway ownership when CLI credentials are missing", async () => {
    const proposal = await gatewayWorkshop.proposeCreateSkill({
      workspaceDir: mocks.workspaceDir,
      name: "Gateway Owned Upgrade",
      description: "Keep snapshot invalidation in the running gateway",
      content: "# Gateway Owned Upgrade\n\nDo not apply in the CLI process.\n",
    });
    const authError = Object.assign(new Error("gateway proposal inspection requires credentials"), {
      name: "GatewayCredentialsRequiredError",
      method: "skills.proposals.inspect",
      configPath: "/tmp/openclaw.json",
    });
    mocks.callGateway.mockRejectedValueOnce(authError);
    mocks.acquireGatewayLock.mockRejectedValueOnce(new Error("gateway lock is owned"));

    const program = new Command();
    program.exitOverride();
    registerSkillsCli(program);
    await expect(
      program.parseAsync(["skills", "workshop", "apply", proposal.record.id], { from: "user" }),
    ).rejects.toMatchObject({
      name: "GatewayCredentialsRequiredError",
      message: "gateway proposal inspection requires credentials",
      method: "skills.proposals.inspect",
      configPath: "/tmp/openclaw.json",
    });

    expect(mocks.callGateway).toHaveBeenCalledTimes(1);
    expect(mocks.acquireGatewayLock).toHaveBeenCalledTimes(1);
    expect(mocks.releaseGatewayLock).not.toHaveBeenCalled();
    await expect(gatewayWorkshop.inspectSkillProposal(proposal.record.id)).resolves.toMatchObject({
      record: { status: "pending" },
    });
  });

  it("evaluates the exact inspected draft through the gateway plugin registry", async () => {
    mocks.gatewayApply = async (request) => {
      if (request.method === "skills.proposals.inspect") {
        return {
          record: {
            id: "proposal-evaluate",
            draftHash: "a".repeat(64),
          },
          revisionHash: "b".repeat(64),
          content: "# Evaluate\n",
        };
      }
      expect(request).toMatchObject({
        method: "skills.proposals.evaluate",
        params: {
          agentId: "main",
          proposalId: "proposal-evaluate",
          expectedRevisionHash: "b".repeat(64),
          correlationId: "optimizer-run-7",
        },
        timeoutMs: 650_000,
      });
      return {
        record: { id: "proposal-evaluate" },
        evaluation: {
          proposedVersion: "0.2.0",
          revisionHash: "b".repeat(64),
          outcomes: [
            {
              evaluatorId: "skill-spector",
              pluginId: "nvidia-evals",
              pluginVersion: "1.2.3",
              status: "completed",
              result: { decision: "revise", summary: "Tighten the trigger." },
            },
          ],
        },
      };
    };

    const program = new Command();
    program.exitOverride();
    registerSkillsCli(program);
    await program.parseAsync(
      [
        "skills",
        "workshop",
        "evaluate",
        "proposal-evaluate",
        "--correlation-id",
        "optimizer-run-7",
      ],
      { from: "user" },
    );

    expect(mocks.callGateway.mock.calls.map(([request]) => request.method)).toEqual([
      "skills.proposals.inspect",
      "skills.proposals.evaluate",
    ]);
    expect(mocks.defaultRuntime.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining(
        "skill-spector (nvidia-evals@1.2.3)  completed revise: Tighten the trigger.",
      ),
    );
  });
});
