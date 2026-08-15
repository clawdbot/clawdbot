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

import { invokeNodeClaudeCliRun } from "./node-agent-cli-runtime.js";

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
});
