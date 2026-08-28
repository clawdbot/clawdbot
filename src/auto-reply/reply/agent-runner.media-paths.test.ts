// Tests media path handling and sandbox staging inside agent runner inputs.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedAgentQueueMessageOutcome } from "../../agents/embedded-agent-runner/runs.js";
import {
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import {
  createReplyOperation as createRegisteredReplyOperation,
  type ReplyOperation,
} from "./reply-run-registry.js";
import { resolveFollowupRunToolAuthorityFingerprint } from "./reply-tool-authority.js";
import {
  createMockFollowupRun,
  createMockReplyOperation,
  createMockTypingController,
} from "./test-helpers.js";

const runEmbeddedAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const abortEmbeddedAgentRunMock = vi.fn();
const compactEmbeddedAgentSessionMock = vi.fn();
const isEmbeddedAgentRunActiveMock = vi.fn(() => false);
const isEmbeddedAgentRunStreamingMock = vi.fn(() => false);
const queueEmbeddedAgentMessageWithOutcomeAsyncMock = vi.fn(
  async (
    sessionId: string,
    _text: string,
    _options?: unknown,
  ): Promise<EmbeddedAgentQueueMessageOutcome> => ({
    queued: false,
    sessionId,
    reason: "not_streaming",
    gatewayHealth: "live",
  }),
);
const resolveEmbeddedSessionLaneMock = vi.fn();
const waitForEmbeddedAgentRunEndMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();
const parkedSteerAdmitMock = vi.fn(async () => "steer" as const);
const parkedSteerAcceptedMock = vi.fn();
const parkedSteerFallbackMock = vi.fn();
const parkedSteerConsumeMock = vi.fn();
const parkSteerCandidateMock = vi.fn(() => ({
  admit: parkedSteerAdmitMock,
  accepted: parkedSteerAcceptedMock,
  fallback: parkedSteerFallbackMock,
  consume: parkedSteerConsumeMock,
}));
const scheduleFollowupDrainMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const resolveCommandSecretRefsViaGatewayMock = vi.fn();
const resolveOutboundAttachmentFromUrlMock = vi.fn();
const createReplyMediaContextRuntimeMock = vi.fn();
const EXPECTED_STEER_QUEUE_IDENTITY =
  "channel-user:v1:6f3f31084a7a2a6ff17176c0c16682e64d9f21301f64ff7e5bf1173b54fadc33";
const registeredOperations: ReplyOperation[] = [];
vi.mock("../../agents/model-fallback-runner.js", () => ({
  runWithModelFallback: (params: TestModelFallbackRunnerParams) => runWithModelFallbackMock(params),
}));

vi.mock("../../agents/model-fallback-attempt.js", () => ({
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("../../agents/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/model-selection.js")>(
    "../../agents/model-selection.js",
  );
  return {
    ...actual,
    isCliProvider: (provider: string, _cfg?: OpenClawConfig) => {
      const normalized = provider.trim().toLowerCase();
      return (
        normalized === "claude-cli" ||
        normalized === "google-gemini-cli" ||
        normalized === "codex-cli"
      );
    },
  };
});

vi.mock("../../agents/model-runtime-aliases.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/model-runtime-aliases.js")>(
    "../../agents/model-runtime-aliases.js",
  );
  const normalize = (value: string) => value.trim().toLowerCase();
  return {
    ...actual,
    areRuntimeModelRefsEquivalent: (left: string, right: string) =>
      normalize(left) === normalize(right),
  };
});

vi.mock("../../agents/context.js", () => ({
  resolveContextTokensForModel: () => 200_000,
}));

vi.mock("../../infra/agent-events.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/agent-events.js")>(
    "../../infra/agent-events.js",
  );
  return {
    ...actual,
    emitAgentEvent: vi.fn(),
    registerAgentRunContext: vi.fn(),
  };
});
vi.mock("../../infra/agent-run-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/agent-run-registry.js")>(
    "../../infra/agent-run-registry.js",
  );
  return {
    ...actual,
    registerAgentRunContext: vi.fn(),
  };
});

