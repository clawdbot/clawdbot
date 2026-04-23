import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { runAgentStep, __testing } from "./agent-step.js";

const runWaitMocks = vi.hoisted(() => ({
  waitForAgentRunAndReadUpdatedAssistantReply: vi.fn(),
}));

const bundleMcpRuntimeMocks = vi.hoisted(() => ({
  retireSessionMcpRuntimeForSessionKey: vi.fn(async () => true),
}));

vi.mock("../run-wait.js", () => ({
  waitForAgentRunAndReadUpdatedAssistantReply:
    runWaitMocks.waitForAgentRunAndReadUpdatedAssistantReply,
}));

vi.mock("../pi-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey,
}));

describe("runAgentStep", () => {
  afterEach(() => {
    __testing.setDepsForTest();
    vi.clearAllMocks();
  });

  it("retires bundle MCP runtime after successful nested agent steps", async () => {
    const gatewayCalls: CallGatewayOptions[] = [];
    __testing.setDepsForTest({
      callGateway: async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
        gatewayCalls.push(opts);
        return { runId: "run-nested" } as T;
      },
    });
    runWaitMocks.waitForAgentRunAndReadUpdatedAssistantReply.mockResolvedValue({
      status: "ok",
      replyText: "done",
    });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
      }),
    ).resolves.toBe("done");

    expect(gatewayCalls[0]?.params).toMatchObject({
      sessionKey: "agent:main:subagent:child",
      deliver: false,
      lane: "nested:agent:main:subagent:child",
    });
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).toHaveBeenCalledWith({
      sessionKey: "agent:main:subagent:child",
      reason: "nested-agent-step-complete",
    });
  });

  it("does not retire bundle MCP runtime while nested agent steps are still pending", async () => {
    __testing.setDepsForTest({
      callGateway: async <T = unknown>(): Promise<T> => ({ runId: "run-pending" }) as T,
    });
    runWaitMocks.waitForAgentRunAndReadUpdatedAssistantReply.mockResolvedValue({
      status: "timeout",
    });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
      }),
    ).resolves.toBeUndefined();

    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
  });
});
