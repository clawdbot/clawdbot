// Agent step tests cover nested session handoff, transcript bookkeeping, and
// MCP runtime survival after completed nested turns.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { runAgentStep } from "./agent-step.js";
import { testing } from "./agent-step.test-support.js";

const recordParticipant = vi.hoisted(() => vi.fn());
vi.mock("../../sessions/session-participant-recording.js", () => ({
  recordSessionParticipantBestEffort: recordParticipant,
}));

const runWaitMocks = vi.hoisted(() => ({
  waitForAgentRunReply: vi.fn(),
}));

const bundleMcpRuntimeMocks = vi.hoisted(() => ({
  retireSessionMcpRuntimeForSessionKey: vi.fn(async () => true),
}));

vi.mock("../run-wait.js", () => ({
  waitForAgentRunReply: runWaitMocks.waitForAgentRunReply,
}));

vi.mock("../agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey,
}));

describe("runAgentStep", () => {
  afterEach(() => {
    testing.setDepsForTest();
    vi.clearAllMocks();
  });

  it("preserves bundle MCP runtime after successful nested agent steps", async () => {
    // Nested steps disable automatic delivery and carry provenance so the reply
    // returns through the message tool path instead of the channel.
    const gatewayCalls: CallGatewayOptions[] = [];
    const callGateway = async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
      gatewayCalls.push(opts);
      return { runId: "run-nested" } as T;
    };
    runWaitMocks.waitForAgentRunReply.mockResolvedValue({
      status: "ok",
      replyText: "done",
    });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        agentId: "main",
        sourceAgentId: "research",
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
    expect(recordParticipant).toHaveBeenCalledOnce();
    expect(recordParticipant).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: { type: "agent", id: "research" },
        agentId: "main",
        sessionKey: "agent:main:subagent:child",
        promptedAt: expect.any(Number),
      }),
    );
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
  });

  it("does not retire bundle MCP runtime while nested agent steps are still pending", async () => {
    const callGateway = async <T = unknown>(): Promise<T> => ({ runId: "run-pending" }) as T;
    runWaitMocks.waitForAgentRunReply.mockResolvedValue({
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
    const agentCommandFromIngress = vi.fn(async () => ({
      payloads: [{ text: "done", mediaUrl: null }],
      meta: { durationMs: 1 },
    }));
    testing.setDepsForTest({
      agentCommandFromIngress,
    });
    runWaitMocks.waitForAgentRunReply.mockResolvedValue({
      status: "ok",
      replyText: "done",
    });

    await runAgentStep({
      sessionKey: "agent:main:subagent:child",
      message: "internal announce step",
      transcriptMessage: "",
      extraSystemPrompt: "announce only",
      timeoutMs: 10_000,
    });

    expect(agentCommandFromIngress).toHaveBeenCalledTimes(1);
    const ingressCalls = agentCommandFromIngress.mock.calls as unknown as Array<
      [{ message?: string; sourceReplyDeliveryMode?: string; transcriptMessage?: string }]
    >;
    const ingress = ingressCalls[0]?.[0];
    expect(ingress?.message).toContain("internal announce step");
    expect(ingress?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(ingress?.transcriptMessage).toBe("");
  });

  it("does not return failed transcript-mode output as an announce reply", async () => {
    const agentCommandFromIngress = vi.fn(async () => ({
      payloads: [
        {
          text: "⚠️ Agent couldn't generate a response. Please try again.",
          mediaUrl: null,
          isError: true,
        },
      ],
      meta: {
        durationMs: 1,
        error: {
          kind: "incomplete_turn" as const,
          message: "Agent couldn't generate a response.",
          fallbackSafe: true,
          terminalPresentation: false,
        },
      },
    }));
    testing.setDepsForTest({
      agentCommandFromIngress,
    });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "internal announce step",
        transcriptMessage: "",
        extraSystemPrompt: "announce only",
        timeoutMs: 10_000,
      }),
    ).resolves.toBeUndefined();

    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).not.toHaveBeenCalled();
  });

  it("returns trusted terminal presentations from incomplete transcript turns", async () => {
    const presentation =
      "The read-only lookup completed successfully.\n\n⚠️ Agent couldn't generate a response. Please try again.";
    const agentCommandFromIngress = vi.fn(async () => ({
      payloads: [{ text: presentation, mediaUrl: null, isError: true }],
      meta: {
        durationMs: 1,
        error: {
          kind: "incomplete_turn" as const,
          message: "Agent couldn't generate a response.",
          fallbackSafe: true,
          terminalPresentation: true,
        },
      },
    }));
    testing.setDepsForTest({
      agentCommandFromIngress,
    });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "internal announce step",
        transcriptMessage: "",
        extraSystemPrompt: "announce only",
        timeoutMs: 10_000,
      }),
    ).resolves.toBe(presentation);
  });
});