vi.mock("../../agents/embedded-agent.js", () => ({
  abortEmbeddedAgentRun: abortEmbeddedAgentRunMock,
  compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock,
  isEmbeddedAgentRunActive: isEmbeddedAgentRunActiveMock,
  isEmbeddedAgentRunStreaming: isEmbeddedAgentRunStreamingMock,
  queueEmbeddedAgentMessageWithOutcomeAsync: queueEmbeddedAgentMessageWithOutcomeAsyncMock,
  resolveEmbeddedSessionLane: resolveEmbeddedSessionLaneMock,
  runEmbeddedAgent: runEmbeddedAgentMock,
  waitForEmbeddedAgentRunEnd: waitForEmbeddedAgentRunEndMock,
}));

vi.mock("../../agents/embedded-agent-runner/runs.js", () => ({
  formatEmbeddedAgentQueueFailureSummary: (outcome: { reason?: string; sessionId?: string }) =>
    outcome.reason && outcome.sessionId
      ? `queue_message_failed reason=${outcome.reason} sessionId=${outcome.sessionId} gatewayHealth=live`
      : undefined,
  queueEmbeddedAgentMessageWithOutcomeAsync: queueEmbeddedAgentMessageWithOutcomeAsyncMock,
}));

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: (...args: unknown[]) =>
    resolveCommandSecretRefsViaGatewayMock(...args),
}));

vi.mock("../../cli/command-secret-targets.js", () => ({
  getAgentRuntimeCommandSecretTargetIds: () => new Set<string>(),
  getAgentRuntimeOptionalCommandSecretPaths: () => new Set<string>(),
  getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
}));

vi.mock("../../agents/sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/sandbox.js")>();
  return {
    ...actual,
    ensureSandboxWorkspaceForSession: async () => null,
  };
});

vi.mock("./reply-media-paths.js", () => ({
  createReplyMediaContext: ({ workspaceDir }: { workspaceDir: string }) => {
    const cache = new Map<string, Promise<string>>();
    const normalizeSource = (media: string) =>
      media.startsWith("./") ? path.join(workspaceDir, media.slice(2)) : media;
    const persist = async (media: string) => {
      const source = normalizeSource(media);
      const cached = cache.get(source);
      if (cached) {
        return await cached;
      }
      const pending = resolveOutboundAttachmentFromUrlMock(source, 5 * 1024 * 1024, {
        mediaAccess: { workspaceDir },
      }).then((saved: { path: string }) => saved.path);
      cache.set(source, pending);
      return await pending;
    };
    return {
      normalizePayload: async (payload: {
        mediaUrl?: string;
        mediaUrls?: string[];
        text?: string;
      }) => {
        const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
        if (mediaUrls.length === 0) {
          return payload;
        }
        const normalized = await Promise.all(mediaUrls.map((media) => persist(media)));
        return {
          ...payload,
          mediaUrl: normalized[0],
          mediaUrls: normalized,
        };
      },
    };
  },
}));

vi.mock("./agent-runner-payloads.js", () => ({
  buildReplyPayloads: async (params: {
    payloads: Array<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>;
    didLogHeartbeatStrip: boolean;
    blockStreamingEnabled?: boolean;
    blockReplyPipeline?: { didStream?: () => boolean; isAborted?: () => boolean } | null;
    normalizeMediaPaths?: (payload: {
      text?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
    }) => Promise<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>;
  }) => {
    if (
      params.blockStreamingEnabled &&
      params.blockReplyPipeline?.didStream?.() === true &&
      params.blockReplyPipeline?.isAborted?.() !== true
    ) {
      return { replyPayloads: [], didLogHeartbeatStrip: params.didLogHeartbeatStrip };
    }
    const replyPayloads = [];
    for (const payload of params.payloads) {
      const mediaUrls = [...(payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []))];
      const textLines = [];
      for (const line of (payload.text ?? "").split("\n")) {
        const media = line
          .trim()
          .match(/^MEDIA:(.+)$/)?.[1]
          ?.trim();
        if (media) {
          mediaUrls.push(media);
        } else {
          textLines.push(line);
        }
      }
      const nextPayload = {
        ...payload,
        text: textLines.join("\n").trim() || undefined,
        mediaUrl: mediaUrls[0],
        mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      };
      replyPayloads.push(
        params.normalizeMediaPaths && nextPayload.mediaUrls
          ? await params.normalizeMediaPaths(nextPayload)
          : nextPayload,
      );
    }
    return { replyPayloads, didLogHeartbeatStrip: params.didLogHeartbeatStrip };
  },
}));

