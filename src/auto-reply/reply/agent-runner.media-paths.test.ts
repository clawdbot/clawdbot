import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedPiQueueMessageOutcome } from "../../agents/pi-embedded-runner/runs.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const abortEmbeddedPiRunMock = vi.fn();
const compactEmbeddedPiSessionMock = vi.fn();
const isEmbeddedPiRunActiveMock = vi.fn(() => false);
const isEmbeddedPiRunStreamingMock = vi.fn(() => false);
const queueEmbeddedPiMessageWithOutcomeMock = vi.fn(
  (sessionId: string, _text: string, _options?: unknown): EmbeddedPiQueueMessageOutcome => ({
    queued: false,
    sessionId,
    reason: "not_streaming",
    gatewayHealth: "live",
  }),
);
const resolveEmbeddedSessionLaneMock = vi.fn();
const waitForEmbeddedPiRunEndMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();
const scheduleFollowupDrainMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const resolveOutboundAttachmentFromUrlMock = vi.fn();
const createReplyMediaContextRuntimeMock = vi.fn();

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => runWithModelFallbackMock(params),
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: abortEmbeddedPiRunMock,
  compactEmbeddedPiSession: compactEmbeddedPiSessionMock,
  isEmbeddedPiRunActive: isEmbeddedPiRunActiveMock,
  isEmbeddedPiRunStreaming: isEmbeddedPiRunStreamingMock,
  queueEmbeddedPiMessageWithOutcome: queueEmbeddedPiMessageWithOutcomeMock,
  resolveEmbeddedSessionLane: resolveEmbeddedSessionLaneMock,
  runEmbeddedPiAgent: runEmbeddedPiAgentMock,
  waitForEmbeddedPiRunEnd: waitForEmbeddedPiRunEndMock,
}));

vi.mock("../../agents/pi-embedded-runner/runs.js", () => ({
  formatEmbeddedPiQueueFailureSummary: (outcome: { reason?: string; sessionId?: string }) =>
    outcome.reason && outcome.sessionId
      ? `queue_message_failed reason=${outcome.reason} sessionId=${outcome.sessionId} gatewayHealth=live`
      : undefined,
  queueEmbeddedPiMessageWithOutcome: queueEmbeddedPiMessageWithOutcomeMock,
}));

vi.mock("./queue.js", () => ({
  enqueueFollowupRun: enqueueFollowupRunMock,
  refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock,
  resolvePiSteeringModeForQueueMode: (mode: string) => (mode === "queue" ? "one-at-a-time" : "all"),
  scheduleFollowupDrain: scheduleFollowupDrainMock,
}));

vi.mock("../../media/outbound-attachment.js", () => ({
  resolveOutboundAttachmentFromUrl: (...args: unknown[]) =>
    resolveOutboundAttachmentFromUrlMock(...args),
}));

// Spy on the .runtime import path used by agent-runner-execution.ts so we can assert
// that the fix prevents a second media context from being created inside runAgentTurnWithFallback.
vi.mock("./reply-media-paths.runtime.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./reply-media-paths.runtime.js")>();
  return {
    createReplyMediaContext: (...args: Parameters<typeof mod.createReplyMediaContext>) => {
      createReplyMediaContextRuntimeMock(...args);
      return mod.createReplyMediaContext(...args);
    },
    createReplyMediaPathNormalizer: mod.createReplyMediaPathNormalizer,
  };
});

let runReplyAgent: typeof import("./agent-runner.js").runReplyAgent;

function makeRunReplyAgentParams(
  overrides: Partial<Parameters<typeof runReplyAgent>[0]> & {
    provider?: string;
    prompt?: string;
    workspaceDir?: string;
  } = {},
): Parameters<typeof runReplyAgent>[0] {
  const provider = overrides.provider ?? "whatsapp";
  const prompt = overrides.prompt ?? "generate chart";
  const workspaceDir = overrides.workspaceDir ?? "/tmp/workspace";

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
    ...overrides,
  };
}

