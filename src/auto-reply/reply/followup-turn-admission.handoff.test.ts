import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { FollowupRun } from "./queue.js";
import { resolveFollowupReplyDeliveryTargetKey } from "./queue/delivery-target.js";
import {
  bindReplyCompletionHandoffToQueuedRun,
  replaceReplyCompletionQueuePredecessor,
  type ReplyCompletionHandoff,
} from "./reply-completion-handoff.js";

const COMPLETED_SOURCE_REPLY_HANDOFF_MARKER = "immediately preceding turn already delivered";

const state = vi.hoisted(() => ({
  admitLifecycle: vi.fn(),
  admitReply: vi.fn(),
  buildPreflightFailureText: vi.fn(),
  preflight: vi.fn(),
  recheckFallbackProbe: vi.fn(),
  refreshGoal: vi.fn(),
  resolveConfig: vi.fn(),
  resolveSendPolicy: vi.fn(),
}));

vi.mock("./agent-runner-auto-fallback.js", () => ({
  resolveRunAfterAutoFallbackPrimaryProbeRecheck: (...args: unknown[]) =>
    state.recheckFallbackProbe(...args),
}));

vi.mock("./agent-runner-memory.js", () => ({
  runPreflightCompactionIfNeeded: (...args: unknown[]) => state.preflight(...args),
}));

vi.mock("./agent-runner-utils.js", () => ({
  resolveQueuedReplyExecutionConfig: (...args: unknown[]) => state.resolveConfig(...args),
  resolveQueuedReplyRuntimeConfig: (config: unknown) => config,
}));

vi.mock("./reply-turn-admission.js", () => ({
  admitReplyTurn: (...args: unknown[]) => state.admitReply(...args),
}));

vi.mock("./queue.js", () => ({
  admitFollowupRunLifecycle: (...args: unknown[]) => state.admitLifecycle(...args),
  isFollowupRunAborted: (run: FollowupRun) =>
    run.abortSignal?.aborted === true || run.queueAbortSignal?.aborted === true,
  resolveFollowupAbortSignal: (run: FollowupRun) => run.abortSignal ?? run.queueAbortSignal,
}));

vi.mock("../../sessions/send-policy.js", () => ({
  resolveSendPolicy: (...args: unknown[]) => state.resolveSendPolicy(...args),
}));

vi.mock("./inbound-meta.js", () => ({
  refreshActiveGoalContext: (...args: unknown[]) => state.refreshGoal(...args),
}));

vi.mock("./compaction-notice.js", () => ({
  createCompactionNoticePayload: ({ phase }: { phase: string }) => ({ text: phase }),
  shouldNotifyUserAboutCompaction: () => false,
}));

vi.mock("./agent-runner-failure-reply.js", () => ({
  buildPreflightCompactionFailureText: (...args: unknown[]) =>
    state.buildPreflightFailureText(...args),
}));

const { admitFollowupTurn } = await import("./followup-turn-admission.js");

function createRun(overrides: Partial<FollowupRun> = {}): FollowupRun {
  return {
    prompt: "queued prompt",
    enqueuedAt: 1,
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "queued-session",
      sessionKey: "main",
      sessionFile: "/tmp/queued.jsonl",
      workspaceDir: "/tmp",
      config: {},
      provider: "anthropic",
      model: "claude",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
    ...overrides,
  };
}

function createOperation(
  sessionId = "queued-session",
  overrides: { key?: string; lifecycleGeneration?: string } = {},
) {
  return {
    key: overrides.key ?? "main",
    sessionId,
    lifecycleGeneration:
      overrides.lifecycleGeneration === undefined
        ? getAgentEventLifecycleGeneration()
        : overrides.lifecycleGeneration,
    result: null,
    abortForRestart: vi.fn(() => true),
    retainFailureUntilComplete: vi.fn(),
    fail: vi.fn(),
    complete: vi.fn(),
    updateSessionId: vi.fn(),
  };
}