vi.mock("./session-run-accounting.js", () => ({
  incrementRunCompactionCount: async () => undefined,
  persistRunSessionUsage: async () => undefined,
}));

vi.mock("./agent-runner-memory.js", () => ({
  runMemoryFlushIfNeeded: async ({ sessionEntry }: { sessionEntry?: unknown }) => ({
    sessionEntry,
    outcome: "skipped",
  }),
  runSessionCompactionIfNeeded: async ({ sessionEntry }: { sessionEntry?: unknown }) =>
    sessionEntry,
}));

vi.mock("./queue.js", () => ({
  admitFollowupRunLifecycle: vi.fn(async () => {}),
  enqueueFollowupRun: enqueueFollowupRunMock,
  parkSteerCandidate: parkSteerCandidateMock,
  refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock,
  resolveFollowupAbortSignal: vi.fn(() => undefined),
  scheduleFollowupDrain: scheduleFollowupDrainMock,
}));

vi.mock("../../media/outbound-attachment.js", () => ({
  resolveOutboundAttachmentFromUrl: (...args: unknown[]) =>
    resolveOutboundAttachmentFromUrlMock(...args),
}));

// Spy on the .runtime import path used by agent-runner-execution.ts so we can assert
// that the fix prevents a second media context from being created inside executeAgentTurn.
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

const { runReplyAgent } = await import("./agent-runner.js");

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
  const followupRun =
    overrides.followupRun ??
    createMockFollowupRun({
      prompt,
      run: {
        agentId: "main",
        agentDir: "/tmp/agent",
        messageProvider: provider,
        workspaceDir,
      },
    });
  const replyOperation =
    overrides.replyOperation ??
    (overrides.isActive === true
      ? createRegisteredReplyOperation({
          sessionKey: overrides.sessionKey ?? "main",
          sessionId: followupRun.run.sessionId,
          resetTriggered: false,
        })
      : createMockReplyOperation().replyOperation);
  if (overrides.isActive === true) {
    registeredOperations.push(replyOperation);
    if (!overrides.replyOperation) {
      replyOperation.setPhase("running");
    }
  }
  if (overrides.isActive === true && !replyOperation.toolAuthorityFingerprint) {
    replyOperation.bindToolAuthorityFingerprint(
      resolveFollowupRunToolAuthorityFingerprint(followupRun),
    );
  }
  if (overrides.isActive === true) {
    replyOperation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      supportsQueueMessageImages: true,
      taskSuggestionDeliveryMode: followupRun.run.taskSuggestionDeliveryMode,
      messageInjection: {
        isAvailable: () => true,
        queueMessage: async (text, options) => {
          const outcome = await queueEmbeddedAgentMessageWithOutcomeAsyncMock(
            replyOperation.sessionId,
            text,
            options,
          );
          if (!outcome.queued) {
            throw new Error(outcome.reason);
          }
          return outcome.transcriptCommit === "unconfirmed"
            ? {
                transcriptCommit: outcome.transcriptCommit,
                errorMessage: outcome.errorMessage ?? "commit unconfirmed",
              }
            : undefined;
        },
      },
    });
  }

  return {
    commandBody: prompt,
    followupRun,
    queueKey: "main",
    resolvedQueue: { mode: "interrupt" } as QueueSettings,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
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
    replyOperation,
    ...overrides,
  };
}

