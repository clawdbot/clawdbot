import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  config: {} as { gateway?: { mode: "local" | "remote" } },
  gatewayApply: undefined as
    | ((request: { method: string; params?: { proposalId?: string } }) => Promise<unknown>)
    | undefined,
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
  isGatewayTransportError: () => false,
}));
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => mocks.config,
  resetConfigRuntimeState: () => undefined,
}));
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentIdByWorkspacePath: () => undefined,
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => mocks.workspaceDir,
}));

describe("skills workshop CLI gateway snapshot invalidation", () => {
  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skills-cli-workshop-cache-",
    });
    mocks.workspaceDir = await tempDirs.make("openclaw-skills-cli-workshop-cache-");
    delete mocks.config.gateway;
    mocks.gatewayApply = undefined;
    mocks.defaultRuntime.error.mockClear();
    mocks.defaultRuntime.exit.mockClear();
    mocks.callGateway.mockReset().mockImplementation(async (request) => {
      if (request.method === "health") {
        return {};
      }
      if (!mocks.gatewayApply) {
        throw new Error("gateway unavailable");
      }
      return await mocks.gatewayApply(request);
    });
    vi.resetModules();
  });

  afterEach(async () => {
    await testState.cleanup();
    await tempDirs.cleanup();
    vi.resetModules();
  });

  it("applies through the gateway process that owns the cached session skill index", async () => {
    // This first module graph stands in for the long-running Gateway process.
    const gatewaySnapshots = await import("../skills/runtime/session-snapshot.js");
    const gatewayRefreshState = await import("../skills/runtime/refresh-state.js");
    const gatewayWorkshop = await import("../skills/workshop/service.js");
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
      expect(request.method).toBe("skills.proposals.apply");
      return await gatewayWorkshop.applySkillProposal({
        workspaceDir: mocks.workspaceDir,
        config: mocks.config,
        proposalId: request.params?.proposalId ?? "",
      });
    };

    // A fresh module graph models the short-lived CLI process. Direct application
    // here would bump only the CLI's refresh-state map, leaving the Gateway stale.
    vi.resetModules();
    const { registerSkillsCli } = await import("./skills-cli.js");
    const program = new Command();
    program.exitOverride();
    registerSkillsCli(program);
    await program.parseAsync(["skills", "workshop", "apply", proposal.record.id], {
      from: "user",
    });

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "skills.proposals.apply",
        params: { agentId: "main", proposalId: proposal.record.id },
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
    const workshop = await import("../skills/workshop/service.js");
    const proposal = await workshop.proposeCreateSkill({
      workspaceDir: mocks.workspaceDir,
      name: "Single Dispatch",
      description: "Apply only in the process that owns snapshot state",
      content: "# Single Dispatch\n\nDo not replay this mutation.\n",
    });
    mocks.gatewayApply = async () => {
      throw new Error("gateway apply failed");
    };

    vi.resetModules();
    const { registerSkillsCli } = await import("./skills-cli.js");
    const program = new Command();
    program.exitOverride();
    registerSkillsCli(program);
    await expect(
      program.parseAsync(["skills", "workshop", "apply", proposal.record.id], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.callGateway.mock.calls.map(([request]) => request.method)).toEqual([
      "health",
      "skills.proposals.apply",
    ]);
    await expect(workshop.inspectSkillProposal(proposal.record.id)).resolves.toMatchObject({
      record: { status: "pending" },
    });
  });
});
