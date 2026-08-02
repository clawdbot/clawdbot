// Agent step tests cover nested session handoff, transcript bookkeeping, and
// exact command-owned cleanup after completed or timed-out nested turns.
import { afterEach, describe, expect, it, vi } from "vitest";
import { noAgentRunApprovalHost, type AgentRunApprovalHost } from "../agent-run-approval.js";
import { runAgentStep } from "./agent-step.js";
import { testing } from "./agent-step.test-support.js";

type AgentCommandRunner = typeof import("../../commands/agent.js").agentCommandFromIngress;

describe("runAgentStep", () => {
  afterEach(() => {
    testing.setDepsForTest();
    vi.clearAllMocks();
  });

  it("keeps hostless nested steps process-local with command-owned cleanup", async () => {
    // Nested steps disable automatic delivery and carry provenance so the reply
    // returns through the message tool path instead of the channel.
    const agentCommandFromIngress = vi.fn(async (_opts: Parameters<AgentCommandRunner>[0]) => ({
      payloads: [{ text: "done", mediaUrl: null }],
      meta: { durationMs: 1 },
    }));
    testing.setDepsForTest({
      agentCommandFromIngress,
    });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "hello",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
      }),
    ).resolves.toBe("done");

    const params = agentCommandFromIngress.mock.calls[0]?.[0];
    expect(params?.message).toContain("[Inter-session message");
    expect(params?.sessionKey).toBe("agent:main:subagent:child");
    expect(params?.deliver).toBe(false);
    expect(params?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(params?.lane).toBe("nested:agent:main:subagent:child");
    expect(params?.inputProvenance?.kind).toBe("inter_session");
    expect(params?.inputProvenance?.sourceTool).toBe("sessions_send");
    expect(params?.message).toContain("isUser=false");
    expect(params?.message).toContain("hello");
    expect(params?.approvalHost).toBe(noAgentRunApprovalHost);
    expect(params?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(params?.cleanupBundleMcpOnRunEnd).toBe(true);
  });

  it("keeps an injected approval host on normal nested turns", async () => {
    const approvalHost: AgentRunApprovalHost = {
      plugin: {
        request: vi.fn(),
      },
    };
    const agentCommandFromIngress = vi.fn(
      async (_opts: { approvalHost?: AgentRunApprovalHost }) => ({
        payloads: [{ text: "done", mediaUrl: null }],
        meta: { durationMs: 1 },
      }),
    );
    testing.setDepsForTest({
      agentCommandFromIngress,
    });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "continue",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 10_000,
        approvalHost,
      }),
    ).resolves.toBe("done");

    expect(agentCommandFromIngress).toHaveBeenCalledTimes(1);
    expect(agentCommandFromIngress.mock.calls[0]?.[0].approvalHost).toBe(approvalHost);
  });

  it("aborts a nested step at the caller deadline", async () => {
    let capturedSignal: AbortSignal | undefined;
    const agentCommandFromIngress = vi.fn(
      async (opts: Parameters<AgentCommandRunner>[0]) =>
        await new Promise<never>((_resolve, reject) => {
          capturedSignal = opts.abortSignal;
          const rejectAbort = () =>
            reject(
              opts.abortSignal?.reason instanceof Error
                ? opts.abortSignal.reason
                : new Error("nested step aborted"),
            );
          if (opts.abortSignal?.aborted) {
            rejectAbort();
            return;
          }
          opts.abortSignal?.addEventListener("abort", rejectAbort, { once: true });
        }),
    );
    testing.setDepsForTest({
      agentCommandFromIngress,
    });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "do not hang",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 5,
      }),
    ).resolves.toBeUndefined();

    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).toMatchObject({ name: "TimeoutError" });
    const params = agentCommandFromIngress.mock.calls[0]?.[0];
    expect(params?.cleanupBundleMcpOnRunEnd).toBe(true);
  });

  it("discards a late reply when the backend delays abort handling", async () => {
    let resolveCommand: ((value: Awaited<ReturnType<AgentCommandRunner>>) => void) | undefined;
    const agentCommandFromIngress = vi.fn(
      async (_opts: Parameters<AgentCommandRunner>[0]) =>
        await new Promise<Awaited<ReturnType<AgentCommandRunner>>>((resolve) => {
          resolveCommand = resolve;
        }),
    );
    testing.setDepsForTest({
      agentCommandFromIngress,
    });

    await expect(
      runAgentStep({
        sessionKey: "agent:main:subagent:child",
        message: "respect the deadline",
        extraSystemPrompt: "reply briefly",
        timeoutMs: 5,
      }),
    ).resolves.toBeUndefined();
    expect(agentCommandFromIngress.mock.calls[0]?.[0].cleanupBundleMcpOnRunEnd).toBe(true);

    resolveCommand?.({
      payloads: [{ text: "too late", mediaUrl: null }],
      meta: { durationMs: 1 },
    });
    await Promise.resolve();
  });

  it("forwards explicit transcript bodies for nested bookkeeping turns", async () => {
    const approvalHost: AgentRunApprovalHost = {
      plugin: {
        request: vi.fn(),
      },
    };
    const agentCommandFromIngress = vi.fn(async (_opts: Parameters<AgentCommandRunner>[0]) => ({
      payloads: [{ text: "done", mediaUrl: null }],
      meta: { durationMs: 1 },
    }));
    testing.setDepsForTest({
      agentCommandFromIngress,
    });

    await runAgentStep({
      sessionKey: "agent:main:subagent:child",
      message: "internal announce step",
      transcriptMessage: "",
      extraSystemPrompt: "announce only",
      timeoutMs: 10_000,
      approvalHost,
    });

    expect(agentCommandFromIngress).toHaveBeenCalledTimes(1);
    const ingressCalls = agentCommandFromIngress.mock.calls as unknown as Array<
      [
        {
          message?: string;
          sourceReplyDeliveryMode?: string;
          transcriptMessage?: string;
          approvalHost?: AgentRunApprovalHost;
        },
      ]
    >;
    const ingress = ingressCalls[0]?.[0];
    expect(ingress?.message).toContain("internal announce step");
    expect(ingress?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(ingress?.transcriptMessage).toBe("");
    expect(ingress?.approvalHost).toBe(approvalHost);
  });

  it("does not return failed transcript-mode output as an announce reply", async () => {
    const agentCommandFromIngress = vi.fn(async (_opts: Parameters<AgentCommandRunner>[0]) => ({
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

    const params = agentCommandFromIngress.mock.calls[0]?.[0];
    expect(params?.cleanupBundleMcpOnRunEnd).toBe(true);
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