function createCompletionHandoff(source = createCompletionEligibleRun()): ReplyCompletionHandoff {
  return Object.freeze({
    kind: "completed_source_reply",
    ownerKey: "main",
    ownerSessionId: "queued-session",
    ownerLifecycleGeneration: getAgentEventLifecycleGeneration(),
    deliveryTargetKey: resolveFollowupReplyDeliveryTargetKey(source),
  });
}

function createCompletionEligibleRun(overrides: Partial<FollowupRun> = {}): FollowupRun {
  return createRun({
    prompt: "What should we do next?",
    transcriptPrompt: "What should we do next?",
    currentInboundEventKind: "user_request",
    currentInboundContext: { text: "Authenticated inbound context" },
    originatingChannel: "telegram",
    originatingTo: "chat-1",
    originatingAccountId: "primary",
    run: {
      ...createRun().run,
      sessionKey: "main",
      sessionId: "queued-session",
      messageProvider: "telegram",
      agentAccountId: "primary",
    },
    ...overrides,
  });
}

function bindCompletionHandoff(queued: FollowupRun, source?: FollowupRun) {
  const owner = {};
  replaceReplyCompletionQueuePredecessor(owner, createCompletionHandoff(source));
  bindReplyCompletionHandoffToQueuedRun({ owner, queueKey: "main", queued });
  return owner;
}

function createDefaults() {
  return {
    typing: {} as never,
    typingMode: "never" as const,
    defaultModel: "claude",
    sessionKey: "main",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.resolveSendPolicy.mockReturnValue("allow");
  state.resolveConfig.mockImplementation(async (config) => config);
  state.buildPreflightFailureText.mockReturnValue("preflight failed");
  state.preflight.mockImplementation(async ({ sessionEntry }) => sessionEntry);
  state.recheckFallbackProbe.mockImplementation(({ run }) => run);
  state.admitLifecycle.mockResolvedValue(undefined);
  state.refreshGoal.mockImplementation((context) => context);
});

