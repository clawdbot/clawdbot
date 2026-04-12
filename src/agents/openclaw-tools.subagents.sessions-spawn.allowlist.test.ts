import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
}));

let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

function resolveAgentConfigFromList(cfg: Record<string, unknown>, agentId: string) {
  const agents = (cfg.agents as { list?: Array<Record<string, unknown>> } | undefined)?.list;
  return agents?.find((entry) => entry.id === agentId);
}

function readSandboxMode(value: unknown) {
  return value && typeof value === "object" ? (value as { mode?: string }).mode : undefined;
}

function resolveSandboxRuntimeStatusFromConfig(params: {
  cfg?: Record<string, unknown>;
  sessionKey?: string;
}) {
  const agentId =
    typeof params.sessionKey === "string"
      ? (params.sessionKey.split(":").slice(0, 2).at(1) ?? undefined)
      : undefined;
  const cfg = params.cfg ?? {};
  const targetAgentConfig =
    typeof agentId === "string" ? resolveAgentConfigFromList(cfg, agentId) : undefined;
  const explicitMode = readSandboxMode(
    (targetAgentConfig as { sandbox?: unknown } | undefined)?.sandbox,
  );
  const defaultMode = readSandboxMode(
    (cfg.agents as { defaults?: { sandbox?: unknown } } | undefined)?.defaults?.sandbox,
  );
  const sandboxed =
    explicitMode === "all" ? true : explicitMode === "off" ? false : defaultMode === "all";
  return { sandboxed };
}

function setConfig(next: Record<string, unknown>) {
  hoisted.configOverride = createSubagentSpawnTestConfig(undefined, next);
}

async function spawn(params: {
  task?: string;
  agentId?: string;
  sandbox?: "inherit" | "require";
  requesterSessionKey?: string;
  requesterChannel?: string;
}) {
  return await spawnSubagentDirect(
    {
      task: params.task ?? "do thing",
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sandbox ? { sandbox: params.sandbox } : {}),
    },
    {
      agentSessionKey: params.requesterSessionKey ?? "main",
      agentChannel: params.requesterChannel ?? "whatsapp",
    },
  );
}

beforeAll(async () => {
  ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
    callGatewayMock: hoisted.callGatewayMock,
    loadConfig: () => hoisted.configOverride,
    resolveAgentConfig: (cfg, agentId) => resolveAgentConfigFromList(cfg, agentId),
    resolveSandboxRuntimeStatus: (params: { cfg?: Record<string, unknown>; sessionKey?: string }) =>
      resolveSandboxRuntimeStatusFromConfig(params),
    resetModules: false,
    sessionStorePath: "/tmp/subagent-spawn-allowlist-session-store.json",
  }));
});

