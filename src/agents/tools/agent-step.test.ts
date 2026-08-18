// Agent step tests cover nested session handoff, transcript bookkeeping, and
// MCP runtime retirement after completed nested turns.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { runAgentStep } from "./agent-step.js";

const runWaitMocks = vi.hoisted(() => ({
  waitForAgentRunAndReadUpdatedAssistantReply: vi.fn(),
}));

const bundleMcpRuntimeMocks = vi.hoisted(() => ({
  retireSessionMcpRuntimeForSessionKey: vi.fn(async () => true),
}));

const handoffMocks = vi.hoisted(() => ({
  callSessionHandoffAgent: vi.fn(),
}));

vi.mock("../run-wait.js", () => ({
  waitForAgentRunAndReadUpdatedAssistantReply:
    runWaitMocks.waitForAgentRunAndReadUpdatedAssistantReply,
}));

vi.mock("../agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey,
}));

vi.mock("./session-handoff-agent-call.js", () => ({
  callSessionHandoffAgent: handoffMocks.callSessionHandoffAgent,
}));

const handoffContext = {
  inheritedToolPolicy: { version: 1 as const, allow: ["read"], deny: [] },
  requester: { senderId: "speaker-1" },
};

const authority = {
  agentId: "main",
  sessionKey: "agent:main:source",
};

describe("runAgentStep", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("retires bundle MCP runtime after successful nested agent steps", async () => {
    // Nested steps disable automatic delivery and carry provenance so the reply
    // returns through the message tool path instead of the channel.
    const gatewayCalls: CallGatewayOptions[] = [];
    const callGateway = async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
      gatewayCalls.push(opts);
      return { runId: "run-nested" } as T;
    };
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
        callGateway,
      }),
    ).resolves.toBe("done");

    const params = gatewayCalls[0]?.params as
      | {
          message?: string;
          sessionKey?: string;
          deliver?: boolean;
          sourceReplyDeliveryMode?: string;
          lane?: string;
          inputProvenance?: { kind?: string; sourceTool?: string };
        }
      | undefined;
    expect(params?.message).toContain("[Inter-session message");
    expect(params?.sessionKey).toBe("agent:main:subagent:child");
    expect(params?.deliver).toBe(false);
    expect(params?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(params?.lane).toBe("nested:agent:main:subagent:child");
    expect(params?.inputProvenance?.kind).toBe("inter_session");
    expect(params?.inputProvenance?.sourceTool).toBe("sessions_send");
    expect(params?.message).toContain("isUser=false");
    expect(params?.message).toContain("hello");
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).toHaveBeenCalledWith({
      sessionKey: "agent:main:subagent:child",
      reason: "nested-agent-step-complete",
    });
  });

  it("does not retire bundle MCP runtime while nested agent steps are still pending", async () => {
    const callGateway = async <T = unknown>(): Promise<T> => ({ runId: "run-pending" }) as T;
    runWaitMocks.waitForAgentRunAndReadUpdatedAssistantReply.mockResolvedValue({
      status: "timeout",
    });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
        callGateway,
      }),
    ).resolves.toBeUndefined();

    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
  });

  it("forwards explicit transcript bodies for nested bookkeeping turns", async () => {
    handoffMocks.callSessionHandoffAgent.mockResolvedValue({ runId: "run-announce" });
    runWaitMocks.waitForAgentRunAndReadUpdatedAssistantReply.mockResolvedValue({
      status: "ok",
      replyText: "done",
    });

    await runAgentStep({
      sessionKey: "agent:main:subagent:child",
      message: "internal announce step",
      transcriptMessage: "",
      extraSystemPrompt: "announce only",
      timeoutMs: 10_000,
      handoffContext,
      authority,
    });

    expect(handoffMocks.callSessionHandoffAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ transcriptMessage: "" }),
        request: expect.objectContaining({
          params: expect.objectContaining({
            message: expect.stringContaining("internal announce step"),
            sourceReplyDeliveryMode: "message_tool_only",
          }),
        }),
      }),
    );
  });

  it("rejects private transcript bodies without source handoff authority", async () => {
    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "internal announce step",
        transcriptMessage: "",
        extraSystemPrompt: "announce only",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("private transcript agent step requires session handoff authority");
  });
});
