// Tests final media delivery through the run-reply-agent path.
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";

const runAgentTurnWithFallbackMock = vi.fn();
const resolveOutboundAttachmentFromUrlMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const scheduleFollowupDrainMock = vi.fn();

vi.mock("../../agents/context.js", () => ({
  resolveContextTokensForModel: () => 200_000,
}));

vi.mock("../../agents/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/model-selection.js")>(
    "../../agents/model-selection.js",
  );
  return {
    ...actual,
    isCliProvider: () => false,
  };
});

vi.mock("../../agents/sandbox.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../agents/sandbox.js")>("../../agents/sandbox.js");
  return {
    ...actual,
    ensureSandboxWorkspaceForSession: async () => null,
  };
});

vi.mock("../../infra/diagnostic-events.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/diagnostic-events.js")>(
    "../../infra/diagnostic-events.js",
  );
  return {
    ...actual,
    emitTrustedDiagnosticEvent: vi.fn(),
    isDiagnosticsEnabled: () => false,
  };
});

vi.mock("../../infra/diagnostics-timeline.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/diagnostics-timeline.js")>(
    "../../infra/diagnostics-timeline.js",
  );
  return {
    ...actual,
    measureDiagnosticsTimelineSpan: async (_name: string, run: () => unknown) => await run(),
  };
});

vi.mock("../../media/outbound-attachment.js", () => ({
  resolveOutboundAttachmentFromUrl: (...args: unknown[]) =>
    resolveOutboundAttachmentFromUrlMock(...args),
}));

vi.mock("./agent-runner-failure-reply.js", () => ({
  buildEmptyInteractiveReplyPayload: vi.fn(() => undefined),
  buildKnownAgentRunFailureReplyPayload: vi.fn(() => undefined),
}));

vi.mock("./agent-runner-execution.js", () => ({
  runAgentTurnWithFallback: (...args: unknown[]) => runAgentTurnWithFallbackMock(...args),
}));

vi.mock("./agent-runner-memory.js", () => ({
  runMemoryFlushIfNeeded: async ({ sessionEntry }: { sessionEntry?: unknown }) => ({
    sessionEntry,
    outcome: "skipped",
  }),
  runPreflightCompactionIfNeeded: async ({ sessionEntry }: { sessionEntry?: unknown }) =>
    sessionEntry,
}));

vi.mock("./agent-runner-utils.js", async () => {
  const actual =
    await vi.importActual<typeof import("./agent-runner-utils.js")>("./agent-runner-utils.js");
  return {
    ...actual,
    resolveQueuedReplyExecutionConfig: async (config: unknown) => config,
  };
});

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: (...args: unknown[]) => enqueueFollowupRunMock(...args),
    refreshQueuedFollowupSession: (...args: unknown[]) => refreshQueuedFollowupSessionMock(...args),
    scheduleFollowupDrain: (...args: unknown[]) => scheduleFollowupDrainMock(...args),
  };
});

vi.mock("./session-run-accounting.js", () => ({
  incrementRunCompactionCount: async () => undefined,
  persistRunSessionUsage: async () => undefined,
}));

const { runReplyAgent } = await import("./agent-runner.js");

type AgentRunLoopResult = Awaited<
  ReturnType<typeof import("./agent-runner-execution.js").runAgentTurnWithFallback>
>;

function createReplyOperation(): ReplyOperation {
  return {
    result: undefined,
    startedAtMs: Date.now(),
    lastActivityAtMs: Date.now(),
    recordActivity: vi.fn(),
    setPhase: vi.fn(),
    freezeAbort: vi.fn(),
    fail: vi.fn(),
    complete: vi.fn(),
    completeThen: vi.fn(),
  } as unknown as ReplyOperation;
}

function makeRunReplyAgentParams(
  overrides: Partial<Parameters<typeof runReplyAgent>[0]> = {},
): Parameters<typeof runReplyAgent>[0] {
  const provider = "telegram";
  const workspaceDir = "/tmp/workspace";
  const prompt = "generate chart";

  return {
    commandBody: prompt,
    followupRun: createMockFollowupRun({
      prompt,
      run: {
        agentId: "main",
        agentDir: "/tmp/agent",
        messageProvider: provider,
        workspaceDir,
      },
    }) as unknown as FollowupRun,
    queueKey: "main",
    resolvedQueue: { mode: "interrupt" } as QueueSettings,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    isStreaming: false,
    typing: createMockTypingController(),
    sessionCtx: {
      Provider: provider,
      Surface: provider,
      To: "chat-1",
      OriginatingTo: "chat-1",
      AccountId: "default",
      MessageSid: "msg-1",
    } as unknown as TemplateContext,
    defaultModel: "anthropic/claude",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
    replyOperation: createReplyOperation(),
    ...overrides,
  };
}

