import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  invoke: vi.fn(),
  getRuntimeConfig: vi.fn(() => ({})),
  isNodeCommandAllowed: vi.fn(),
  resolveNodeCommandAllowlist: vi.fn(() => new Set<string>()),
}));

vi.mock("./server-plugin-fallback-context.js", () => ({
  getFallbackGatewayContext: () => ({
    getRuntimeConfig: mocks.getRuntimeConfig,
    nodeRegistry: { get: mocks.get, invoke: mocks.invoke },
  }),
}));

vi.mock("./node-command-policy.js", () => ({
  isNodeCommandAllowed: mocks.isNodeCommandAllowed,
  resolveNodeCommandAllowlist: mocks.resolveNodeCommandAllowlist,
}));

import type { AiAgentEnvPlan } from "../infra/openclaw-exec-env.js";
import { invokeNodeClaudeCliRun } from "./node-agent-cli-runtime.js";

function buildAiAgentEnv(overrides: Partial<AiAgentEnvPlan> = {}): AiAgentEnvPlan {
  return {
    baseEnv: {},
    configuredEnv: {},
    overrideEnv: {},
    clearEnv: [],
    preserveEnv: [],
    forceClearBeforeOverrides: false,
    ...overrides,
  };
}

describe("invokeNodeClaudeCliRun", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.invoke.mockReset();
    mocks.getRuntimeConfig.mockClear();
    mocks.resolveNodeCommandAllowlist.mockClear();
    mocks.isNodeCommandAllowed.mockReset();
    mocks.get.mockReturnValue({
      connId: "conn-1",
      nodeId: "node-1",
      pairingGeneration: "generation-1",
      platform: "linux",
      commands: ["agent.cli.claude.run.v1"],
    });
  });

  it("fails closed when Gateway node command policy denies the agent run", async () => {
    mocks.isNodeCommandAllowed.mockReturnValue({ ok: false, reason: "denyCommands" });

    await expect(
      invokeNodeClaudeCliRun({
        nodeId: "node-1",
        argv: ["-p"],
        stdin: "hello",
        timeoutMs: 10_000,
        idleTimeoutMs: 1_000,
        onProgress: () => {},
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message:
          "paired-node Claude CLI agent runs are blocked by node command policy (denyCommands)",
      },
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("dispatches only after the command policy allows the advertised command", async () => {
    mocks.isNodeCommandAllowed.mockReturnValue({ ok: true });
    mocks.invoke.mockResolvedValue({ ok: true });

    await expect(
      invokeNodeClaudeCliRun({
        nodeId: "node-1",
        argv: ["-p"],
        stdin: "hello",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "selected-node-token" },
        clearEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
        timeoutMs: 10_000,
        idleTimeoutMs: 1_000,
        onProgress: () => {},
      }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.resolveNodeCommandAllowlist).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedConnId: "conn-1",
        expectedPairingGeneration: "generation-1",
        params: expect.objectContaining({
          env: { CLAUDE_CODE_OAUTH_TOKEN: "selected-node-token" },
          clearEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
        }),
      }),
    );
  });
  it.each([
    {
      name: "forwards a canonical wrapper on Linux",
      platform: "linux",
      aiAgentEnv: buildAiAgentEnv({ configuredEnv: { AI_AGENT: "wrapper" } }),
      expectedEnv: { AI_AGENT: "wrapper" },
      expectedClearEnv: undefined,
    },
    {
      name: "keeps the legacy payload for a v1-only node",
      platform: "windows",
      v1Only: true,
      aiAgentEnv: buildAiAgentEnv({
        configuredEnv: { ai_agent: "wrapper" },
        clearEnv: ["ai_agent"],
      }),
      expectedEnv: undefined,
      expectedClearEnv: undefined,
    },
  ])("$name", async (testCase) => {
    mocks.get.mockReturnValue({
      connId: "conn-1",
      nodeId: "node-1",
      pairingGeneration: "generation-1",
      platform: testCase.platform,
      commands: testCase.v1Only
        ? ["agent.cli.claude.run.v1"]
        : ["agent.cli.claude.run.v1", "agent.cli.claude.run.v2"],
    });
    mocks.isNodeCommandAllowed.mockReturnValue({ ok: true });
    mocks.invoke.mockResolvedValue({ ok: true });

    await invokeNodeClaudeCliRun({
      nodeId: "node-1",
      argv: ["-p"],
      stdin: "hello",
      aiAgentEnv: testCase.aiAgentEnv,
      timeoutMs: 10_000,
      idleTimeoutMs: 1_000,
      onProgress: () => {},
    });

    const invokeParams = mocks.invoke.mock.calls[0]?.[0]?.params;
    expect(invokeParams?.env).toEqual(testCase.expectedEnv);
    expect(invokeParams?.clearEnv).toEqual(testCase.expectedClearEnv);
    expect(mocks.invoke.mock.calls[0]?.[0]?.command).toBe(
      testCase.v1Only ? "agent.cli.claude.run.v1" : "agent.cli.claude.run.v2",
    );
  });

  it("forwards admitted session attribution to the envelope and legacy command params", async () => {
    mocks.isNodeCommandAllowed.mockReturnValue({ ok: true });
    mocks.invoke.mockResolvedValue({ ok: true });

    await invokeNodeClaudeCliRun({
      nodeId: "node-1",
      argv: ["-p"],
      stdin: "hello",
      sessionKey: "agent:main:claude",
      timeoutMs: 10_000,
      idleTimeoutMs: 1_000,
      onProgress: () => {},
    });

    expect(mocks.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:claude",
        params: expect.objectContaining({
          sessionKey: "agent:main:claude",
        }),
      }),
    );
  });
});