describe("runReplyAgent media path normalization", () => {
  beforeAll(async () => {
    ({ runReplyAgent } = await import("./agent-runner.js"));
  });

  beforeEach(() => {
    runEmbeddedPiAgentMock.mockReset();
    runWithModelFallbackMock.mockReset();
    abortEmbeddedPiRunMock.mockReset();
    compactEmbeddedPiSessionMock.mockReset();
    isEmbeddedPiRunActiveMock.mockReset();
    isEmbeddedPiRunActiveMock.mockReturnValue(false);
    isEmbeddedPiRunStreamingMock.mockReset();
    isEmbeddedPiRunStreamingMock.mockReturnValue(false);
    queueEmbeddedPiMessageWithOutcomeMock.mockReset();
    queueEmbeddedPiMessageWithOutcomeMock.mockImplementation((sessionId: string) => ({
      queued: false,
      sessionId,
      reason: "not_streaming",
      gatewayHealth: "live",
    }));
    resolveEmbeddedSessionLaneMock.mockReset();
    waitForEmbeddedPiRunEndMock.mockReset();
    enqueueFollowupRunMock.mockReset();
    scheduleFollowupDrainMock.mockReset();
    refreshQueuedFollowupSessionMock.mockReset();
    resolveOutboundAttachmentFromUrlMock.mockReset();
    createReplyMediaContextRuntimeMock.mockReset();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resolveOutboundAttachmentFromUrlMock.mockImplementation(async (mediaUrl: string) => ({
      path: path.join("/tmp/outbound-media", path.basename(mediaUrl)),
    }));
    runWithModelFallbackMock.mockImplementation(
      async ({
        provider,
        model,
        run,
      }: {
        provider: string;
        model: string;
        run: (...args: unknown[]) => Promise<unknown>;
      }) => ({
        result: await run(provider, model),
        provider,
        model,
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes final MEDIA replies against the run workspace", async () => {
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "MEDIA:./out/generated.png" }],
      meta: {
        agentMeta: {
          sessionId: "session",
          provider: "anthropic",
          model: "claude",
        },
      },
    });

    const result = await runReplyAgent(
      makeRunReplyAgentParams({
        provider: "telegram",
        prompt: "generate",
      }),
    );

    expect(Array.isArray(result)).toBe(false);
    if (!result || Array.isArray(result)) {
      throw new Error("expected single reply payload");
    }
    expect(result.mediaUrl).toBe("/tmp/outbound-media/generated.png");
    expect(result.mediaUrls).toEqual(["/tmp/outbound-media/generated.png"]);
    const outboundAttachmentCall = resolveOutboundAttachmentFromUrlMock.mock.calls[0];
    expect(outboundAttachmentCall?.[0]).toBe(path.join("/tmp/workspace", "out", "generated.png"));
    expect(outboundAttachmentCall?.[1]).toBe(5 * 1024 * 1024);
    const outboundAttachmentOptions = outboundAttachmentCall?.[2] as
      | { mediaAccess?: { workspaceDir?: unknown } }
      | undefined;
    expect(outboundAttachmentOptions?.mediaAccess?.workspaceDir).toBe("/tmp/workspace");
  });

  it("maps steer queue modes to Pi steering drain modes", async () => {
    queueEmbeddedPiMessageWithOutcomeMock.mockImplementation((sessionId: string) => ({
      queued: true,
      sessionId,
      target: "embedded_run",
      gatewayHealth: "live",
    }));

    await runReplyAgent(
      makeRunReplyAgentParams({
        resolvedQueue: { mode: "steer" } as QueueSettings,
        shouldSteer: true,
        isStreaming: true,
      }),
    );

    expect(queueEmbeddedPiMessageWithOutcomeMock).toHaveBeenLastCalledWith(
      "session",
      "generate chart",
      {
        steeringMode: "all",
      },
    );

    await runReplyAgent(
      makeRunReplyAgentParams({
        resolvedQueue: { mode: "queue" } as QueueSettings,
        shouldSteer: true,
        isStreaming: true,
      }),
    );

    expect(queueEmbeddedPiMessageWithOutcomeMock).toHaveBeenLastCalledWith(
      "session",
      "generate chart",
      {
        steeringMode: "one-at-a-time",
      },
    );
  });

  it("shares one media cache between block accumulation and final payload delivery", async () => {
    let stagedIndex = 0;
    resolveOutboundAttachmentFromUrlMock.mockImplementation(async (mediaUrl: string) => {
      stagedIndex += 1;
      return {
        path: path.join("/tmp/outbound-media", `${stagedIndex}-${path.basename(mediaUrl)}`),
      };
    });
    const onBlockReply = vi.fn();
    runEmbeddedPiAgentMock.mockImplementation(
      async (params: {
        onBlockReply?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void>;
      }) => {
        await params.onBlockReply?.({
          text: "here is the chart\nMEDIA:./out/chart.png",
        });
        return {
          payloads: [{ text: "here is the chart\nMEDIA:./out/chart.png" }],
          meta: {
            agentMeta: {
              sessionId: "session",
              provider: "anthropic",
              model: "claude",
            },
          },
        };
      },
    );

    const result = await runReplyAgent(
      makeRunReplyAgentParams({
        opts: {
          onBlockReply,
        },
      }),
    );

    expect(result).toBeUndefined();
    expect(onBlockReply).toHaveBeenCalledWith({
      text: "here is the chart",
      mediaUrl: "/tmp/outbound-media/1-chart.png",
      mediaUrls: ["/tmp/outbound-media/1-chart.png"],
      replyToId: "msg-1",
      replyToTag: false,
      audioAsVoice: false,
    });
    expect(resolveOutboundAttachmentFromUrlMock).toHaveBeenCalledTimes(1);
  });

  it("does not create a second media context inside runAgentTurnWithFallback when onBlockReply is provided", async () => {
    // Regression test for openclaw/openclaw#68056.
    // Before the fix, runAgentTurnWithFallback created its own media context, separate from
    // the one agent-runner.ts created and passed to buildReplyPayloads. Two separate caches
    // meant the same source could be persisted twice (two UUID outbound files, two sends).
    //
    // After the fix, agent-runner.ts passes its media context into runAgentTurnWithFallback, so
    // the .runtime import path is never called from inside that function.
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [],
      meta: {
        agentMeta: {
          sessionId: "session",
          provider: "anthropic",
          model: "claude",
        },
      },
    });

    await runReplyAgent(
      makeRunReplyAgentParams({
        opts: {
          onBlockReply: vi.fn(),
        },
      }),
    );

    // The .runtime import is only used by agent-runner-execution.ts. After the fix,
    // runAgentTurnWithFallback receives the context from the caller and never
    // creates its own.
    expect(createReplyMediaContextRuntimeMock).not.toHaveBeenCalled();
  });
});