describe("subagent spawn allowlist + sandbox guards", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    setupAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
    setConfig({});
  });

  it("only allows same-agent spawns by default", async () => {
    const result = await spawn({ agentId: "beta" });
    expect(result).toMatchObject({ status: "forbidden" });
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("forbids cross-agent spawning when not allowlisted", async () => {
    setConfig({
      agents: {
        list: [{ id: "main", subagents: { allowAgents: ["alpha"] } }],
      },
    });
    const result = await spawn({ agentId: "beta" });
    expect(result).toMatchObject({ status: "forbidden" });
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("allows cross-agent spawning when configured", async () => {
    setConfig({
      agents: {
        list: [{ id: "main", subagents: { allowAgents: ["beta"] } }],
      },
    });
    const result = await spawn({ agentId: "beta" });
    expect(result).toMatchObject({
      status: "accepted",
      runId: "run-1",
      childSessionKey: expect.stringMatching(/^agent:beta:subagent:/),
    });
  });

  it("falls back to default allowlist when agent config omits allowAgents", async () => {
    setConfig({
      agents: {
        defaults: { subagents: { allowAgents: ["beta"] } },
        list: [{ id: "main" }],
      },
    });
    const result = await spawn({ agentId: "beta" });
    expect(result).toMatchObject({
      status: "accepted",
      childSessionKey: expect.stringMatching(/^agent:beta:subagent:/),
    });
  });

  it("allows any agent when allowlist contains *", async () => {
    setConfig({
      agents: {
        list: [{ id: "main", subagents: { allowAgents: ["*"] } }],
      },
    });
    const result = await spawn({ agentId: "beta" });
    expect(result).toMatchObject({ status: "accepted" });
  });

  it("normalizes allowlisted agent ids", async () => {
    setConfig({
      agents: {
        list: [{ id: "main", subagents: { allowAgents: ["Research"] } }],
      },
    });
    const result = await spawn({ agentId: "research" });
    expect(result).toMatchObject({ status: "accepted" });
  });

  it("forbids sandboxed cross-agent spawns that would unsandbox the child", async () => {
    setConfig({
      agents: {
        defaults: { sandbox: { mode: "all" } },
        list: [
          { id: "main", subagents: { allowAgents: ["research"] } },
          { id: "research", sandbox: { mode: "off" } },
        ],
      },
    });
    const result = await spawn({ agentId: "research" });
    expect(result).toMatchObject({ status: "forbidden" });
    expect(result.error ?? "").toContain("Sandboxed sessions cannot spawn unsandboxed subagents.");
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it('forbids sandbox="require" when target runtime is unsandboxed', async () => {
    setConfig({
      agents: {
        list: [
          { id: "main", subagents: { allowAgents: ["research"] } },
          { id: "research", sandbox: { mode: "off" } },
        ],
      },
    });
    const result = await spawn({ agentId: "research", sandbox: "require" });
    expect(result).toMatchObject({ status: "forbidden" });
    expect(result.error ?? "").toContain('sandbox="require"');
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("forbids omitted agentId when requireAgentId is configured", async () => {
    setConfig({
      agents: {
        defaults: { subagents: { requireAgentId: true } },
        list: [{ id: "main" }],
      },
    });
    const result = await spawn({});
    expect(result).toMatchObject({ status: "forbidden" });
    expect(result.error ?? "").toContain("sessions_spawn requires explicit agentId");
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("allows omitted agentId when requireAgentId is false", async () => {
    setConfig({
      agents: {
        defaults: { subagents: { requireAgentId: false } },
        list: [{ id: "main" }],
      },
    });
    const result = await spawn({});
    expect(result).toMatchObject({
      status: "accepted",
      childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
    });
  });

  it("allows explicit agentId when requireAgentId is configured", async () => {
    setConfig({
      agents: {
        list: [{ id: "main", subagents: { allowAgents: ["worker"], requireAgentId: true } }],
      },
    });
    const result = await spawn({ agentId: "worker" });
    expect(result).toMatchObject({ status: "accepted" });
  });

  it("rejects malformed agentId strings before any gateway work", async () => {
    setConfig({
      agents: {
        list: [{ id: "main", subagents: { allowAgents: ["*"] } }, { id: "research" }],
      },
    });
    const result = await spawn({ agentId: "Agent not found: xyz" });
    expect(result).toMatchObject({ status: "error" });
    expect(result.error ?? "").toContain("Invalid agentId");
    expect(result.error ?? "").toContain("agents_list");
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects agentId containing path separators", async () => {
    setConfig({
      agents: {
        list: [{ id: "main", subagents: { allowAgents: ["*"] } }],
      },
    });
    const result = await spawn({ agentId: "../../../etc/passwd" });
    expect(result).toMatchObject({ status: "error" });
    expect(result.error ?? "").toContain("Invalid agentId");
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects agentId exceeding 64 characters", async () => {
    setConfig({
      agents: {
        list: [{ id: "main", subagents: { allowAgents: ["*"] } }],
      },
    });
    const result = await spawn({ agentId: "a".repeat(65) });
    expect(result).toMatchObject({ status: "error" });
    expect(result.error ?? "").toContain("Invalid agentId");
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("accepts well-formed agentId with hyphens and underscores", async () => {
    setConfig({
      agents: {
        list: [{ id: "main", subagents: { allowAgents: ["*"] } }, { id: "my-research_agent01" }],
      },
    });
    const result = await spawn({ agentId: "my-research_agent01" });
    expect(result).toMatchObject({ status: "accepted" });
  });

  it("allows allowlisted-but-unconfigured agentId", async () => {
    setConfig({
      agents: {
        list: [{ id: "main", subagents: { allowAgents: ["research"] } }],
      },
    });
    const result = await spawn({ agentId: "research" });
    expect(result).toMatchObject({ status: "accepted" });
  });
});