describe("runReplyAgent final MEDIA replies", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    runAgentTurnWithFallbackMock.mockReset();
    resolveOutboundAttachmentFromUrlMock.mockReset();
    enqueueFollowupRunMock.mockReset();
    refreshQueuedFollowupSessionMock.mockReset();
    scheduleFollowupDrainMock.mockReset();

    runAgentTurnWithFallbackMock.mockImplementation(async (params: unknown) => {
      const { buildReplyPayloads } = await vi.importActual<
        typeof import("./agent-runner-payloads.js")
      >("./agent-runner-payloads.js");
      const runnerParams = params as {
        replyMediaContext?: {
          normalizePayload?: (payload: {
            text?: string;
            mediaUrl?: string;
            mediaUrls?: string[];
          }) => Promise<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>;
        };
      };
      const normalizeMediaPaths = runnerParams.replyMediaContext?.normalizePayload;
      if (!normalizeMediaPaths) {
        throw new Error("runReplyAgent did not pass replyMediaContext to the agent turn");
      }
      const { replyPayloads } = await buildReplyPayloads({
        payloads: [{ text: "here is the chart\nMEDIA:./out/generated.png" }],
        isHeartbeat: false,
        didLogHeartbeatStrip: false,
        blockStreamingEnabled: false,
        blockReplyPipeline: null,
        replyToMode: "all",
        replyToChannel: "telegram",
        currentMessageId: "msg-1",
        messageProvider: "telegram",
        originatingChannel: "telegram",
        originatingTo: "chat-1",
        accountId: "default",
        normalizeMediaPaths,
      });
      const payload = replyPayloads[0];
      if (!payload) {
        throw new Error("expected parsed reply payload");
      }
      return {
        kind: "final",
        payload,
      } satisfies AgentRunLoopResult;
    });
    resolveOutboundAttachmentFromUrlMock.mockImplementation(async (mediaUrl: string) => ({
      path: path.join("/tmp/outbound-media", path.basename(mediaUrl)),
    }));
  });

  it("normalizes final MEDIA directives through runReplyAgent", async () => {
    const result = await runReplyAgent(makeRunReplyAgentParams());

    expect(Array.isArray(result)).toBe(false);
    if (!result || Array.isArray(result)) {
      throw new Error("expected single reply payload");
    }
    expect(result).toMatchObject({
      text: "here is the chart",
      mediaUrl: "/tmp/outbound-media/generated.png",
      mediaUrls: ["/tmp/outbound-media/generated.png"],
    });
    expect(runAgentTurnWithFallbackMock).toHaveBeenCalledOnce();
    expect(resolveOutboundAttachmentFromUrlMock).toHaveBeenCalledWith(
      path.join("/tmp/workspace", "out", "generated.png"),
      5 * 1024 * 1024,
      { mediaAccess: expect.objectContaining({ workspaceDir: "/tmp/workspace" }) },
    );
  });

  it("uses one runReplyAgent media context for block and final MEDIA replies", async () => {
    let stagedIndex = 0;
    resolveOutboundAttachmentFromUrlMock.mockImplementation(async (mediaUrl: string) => {
      stagedIndex += 1;
      return {
        path: path.join("/tmp/outbound-media", `${stagedIndex}-${path.basename(mediaUrl)}`),
      };
    });
    runAgentTurnWithFallbackMock.mockImplementationOnce(async (params: unknown) => {
      const { buildReplyPayloads } = await vi.importActual<
        typeof import("./agent-runner-payloads.js")
      >("./agent-runner-payloads.js");
      const runnerParams = params as {
        replyMediaContext?: {
          normalizePayload?: (payload: {
            text?: string;
            mediaUrl?: string;
            mediaUrls?: string[];
          }) => Promise<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>;
        };
      };
      const normalizeMediaPaths = runnerParams.replyMediaContext?.normalizePayload;
      if (!normalizeMediaPaths) {
        throw new Error("runReplyAgent did not pass replyMediaContext to the agent turn");
      }
      const commonParams = {
        isHeartbeat: false,
        didLogHeartbeatStrip: false,
        blockStreamingEnabled: false,
        blockReplyPipeline: null,
        replyToMode: "all" as const,
        replyToChannel: "telegram" as const,
        currentMessageId: "msg-1",
        messageProvider: "telegram",
        originatingChannel: "telegram" as const,
        originatingTo: "chat-1",
        accountId: "default",
        normalizeMediaPaths,
      };
      const blockPayloads = await buildReplyPayloads({
        ...commonParams,
        payloads: [{ text: "block\nMEDIA:./out/chart.png" }],
      });
      const finalPayloads = await buildReplyPayloads({
        ...commonParams,
        payloads: [{ text: "final\nMEDIA:./out/chart.png" }],
      });
      expect(blockPayloads.replyPayloads[0]).toMatchObject({
        text: "block",
        mediaUrl: "/tmp/outbound-media/1-chart.png",
      });
      const payload = finalPayloads.replyPayloads[0];
      if (!payload) {
        throw new Error("expected parsed final payload");
      }
      return {
        kind: "final",
        payload,
      } satisfies AgentRunLoopResult;
    });

    const result = await runReplyAgent(
      makeRunReplyAgentParams({
        blockStreamingEnabled: true,
        opts: { onBlockReply: vi.fn(async () => {}) },
      }),
    );

    expect(Array.isArray(result)).toBe(false);
    if (!result || Array.isArray(result)) {
      throw new Error("expected single reply payload");
    }
    expect(result).toMatchObject({
      text: "final",
      mediaUrl: "/tmp/outbound-media/1-chart.png",
      mediaUrls: ["/tmp/outbound-media/1-chart.png"],
    });
    expect(resolveOutboundAttachmentFromUrlMock).toHaveBeenCalledTimes(1);
  });
});