describe("runReplyAgent media path normalization", () => {
  const cleanupPaths: string[] = [];

  beforeEach(() => {
    runEmbeddedAgentMock.mockReset();
    runWithModelFallbackMock.mockReset();
    abortEmbeddedAgentRunMock.mockReset();
    compactEmbeddedAgentSessionMock.mockReset();
    isEmbeddedAgentRunActiveMock.mockReset();
    isEmbeddedAgentRunActiveMock.mockReturnValue(false);
    isEmbeddedAgentRunStreamingMock.mockReset();
    isEmbeddedAgentRunStreamingMock.mockReturnValue(false);
    queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockReset();
    queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockImplementation(async (sessionId: string) => ({
      queued: false,
      sessionId,
      reason: "not_streaming",
      gatewayHealth: "live",
    }));
    resolveEmbeddedSessionLaneMock.mockReset();
    waitForEmbeddedAgentRunEndMock.mockReset();
    enqueueFollowupRunMock.mockReset();
    parkedSteerAdmitMock.mockReset();
    parkedSteerAdmitMock.mockResolvedValue("steer");
    parkedSteerAcceptedMock.mockReset();
    parkedSteerFallbackMock.mockReset();
    parkedSteerConsumeMock.mockReset();
    parkSteerCandidateMock.mockReset();
    parkSteerCandidateMock.mockReturnValue({
      admit: parkedSteerAdmitMock,
      accepted: parkedSteerAcceptedMock,
      fallback: parkedSteerFallbackMock,
      consume: parkedSteerConsumeMock,
    });
    scheduleFollowupDrainMock.mockReset();
    refreshQueuedFollowupSessionMock.mockReset();
    resolveCommandSecretRefsViaGatewayMock.mockReset();
    resolveCommandSecretRefsViaGatewayMock.mockImplementation(async ({ config }) => ({
      resolvedConfig: config,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    }));
    resolveOutboundAttachmentFromUrlMock.mockReset();
    createReplyMediaContextRuntimeMock.mockReset();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resolveOutboundAttachmentFromUrlMock.mockImplementation(async (mediaUrl: string) => ({
      path: path.join("/tmp/outbound-media", path.basename(mediaUrl)),
    }));
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => ({
      result: await runInitialModelFallbackAttempt(params),
      provider: params.provider,
      model: params.model,
      attempts: [],
    }));
  });

  afterEach(() => {
    for (const operation of registeredOperations.splice(0)) {
      operation.complete();
    }
    vi.useRealTimers();
    const paths = cleanupPaths.splice(0);
    return Promise.all(paths.map((entry) => rm(entry, { recursive: true, force: true })));
  });

  it("normalizes final MEDIA replies against the run workspace", async () => {
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "here is the chart\nMEDIA:./out/generated.png" }],
      meta: {
        agentMeta: {
          sessionId: "session",
          provider: "anthropic",
          model: "claude",
        },
      },
    });

    const result = await runReplyAgent(makeRunReplyAgentParams());

    expect(Array.isArray(result)).toBe(false);
    if (!result || Array.isArray(result)) {
      throw new Error("Expected a single reply payload");
    }
    expect(result).toMatchObject({
      text: "here is the chart",
      mediaUrl: "/tmp/outbound-media/generated.png",
      mediaUrls: ["/tmp/outbound-media/generated.png"],
    });
    expect(resolveOutboundAttachmentFromUrlMock).toHaveBeenCalledWith(
      path.join("/tmp/workspace", "out", "generated.png"),
      5 * 1024 * 1024,
      { mediaAccess: expect.objectContaining({ workspaceDir: "/tmp/workspace" }) },
    );
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(createReplyMediaContextRuntimeMock).not.toHaveBeenCalled();
  });

  it("steers active non-streaming prompts in steer queue mode", async () => {
    queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockImplementation(async (sessionId: string) => ({
      queued: true,
      sessionId,
      target: "embedded_run",
      gatewayHealth: "live",
    }));
    const followupRun = createMockFollowupRun({ prompt: "generate chart" });
    followupRun.run.taskSuggestionDeliveryMode = "gateway";

    await runReplyAgent(
      makeRunReplyAgentParams({
        resolvedQueue: { mode: "steer" } as QueueSettings,
        shouldSteer: true,
        shouldFollowup: true,
        isActive: true,
        followupRun,
      }),
    );

    expect(queueEmbeddedAgentMessageWithOutcomeAsyncMock).toHaveBeenLastCalledWith(
      "session",
      "generate chart",
      {
        abortSignal: undefined,
        steeringMode: "all",
        isInboundUserMessage: true,
        waitForTranscriptCommit: true,
        queueIdentity: EXPECTED_STEER_QUEUE_IDENTITY,
        onQueueAccepted: expect.any(Function),
        taskSuggestionDeliveryMode: "gateway",
        toolAuthorityFingerprint: resolveFollowupRunToolAuthorityFingerprint(followupRun),
      },
    );
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
    expect(parkedSteerConsumeMock).toHaveBeenCalledOnce();
    expect(parkedSteerFallbackMock).not.toHaveBeenCalled();
  });

  it("steers ordered current-turn images with the active prompt", async () => {
    queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockImplementation(async (sessionId: string) => ({
      queued: true,
      sessionId,
      target: "embedded_run",
      gatewayHealth: "live",
    }));
    const images = [
      { type: "image" as const, data: "first", mimeType: "image/jpeg" },
      { type: "image" as const, data: "second", mimeType: "image/png" },
    ];
    const followupRun = createMockFollowupRun({ prompt: "compare these" });
    followupRun.images = images;
    followupRun.media = [
      { path: "/tmp/first.jpg", contentType: "image/jpeg" },
      { path: "/tmp/second.png", contentType: "image/png" },
    ];

    await runReplyAgent(
      makeRunReplyAgentParams({
        resolvedQueue: { mode: "steer" } as QueueSettings,
        shouldSteer: true,
        shouldFollowup: true,
        isActive: true,
        followupRun,
      }),
    );

    expect(queueEmbeddedAgentMessageWithOutcomeAsyncMock).toHaveBeenLastCalledWith(
      "session",
      "compare these",
      {
        abortSignal: undefined,
        steeringMode: "all",
        isInboundUserMessage: true,
        waitForTranscriptCommit: true,
        queueIdentity: EXPECTED_STEER_QUEUE_IDENTITY,
        onQueueAccepted: expect.any(Function),
        images,
        media: followupRun.media,
        taskSuggestionDeliveryMode: undefined,
        toolAuthorityFingerprint: resolveFollowupRunToolAuthorityFingerprint(followupRun),
      },
    );
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
    expect(parkedSteerConsumeMock).toHaveBeenCalledOnce();
    expect(parkedSteerFallbackMock).not.toHaveBeenCalled();
  });

  it("defers the complete image turn when the active runtime cannot preserve images", async () => {
    queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockImplementation(async (sessionId: string) => ({
      queued: false,
      sessionId,
      reason: "image_input_unsupported",
      gatewayHealth: "live",
    }));
    const images = [{ type: "image" as const, data: "png", mimeType: "image/png" }];
    const followupRun = createMockFollowupRun({ prompt: "inspect this" });
    followupRun.images = images;

    await runReplyAgent(
      makeRunReplyAgentParams({
        resolvedQueue: { mode: "steer" } as QueueSettings,
        shouldSteer: true,
        shouldFollowup: true,
        isActive: true,
        followupRun,
      }),
    );

    expect(parkSteerCandidateMock).toHaveBeenCalledWith(
      "main",
      followupRun,
      expect.objectContaining({ mode: "steer" }),
      expect.any(Function),
    );
    expect(parkedSteerFallbackMock).toHaveBeenCalledOnce();
    expect(parkedSteerConsumeMock).not.toHaveBeenCalled();
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
  });

  it("latches audio only after the active reply operation accepts the steer", async () => {
    const followupRun = {
      ...createMockFollowupRun({ prompt: "summarize the audio" }),
      currentInboundAudio: true,
    } as unknown as FollowupRun;
    const operation = createRegisteredReplyOperation({
      sessionKey: "agent:main:whatsapp:direct:chat-1",
      sessionId: "session",
      resetTriggered: false,
    });
    operation.setPhase("running");
    operation.bindToolAuthorityFingerprint(resolveFollowupRunToolAuthorityFingerprint(followupRun));
    expect(operation.acceptedSteeredInboundAudio).toBe(false);
    queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockImplementation(async (sessionId: string) => ({
      queued: true,
      sessionId,
      target: "embedded_run",
      gatewayHealth: "live",
    }));

    await runReplyAgent(
      makeRunReplyAgentParams({
        followupRun,
        replyOperation: operation,
        sessionKey: "agent:main:whatsapp:direct:chat-1",
        resolvedQueue: { mode: "steer" } as QueueSettings,
        shouldSteer: true,
        shouldFollowup: true,
        isActive: true,
      }),
    );

    expect(operation.acceptedSteeredInboundAudio).toBe(true);
    expect(queueEmbeddedAgentMessageWithOutcomeAsyncMock).toHaveBeenLastCalledWith(
      "session",
      "summarize the audio",
      {
        abortSignal: undefined,
        steeringMode: "all",
        isInboundUserMessage: true,
        waitForTranscriptCommit: true,
        queueIdentity: EXPECTED_STEER_QUEUE_IDENTITY,
        onQueueAccepted: expect.any(Function),
        taskSuggestionDeliveryMode: undefined,
        toolAuthorityFingerprint: operation.toolAuthorityFingerprint,
      },
    );
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
    expect(parkedSteerConsumeMock).toHaveBeenCalledOnce();
    expect(parkedSteerFallbackMock).not.toHaveBeenCalled();
  });

  it("queues active prompts in followup mode without steering", async () => {
    await runReplyAgent(
      makeRunReplyAgentParams({
        resolvedQueue: { mode: "followup" } as QueueSettings,
        shouldSteer: false,
        shouldFollowup: true,
        isActive: true,
        isRunActive: () => true,
      }),
    );

    expect(queueEmbeddedAgentMessageWithOutcomeAsyncMock).not.toHaveBeenCalled();
    expect(parkSteerCandidateMock).not.toHaveBeenCalled();
    expect(enqueueFollowupRunMock).toHaveBeenCalledOnce();
    expect(enqueueFollowupRunMock.mock.calls[0]?.[1].prompt).toBe("generate chart");
  });

  it("falls back to a queued followup when active steering is rejected", async () => {
    queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockImplementation(async (sessionId: string) => ({
      queued: false,
      sessionId,
      reason: "runtime_rejected",
      gatewayHealth: "live",
      errorMessage: "cannot steer a compact turn",
    }));

    await runReplyAgent(
      makeRunReplyAgentParams({
        resolvedQueue: { mode: "steer" } as QueueSettings,
        shouldSteer: true,
        shouldFollowup: true,
        isActive: true,
        isRunActive: () => true,
      }),
    );

    expect(parkSteerCandidateMock).toHaveBeenCalledWith(
      "main",
      expect.objectContaining({ prompt: "generate chart" }),
      expect.objectContaining({ mode: "steer" }),
      expect.any(Function),
    );
    expect(parkedSteerFallbackMock).toHaveBeenCalledOnce();
    expect(parkedSteerConsumeMock).not.toHaveBeenCalled();
    expect(enqueueFollowupRunMock).not.toHaveBeenCalled();
  });

  it("shares one media cache between block accumulation and final payload delivery", async () => {
    const { createReplyMediaContext } =
      await vi.importActual<typeof import("./reply-media-paths.js")>("./reply-media-paths.js");
    const mediaContext = createReplyMediaContext({
      cfg: {},
      sessionKey: "main",
      workspaceDir: "/tmp/workspace",
      messageProvider: "telegram",
      accountId: "default",
    });
    let stagedIndex = 0;
    resolveOutboundAttachmentFromUrlMock.mockImplementation(async (mediaUrl: string) => {
      stagedIndex += 1;
      return {
        path: path.join("/tmp/outbound-media", `${stagedIndex}-${path.basename(mediaUrl)}`),
      };
    });

    const blockPayload = await mediaContext.normalizePayload({
      text: "here is the chart",
      mediaUrl: "./out/chart.png",
      mediaUrls: ["./out/chart.png"],
    });
    const finalPayload = await mediaContext.normalizePayload({
      text: "here is the chart",
      mediaUrl: "./out/chart.png",
      mediaUrls: ["./out/chart.png"],
    });

    expect(blockPayload).toEqual({
      text: "here is the chart",
      mediaUrl: "/tmp/outbound-media/1-chart.png",
      mediaUrls: ["/tmp/outbound-media/1-chart.png"],
      attachments: [{ name: "chart.png", mimeType: "image/png", trustedLocalMedia: true }],
      trustedLocalMedia: true,
    });
    expect(finalPayload).toEqual(blockPayload);
    expect(resolveOutboundAttachmentFromUrlMock).toHaveBeenCalledTimes(1);
  });

  async function runAgentTurnWithSessionContext(
    sessionCtx: TemplateContext,
    prompt = "describe this image",
  ): Promise<void> {
    const { executeAgentTurn } = await import("./agent-runner-execution.js");
    await executeAgentTurn({
      commandBody: prompt,
      followupRun: createMockFollowupRun({
        prompt,
        run: {
          provider: "ollama",
          model: "gemma4:latest",
          workspaceDir: "/tmp/workspace",
          config: {},
        },
      }),
      sessionCtx,
      typingSignals: {
        mode: "instant",
        shouldStartImmediately: true,
        shouldStartOnMessageStart: false,
        shouldStartOnText: true,
        shouldStartOnReasoning: false,
        signalRunStart: async () => {},
        signalMessageStart: async () => {},
        signalTextDelta: async () => {},
        signalReasoningDelta: async () => {},
        signalToolStart: async () => {},
      },
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
      replyMediaContext: {
        normalizePayload: async (payload) => payload,
      },
    });
  }

  it("reuses the provided media context inside executeAgentTurn", async () => {
    // Regression test for openclaw/openclaw#68056.
    // executeAgentTurn must use the caller-provided context so block
    // replies and final replies can share one media cache.
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [],
      meta: {
        agentMeta: {
          sessionId: "session",
          provider: "anthropic",
          model: "claude",
        },
      },
    });

    const { executeAgentTurn } = await import("./agent-runner-execution.js");
    const followupRun = createMockFollowupRun({
      prompt: "generate",
      run: {
        provider: "anthropic",
        model: "claude",
        workspaceDir: "/tmp/workspace",
        config: {},
      },
    });
    await executeAgentTurn({
      commandBody: "generate",
      followupRun,
      sessionCtx: {
        Provider: "telegram",
        Surface: "telegram",
        To: "chat-1",
        OriginatingTo: "chat-1",
        AccountId: "default",
        MessageSid: "msg-1",
      } as unknown as TemplateContext,
      typingSignals: {
        mode: "instant",
        shouldStartImmediately: true,
        shouldStartOnMessageStart: false,
        shouldStartOnText: true,
        shouldStartOnReasoning: false,
        signalRunStart: async () => {},
        signalMessageStart: async () => {},
        signalTextDelta: async () => {},
        signalReasoningDelta: async () => {},
        signalToolStart: async () => {},
      },
      blockReplyPipeline: null,
      blockStreamingEnabled: true,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
      replyMediaContext: {
        normalizePayload: async (payload) => payload,
      },
    });

    // The .runtime import is only used by agent-runner-execution.ts. This path
    // should never create its own media context when the caller provides one.
    expect(createReplyMediaContextRuntimeMock).not.toHaveBeenCalled();
  });

  it("passes current inbound media paths as native OpenClaw images", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-native-agent-media-"));
    cleanupPaths.push(tmpDir);
    const imagePath = path.join(tmpDir, "photo.png");
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          sessionId: "session",
          provider: "ollama",
          model: "gemma4:latest",
        },
      },
    });

    await runAgentTurnWithSessionContext({
      Provider: "telegram",
      Surface: "telegram",
      To: "chat-1",
      OriginatingTo: "chat-1",
      AccountId: "default",
      MessageSid: "msg-1",
      media: [{ path: imagePath, contentType: "image/png", workspaceDir: tmpDir }],
    } as unknown as TemplateContext);

    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    const call = runEmbeddedAgentMock.mock.calls[0]?.[0] as
      | {
          images?: Array<{ type?: string; data?: string; mimeType?: string }>;
          imageOrder?: string[];
        }
      | undefined;
    expect(call?.images).toEqual([
      {
        type: "image",
        data: expect.any(String),
        mimeType: "image/png",
      },
    ]);
    expect(call?.images?.[0]?.data).toHaveLength(92);
    expect(call?.imageOrder).toEqual(["inline"]);
  });

  it("does not pass recent history images as unlabeled native OpenClaw images", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-native-agent-history-"));
    cleanupPaths.push(tmpDir);
    const imagePath = path.join(tmpDir, "recent.png");
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          sessionId: "session",
          provider: "ollama",
          model: "gemma4:latest",
        },
      },
    });

    await runAgentTurnWithSessionContext(
      {
        Provider: "telegram",
        Surface: "telegram",
        To: "chat-1",
        OriginatingTo: "chat-1",
        AccountId: "default",
        MessageSid: "msg-1",
        Timestamp: 1_700_000_000_000,
        InboundHistory: [
          {
            sender: "alice",
            body: "<media:image>",
            timestamp: 1_700_000_000_000,
            media: [{ path: imagePath, contentType: "image/png", kind: "image" }],
          },
        ],
      } as unknown as TemplateContext,
      "what did we discuss?",
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    const call = runEmbeddedAgentMock.mock.calls[0]?.[0] as
      | {
          images?: Array<{ type?: string; data?: string; mimeType?: string }>;
          imageOrder?: string[];
        }
      | undefined;
    expect(call?.images).toBeUndefined();
    expect(call?.imageOrder).toBeUndefined();
  });

  it("retains resolved current images and skips unresolved attachments", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-native-agent-partial-"));
    cleanupPaths.push(tmpDir);
    const imagePath = path.join(tmpDir, "present.png");
    await writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          sessionId: "session",
          provider: "ollama",
          model: "gemma4:latest",
        },
      },
    });

    await runAgentTurnWithSessionContext(
      {
        Provider: "telegram",
        Surface: "telegram",
        To: "chat-1",
        OriginatingTo: "chat-1",
        AccountId: "default",
        MessageSid: "msg-1",
        media: [
          {
            path: path.join(tmpDir, "missing.png"),
            contentType: "image/png",
            workspaceDir: tmpDir,
          },
          { path: imagePath, contentType: "image/png", workspaceDir: tmpDir },
        ],
      } as unknown as TemplateContext,
      "compare these images",
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    const call = runEmbeddedAgentMock.mock.calls[0]?.[0] as
      | {
          images?: Array<{ type?: string; data?: string; mimeType?: string }>;
          imageOrder?: string[];
        }
      | undefined;
    expect(call?.images).toHaveLength(1);
    expect(call?.images?.[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(call?.imageOrder).toEqual(["inline"]);
  });
});