describe("admitFollowupTurn reply-completion handoff", () => {
  it("adds one runtime-only directive while preserving and answering the current request", async () => {
    const queued = createCompletionEligibleRun();
    bindCompletionHandoff(queued);
    state.admitReply.mockResolvedValue({ status: "owned", operation: createOperation() });

    const result = await admitFollowupTurn({ queued, defaults: createDefaults() });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      expect(result.turn.queued.prompt).toBe("What should we do next?");
      expect(result.turn.queued.transcriptPrompt).toBe("What should we do next?");
      expect(result.turn.queued.currentInboundEventKind).toBe("user_request");
      expect(result.turn.currentInboundContext?.text).toContain("Authenticated inbound context");
      expect(result.turn.currentInboundContext?.text).toContain(
        COMPLETED_SOURCE_REPLY_HANDOFF_MARKER,
      );
      expect(result.turn.currentInboundContext?.text).toContain(
        "send a new reply whenever it warrants one",
      );
      expect(result.turn.currentInboundContext?.text).toContain(
        "including when it explicitly asks to repeat or discuss the prior reply",
      );
    }

    state.admitReply.mockResolvedValue({ status: "owned", operation: createOperation() });
    const replay = await admitFollowupTurn({ queued, defaults: createDefaults() });
    expect(replay.kind).toBe("admitted");
    if (replay.kind === "admitted") {
      expect(replay.turn.currentInboundContext?.text).not.toContain(
        COMPLETED_SOURCE_REPLY_HANDOFF_MARKER,
      );
    }
  });

  it("retains the one-shot fact when reply admission defers and applies it on retry", async () => {
    const queued = createCompletionEligibleRun();
    bindCompletionHandoff(queued);
    state.admitReply.mockResolvedValueOnce({ status: "skipped", reason: "active-run" });

    await expect(admitFollowupTurn({ queued, defaults: createDefaults() })).resolves.toEqual({
      kind: "deferred",
      reason: "active-run",
    });

    state.admitReply.mockResolvedValueOnce({ status: "owned", operation: createOperation() });
    const retried = await admitFollowupTurn({ queued, defaults: createDefaults() });
    expect(retried.kind).toBe("admitted");
    if (retried.kind === "admitted") {
      expect(retried.turn.currentInboundContext?.text).toContain(
        COMPLETED_SOURCE_REPLY_HANDOFF_MARKER,
      );
    }
  });

  it("fails closed when the successor operation belongs to a different lifecycle", async () => {
    const queued = createCompletionEligibleRun();
    bindCompletionHandoff(queued);
    state.admitReply.mockResolvedValue({
      status: "owned",
      operation: createOperation("queued-session", { lifecycleGeneration: "stale-generation" }),
    });

    const result = await admitFollowupTurn({ queued, defaults: createDefaults() });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      expect(result.turn.currentInboundContext?.text).toBe("Authenticated inbound context");
    }
  });

  it("does not inject the previous-turn directive into a room event", async () => {
    const queued = createCompletionEligibleRun({ currentInboundEventKind: "room_event" });
    bindCompletionHandoff(queued);
    state.admitReply.mockResolvedValue({ status: "owned", operation: createOperation() });

    const result = await admitFollowupTurn({ queued, defaults: createDefaults() });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      expect(result.turn.queued.currentInboundEventKind).toBe("room_event");
      expect(result.turn.currentInboundContext?.text).toBe("Authenticated inbound context");
    }
  });

  it.each([
    ["reply anchor", { originatingReplyToId: "reply-2" }],
    ["reply policy", { originatingReplyToMode: "off" as const }],
    ["chat type", { originatingChatType: "group" }],
  ])("does not cross a mismatched %s", async (_label, mismatch) => {
    const source = createCompletionEligibleRun({
      originatingReplyToId: "reply-1",
      originatingReplyToMode: "all",
      originatingChatType: "direct",
    });
    const queued = createCompletionEligibleRun({
      originatingReplyToId: "reply-1",
      originatingReplyToMode: "all",
      originatingChatType: "direct",
      ...mismatch,
    });
    bindCompletionHandoff(queued, source);
    state.admitReply.mockResolvedValue({ status: "owned", operation: createOperation() });

    const result = await admitFollowupTurn({ queued, defaults: createDefaults() });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      expect(result.turn.currentInboundContext?.text).toBe("Authenticated inbound context");
    }
  });

  it("fails closed when the concrete queue owner clears after binding", async () => {
    const queued = createCompletionEligibleRun();
    const owner = { abortController: new AbortController() };
    replaceReplyCompletionQueuePredecessor(owner, createCompletionHandoff());
    bindReplyCompletionHandoffToQueuedRun({ owner, queueKey: "main", queued });
    owner.abortController.abort();
    state.admitReply.mockResolvedValue({ status: "owned", operation: createOperation() });

    const result = await admitFollowupTurn({ queued, defaults: createDefaults() });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      expect(result.turn.currentInboundContext?.text).toBe("Authenticated inbound context");
    }
  });

  it("does not let an adoption-time abort swallow the fact before the next successor", async () => {
    const aborted = createCompletionEligibleRun({ prompt: "aborted" });
    const owner = bindCompletionHandoff(aborted);
    const controller = new AbortController();
    aborted.queueAbortSignal = controller.signal;
    state.admitReply.mockResolvedValueOnce({ status: "owned", operation: createOperation() });
    state.admitLifecycle.mockImplementationOnce(async () => controller.abort());

    await expect(
      admitFollowupTurn({ queued: aborted, defaults: createDefaults() }),
    ).resolves.toMatchObject({ kind: "skipped", reason: "aborted" });

    const successor = createCompletionEligibleRun({ prompt: "successor" });
    bindReplyCompletionHandoffToQueuedRun({ owner, queueKey: "main", queued: successor });
    state.admitReply.mockResolvedValueOnce({ status: "owned", operation: createOperation() });
    const result = await admitFollowupTurn({ queued: successor, defaults: createDefaults() });

    expect(result.kind).toBe("admitted");
    if (result.kind === "admitted") {
      expect(result.turn.currentInboundContext?.text).toContain(
        COMPLETED_SOURCE_REPLY_HANDOFF_MARKER,
      );
    }
  });
});
