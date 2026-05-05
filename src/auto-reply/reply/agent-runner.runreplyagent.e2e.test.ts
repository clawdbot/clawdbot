import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import {
  enqueueFollowupRun,
  refreshQueuedFollowupSession,
  scheduleFollowupDrain,
  type FollowupRun,
  type QueueSettings,
} from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

type AgentRunParams = {
  onPartialReply?: (payload: { text?: string }) => Promise<void> | void;
  onAssistantMessageStart?: () => Promise<void> | void;
  onReasoningStream?: (payload: { text?: string }) => Promise<void> | void;
  onBlockReply?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void> | void;
  onToolResult?: (payload: ReplyPayload) => Promise<void> | void;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
  silentExpected?: boolean;
};

const state = vi.hoisted(() => ({
  compactEmbeddedPiSessionMock: vi.fn(),
  runEmbeddedPiAgentMock: vi.fn(),
}));

let modelFallbackModule: typeof import("../../agents/model-fallback.js");
let onAgentEvent: typeof import("../../infra/agent-events.js").onAgentEvent;

let runReplyAgentPromise:
  | Promise<(typeof import("./agent-runner.js"))["runReplyAgent"]>
  | undefined;

async function getRunReplyAgent() {
  if (!runReplyAgentPromise) {
    runReplyAgentPromise = import("./agent-runner.js").then((m) => m.runReplyAgent);
  }
  return await runReplyAgentPromise;
}

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: async ({
    provider,
    model,
    run,
  }: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await run(provider, model),
    provider,
    model,
    attempts: [],
  }),
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  compactEmbeddedPiSession: (params: unknown) => state.compactEmbeddedPiSessionMock(params),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => state.runEmbeddedPiAgentMock(params),
}));

vi.mock("./queue.js", () => ({
  enqueueFollowupRun: vi.fn(),
  refreshQueuedFollowupSession: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
}));

beforeAll(async () => {
  // Avoid attributing the initial agent-runner import cost to the first test case.
  modelFallbackModule = await import("../../agents/model-fallback.js");
  ({ onAgentEvent } = await import("../../infra/agent-events.js"));
  await getRunReplyAgent();
});

beforeEach(() => {
  state.compactEmbeddedPiSessionMock.mockReset();
  state.compactEmbeddedPiSessionMock.mockResolvedValue({
    ok: true,
    compacted: false,
    reason: "test-default",
  });
  state.runEmbeddedPiAgentMock.mockReset();
  state.runEmbeddedPiAgentMock.mockResolvedValue({
    payloads: [{ text: "final" }],
    meta: { agentMeta: { usage: { input: 1, output: 1 } } },
  });
  vi.mocked(enqueueFollowupRun).mockClear();
  vi.mocked(refreshQueuedFollowupSession).mockClear();
  vi.mocked(scheduleFollowupDrain).mockClear();
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
});

function createMinimalRun(params?: {
  opts?: GetReplyOptions;
  resolvedVerboseLevel?: "off" | "on";
  sessionStore?: Record<string, SessionEntry>;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
  typingMode?: TypingMode;
  blockStreamingEnabled?: boolean;
  isActive?: boolean;
  isRunActive?: () => boolean;
  shouldFollowup?: boolean;
  resolvedQueueMode?: string;
  sessionCtx?: Partial<TemplateContext>;
  runOverrides?: Partial<FollowupRun["run"]>;
}) {
  const typing = createMockTypingController();
  const opts = params?.opts;
  const sessionCtx = {
    Provider: "whatsapp",
    MessageSid: "msg",
    ...params?.sessionCtx,
  } as unknown as TemplateContext;
  const resolvedQueue = {
    mode: params?.resolvedQueueMode ?? "interrupt",
  } as unknown as QueueSettings;
  const sessionKey = params?.sessionKey ?? "main";
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      sessionId: "session",
      sessionKey,
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: params?.resolvedVerboseLevel ?? "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      skipProviderRuntimeHints: process.env.OPENCLAW_TEST_FAST === "1",
      ...params?.runOverrides,
    },
  } as unknown as FollowupRun;

  return {
    typing,
    opts,
    run: async () => {
      const runReplyAgent = await getRunReplyAgent();
      return runReplyAgent({
        commandBody: "hello",
        followupRun,
        queueKey: "main",
        resolvedQueue,
        shouldSteer: false,
        shouldFollowup: params?.shouldFollowup ?? false,
        isActive: params?.isActive ?? false,
        isRunActive: params?.isRunActive,
        isStreaming: false,
        opts,
        typing,
        sessionEntry: params?.sessionEntry,
        sessionStore: params?.sessionStore,
        sessionKey,
        storePath: params?.storePath,
        sessionCtx,
        defaultModel: "anthropic/claude-opus-4-6",
        resolvedVerboseLevel: params?.resolvedVerboseLevel ?? "off",
        isNewSession: false,
        blockStreamingEnabled: params?.blockStreamingEnabled ?? false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: params?.typingMode ?? "instant",
      });
    },
  };
}

describe("runReplyAgent heartbeat followup guard", () => {
  it("drops heartbeat runs when another run is active", async () => {
    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: true },
      isActive: true,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
    });

    const result = await run();

    expect(result).toBeUndefined();
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    expect(state.runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it("still enqueues non-heartbeat runs when another run is active", async () => {
    const { run } = createMinimalRun({
      opts: { isHeartbeat: false },
      isActive: true,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
    });

    const result = await run();

    expect(result).toBeUndefined();
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    expect(state.runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("keeps typing alive when a followup is queued behind a live active run", async () => {
    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: false },
      isActive: true,
      isRunActive: () => true,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
    });

    const result = await run();

    expect(result).toBeUndefined();
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleFollowupDrain)).not.toHaveBeenCalled();
    expect(state.runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).toHaveBeenCalledTimes(1);
    expect(typing.refreshTypingTtl).toHaveBeenCalledTimes(1);
    expect(typing.cleanup).not.toHaveBeenCalled();
  });

  it("starts draining immediately when the active snapshot is already stale", async () => {
    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: false },
      isActive: true,
      isRunActive: () => false,
      shouldFollowup: true,
      resolvedQueueMode: "collect",
    });

    const result = await run();

    expect(result).toBeUndefined();
    expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleFollowupDrain)).toHaveBeenCalledTimes(1);
    expect(state.runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it("drains followup queue when an unexpected exception escapes the run path", async () => {
    const accounting = await import("./session-run-accounting.js");
    const persistSpy = vi
      .spyOn(accounting, "persistRunSessionUsage")
      .mockRejectedValueOnce(new Error("persist exploded"));
    state.runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { agentMeta: { usage: { input: 1, output: 1 } } },
    });

    try {
      const { run } = createMinimalRun();
      await expect(run()).rejects.toThrow("persist exploded");
      expect(vi.mocked(scheduleFollowupDrain)).toHaveBeenCalledTimes(1);
    } finally {
      persistSpy.mockRestore();
    }
  });
});

describe("runReplyAgent pending final delivery capture", () => {
  async function createSessionStoreFile(entry: SessionEntry) {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-agent-runner-pending-"));
    const storePath = join(dir, "sessions.json");
    await writeFile(storePath, JSON.stringify({ main: entry }), "utf8");
    return storePath;
  }

  async function readStoredMainSession(storePath: string): Promise<SessionEntry> {
    const raw = await readFile(storePath, "utf8");
    return JSON.parse(raw).main as SessionEntry;
  }

  it("does not persist message-tool-only final replies for heartbeat replay", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore = { main: sessionEntry };
    const storePath = await createSessionStoreFile(sessionEntry);
    state.runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "private final" }],
      meta: {},
    });

    const { run } = createMinimalRun({
      opts: { sourceReplyDeliveryMode: "message_tool_only" },
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });

    await run();

    const stored = await readStoredMainSession(storePath);
    expect(stored.pendingFinalDelivery).toBeUndefined();
    expect(stored.pendingFinalDeliveryText).toBeUndefined();
  });

  it("does not persist sendPolicy-denied final replies for heartbeat replay", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sendPolicy: "deny",
    };
    const sessionStore = { main: sessionEntry };
    const storePath = await createSessionStoreFile(sessionEntry);
    state.runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "denied final" }],
      meta: {},
    });

    const { run } = createMinimalRun({
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });

    await run();

    const stored = await readStoredMainSession(storePath);
    expect(stored.pendingFinalDelivery).toBeUndefined();
    expect(stored.pendingFinalDeliveryText).toBeUndefined();
  });

  it("persists only visible non-reasoning final reply text", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore = { main: sessionEntry };
    const storePath = await createSessionStoreFile(sessionEntry);
    state.runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hidden reasoning", isReasoning: true }, { text: "visible final" }],
      meta: {},
    });

    const { run } = createMinimalRun({
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });

    await run();

    const stored = await readStoredMainSession(storePath);
    expect(stored.pendingFinalDelivery).toBe(true);
    expect(stored.pendingFinalDeliveryText).toBe("visible final");
  });
});

describe("runReplyAgent typing (heartbeat)", () => {
  it("signals typing for normal runs", async () => {
    const onPartialReply = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onPartialReply?.({ text: "hi" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: false, onPartialReply },
    });
    await run();

    expect(onPartialReply).toHaveBeenCalled();
    expect(typing.startTypingOnText).toHaveBeenCalledWith("hi");
    expect(typing.startTypingLoop).toHaveBeenCalled();
  });

  it("never signals typing for heartbeat runs", async () => {
    const onPartialReply = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onPartialReply?.({ text: "hi" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: true, onPartialReply },
    });
    await run();

    expect(onPartialReply).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("suppresses NO_REPLY partials but allows normal No-prefix partials", async () => {
    const cases = [
      {
        partials: ["NO_REPLY"],
        finalText: "NO_REPLY",
        expectedForwarded: [] as string[],
        shouldType: false,
      },
      {
        partials: ["NO", "NO_", "NO_RE", "NO_REPLY"],
        finalText: "NO_REPLY",
        expectedForwarded: [] as string[],
        shouldType: false,
      },
      {
        partials: ["No", "No, that is valid"],
        finalText: "No, that is valid",
        expectedForwarded: ["No", "No, that is valid"],
        shouldType: true,
      },
      {
        partials: ["NO_REPLYThe user is saying hello"],
        finalText: "NO_REPLYThe user is saying hello",
        expectedForwarded: ["The user is saying hello"],
        shouldType: true,
      },
    ] as const;

    for (const testCase of cases) {
      const onPartialReply = vi.fn();
      state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
        for (const text of testCase.partials) {
          await params.onPartialReply?.({ text });
        }
        return { payloads: [{ text: testCase.finalText }], meta: {} };
      });

      const { run, typing } = createMinimalRun({
        opts: { isHeartbeat: false, onPartialReply },
        typingMode: "message",
      });
      await run();

      if (testCase.expectedForwarded.length === 0) {
        expect(onPartialReply).not.toHaveBeenCalled();
      } else {
        expect(onPartialReply).toHaveBeenCalledTimes(testCase.expectedForwarded.length);
        testCase.expectedForwarded.forEach((text, index) => {
          expect(onPartialReply).toHaveBeenNthCalledWith(index + 1, {
            text,
            mediaUrls: undefined,
          });
        });
      }

      if (testCase.shouldType) {
        expect(typing.startTypingOnText).toHaveBeenCalled();
      } else {
        expect(typing.startTypingOnText).not.toHaveBeenCalled();
      }
      expect(typing.startTypingLoop).not.toHaveBeenCalled();
    }
  });

  it("suppresses narrated silent-turn partials, block replies, and final payloads", async () => {
    const onPartialReply = vi.fn();
    const onBlockReply = vi.fn();
    const onReasoningStream = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      expect(params.silentExpected).toBe(true);
      await params.onReasoningStream?.({ text: "Reasoning:\nI am trying to send NO_REPLY now." });
      await params.onPartialReply?.({ text: "I am trying to send NO_REPLY now." });
      await params.onBlockReply?.({ text: "I am trying to send NO_REPLY now." });
      return { payloads: [{ text: "I am trying to send NO_REPLY now." }], meta: {} };
    });

    const { run } = createMinimalRun({
      opts: { isHeartbeat: false, onPartialReply, onBlockReply, onReasoningStream },
      blockStreamingEnabled: true,
      runOverrides: { silentExpected: true },
    });
    const res = await run();

    expect(onReasoningStream).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(res).toBeUndefined();
  });

  it("suppresses bare NO_REPLY silent-turn payloads", async () => {
    const onPartialReply = vi.fn();
    const onBlockReply = vi.fn();
    const onReasoningStream = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      expect(params.silentExpected).toBe(true);
      await params.onReasoningStream?.({ text: "Reasoning:\nNO_REPLY" });
      await params.onPartialReply?.({ text: "NO_REPLY" });
      await params.onBlockReply?.({ text: "NO_REPLY" });
      return { payloads: [{ text: "NO_REPLY" }], meta: { finalAssistantText: "NO_REPLY" } };
    });

    const { run } = createMinimalRun({
      opts: { isHeartbeat: false, onPartialReply, onBlockReply, onReasoningStream },
      blockStreamingEnabled: true,
      runOverrides: { silentExpected: true },
    });
    const res = await run();

    expect(onReasoningStream).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(res).toBeUndefined();
  });

  it("does not start typing on assistant message start without prior text in message mode", async () => {
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onAssistantMessageStart?.();
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "message",
    });
    await run();

    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("starts typing from reasoning stream in thinking mode", async () => {
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onReasoningStream?.({ text: "Reasoning:\n_step_" });
      await params.onPartialReply?.({ text: "hi" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "thinking",
    });
    await run();

    expect(typing.startTypingLoop).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("keeps assistant partial streaming enabled when reasoning mode is stream", async () => {
    const onPartialReply = vi.fn();
    const onReasoningStream = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onReasoningStream?.({ text: "Reasoning:\n_step_" });
      await params.onPartialReply?.({ text: "answer chunk" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run } = createMinimalRun({
      opts: { onPartialReply, onReasoningStream },
      runOverrides: { reasoningLevel: "stream" },
    });
    await run();

    expect(onReasoningStream).toHaveBeenCalled();
    expect(onPartialReply).toHaveBeenCalledWith({ text: "answer chunk", mediaUrls: undefined });
  });

  it("suppresses typing in never mode", async () => {
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onPartialReply?.({ text: "hi" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "never",
    });
    await run();

    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("signals typing on normalized block replies", async () => {
    const onBlockReply = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onBlockReply?.({ text: "\n\nchunk", mediaUrls: [] });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "message",
      blockStreamingEnabled: true,
      opts: { onBlockReply },
    });
    await run();

    expect(typing.startTypingOnText).toHaveBeenCalledWith("chunk");
    expect(onBlockReply).toHaveBeenCalled();
    const [blockPayload, blockOpts] = onBlockReply.mock.calls[0] ?? [];
    expect(blockPayload).toMatchObject({ text: "chunk", audioAsVoice: false });
    expect(blockOpts).toMatchObject({
      abortSignal: expect.any(AbortSignal),
      timeoutMs: expect.any(Number),
    });
  });

  it("handles typing for normal and silent tool results", async () => {
    const cases = [
      {
        toolText: "tooling",
        shouldType: true,
        shouldForward: true,
      },
      {
        toolText: "NO_REPLY",
        shouldType: false,
        shouldForward: false,
      },
    ] as const;

    for (const testCase of cases) {
      const onToolResult = vi.fn();
      state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
        await params.onToolResult?.({ text: testCase.toolText, mediaUrls: [] });
        return { payloads: [{ text: "final" }], meta: {} };
      });

      const { run, typing } = createMinimalRun({
        typingMode: "message",
        opts: { onToolResult },
      });
      await run();

      if (testCase.shouldType) {
        expect(typing.startTypingOnText).toHaveBeenCalledWith(testCase.toolText);
      } else {
        expect(typing.startTypingOnText).not.toHaveBeenCalled();
      }

      if (testCase.shouldForward) {
        expect(onToolResult).toHaveBeenCalledWith({
          text: testCase.toolText,
          mediaUrls: [],
        });
      } else {
        expect(onToolResult).not.toHaveBeenCalled();
      }
    }
  });

  it("preserves channelData on forwarded tool results", async () => {
    const onToolResult = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onToolResult?.({
        text: "Approval required.\n\n```txt\n/approve 117ba06d allow-once\n```",
        channelData: {
          execApproval: {
            approvalId: "117ba06d-1111-2222-3333-444444444444",
            approvalSlug: "117ba06d",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run } = createMinimalRun({
      typingMode: "message",
      opts: { onToolResult },
    });
    await run();

    expect(onToolResult).toHaveBeenCalledWith({
      text: "Approval required.\n\n```txt\n/approve 117ba06d allow-once\n```",
      channelData: {
        execApproval: {
          approvalId: "117ba06d-1111-2222-3333-444444444444",
          approvalSlug: "117ba06d",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        },
      },
    });
  });

  it("forwards media-only tool results without typing text", async () => {
    const onToolResult = vi.fn();
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onToolResult?.({
        mediaUrls: ["/tmp/generated.png"],
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "message",
      opts: { onToolResult },
    });
    await run();

    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onToolResult.mock.calls[0]?.[0]).toMatchObject({
      mediaUrls: ["/tmp/generated.png"],
    });
    expect(onToolResult.mock.calls[0]?.[0]?.text).toBeUndefined();
  });

  it("retries transient HTTP failures once with timer-driven backoff", async () => {
    vi.useFakeTimers();
    let calls = 0;
    state.runEmbeddedPiAgentMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("502 Bad Gateway");
      }
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run } = createMinimalRun({
      typingMode: "message",
    });
    const runPromise = run();

    await vi.advanceTimersByTimeAsync(2_499);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await runPromise;
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it("announces model fallback only when verbose mode is enabled", async () => {
    const cases = [
      { name: "verbose on", verbose: "on" as const, expectNotice: true },
      { name: "verbose off", verbose: "off" as const, expectNotice: false },
    ] as const;
    for (const testCase of cases) {
      const sessionEntry: SessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
      };
      const sessionStore = { main: sessionEntry };
      state.runEmbeddedPiAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "final" }],
        meta: {},
      });
      vi.spyOn(modelFallbackModule, "runWithModelFallback").mockImplementationOnce(
        async ({ run }: { run: (provider: string, model: string) => Promise<unknown> }) => ({
          result: await run("deepinfra", "moonshotai/Kimi-K2.5"),
          provider: "deepinfra",
          model: "moonshotai/Kimi-K2.5",
          attempts: [
            {
              provider: "fireworks",
              model: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
              error: "Provider fireworks is in cooldown (all profiles unavailable)",
              reason: "rate_limit",
            },
          ],
        }),
      );

      const { run } = createMinimalRun({
        resolvedVerboseLevel: testCase.verbose,
        sessionEntry,
        sessionStore,
        sessionKey: "main",
      });
      const phases: string[] = [];
      const off = onAgentEvent((evt) => {
        const phase = typeof evt.data?.phase === "string" ? evt.data.phase : null;
        if (evt.stream === "lifecycle" && phase) {
          phases.push(phase);
        }
      });
      const res = await run();
      off();
      const payload = Array.isArray(res)
        ? (res[0] as { text?: string })
        : (res as { text?: string });
      if (testCase.expectNotice) {
        expect(payload.text, testCase.name).toContain("Model Fallback:");
        expect(payload.text, testCase.name).toContain("deepinfra/moonshotai/Kimi-K2.5");
        expect(sessionEntry.fallbackNoticeReason, testCase.name).toBe("rate limit");
        continue;
      }
      expect(payload.text, testCase.name).not.toContain("Model Fallback:");
      expect(
        phases.filter((phase) => phase === "fallback"),
        testCase.name,
      ).toHaveLength(1);
    }
  });

  it("announces model fallback only once per active fallback state", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore = { main: sessionEntry };

    state.runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "final" }],
      meta: {},
    });
    const fallbackSpy = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementation(
        async ({ run }: { run: (provider: string, model: string) => Promise<unknown> }) => ({
          result: await run("deepinfra", "moonshotai/Kimi-K2.5"),
          provider: "deepinfra",
          model: "moonshotai/Kimi-K2.5",
          attempts: [
            {
              provider: "fireworks",
              model: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
              error: "Provider fireworks is in cooldown (all profiles unavailable)",
              reason: "rate_limit",
            },
          ],
        }),
      );
    try {
      const { run } = createMinimalRun({
        resolvedVerboseLevel: "on",
        sessionEntry,
        sessionStore,
        sessionKey: "main",
      });
      const fallbackEvents: Array<Record<string, unknown>> = [];
      const off = onAgentEvent((evt) => {
        if (evt.stream === "lifecycle" && evt.data?.phase === "fallback") {
          fallbackEvents.push(evt.data);
        }
      });
      const first = await run();
      const second = await run();
      off();

      const firstText = Array.isArray(first) ? first[0]?.text : first?.text;
      const secondText = Array.isArray(second) ? second[0]?.text : second?.text;
      expect(firstText).toContain("Model Fallback:");
      expect(secondText).not.toContain("Model Fallback:");
      expect(fallbackEvents).toHaveLength(1);
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("re-announces model fallback after returning to selected model", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore = { main: sessionEntry };
    let callCount = 0;

    state.runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "final" }],
      meta: {},
    });
    const fallbackSpy = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementation(
        async ({
          provider,
          model,
          run,
        }: {
          provider: string;
          model: string;
          run: (provider: string, model: string) => Promise<unknown>;
        }) => {
          callCount += 1;
          if (callCount === 2) {
            return {
              result: await run(provider, model),
              provider,
              model,
              attempts: [],
            };
          }
          return {
            result: await run("deepinfra", "moonshotai/Kimi-K2.5"),
            provider: "deepinfra",
            model: "moonshotai/Kimi-K2.5",
            attempts: [
              {
                provider: "fireworks",
                model: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
                error: "Provider fireworks is in cooldown (all profiles unavailable)",
                reason: "rate_limit",
              },
            ],
          };
        },
      );
    try {
      const { run } = createMinimalRun({
        resolvedVerboseLevel: "on",
        sessionEntry,
        sessionStore,
        sessionKey: "main",
      });
      const first = await run();
      const second = await run();
      const third = await run();

      const firstText = Array.isArray(first) ? first[0]?.text : first?.text;
      const secondText = Array.isArray(second) ? second[0]?.text : second?.text;
      const thirdText = Array.isArray(third) ? third[0]?.text : third?.text;
      expect(firstText).toContain("Model Fallback:");
      expect(secondText).not.toContain("Model Fallback:");
      expect(thirdText).toContain("Model Fallback:");
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("announces fallback-cleared once when runtime returns to selected model", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore = { main: sessionEntry };
    let callCount = 0;

    state.runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "final" }],
      meta: {},
    });
    const fallbackSpy = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementation(
        async ({
          provider,
          model,
          run,
        }: {
          provider: string;
          model: string;
          run: (provider: string, model: string) => Promise<unknown>;
        }) => {
          callCount += 1;
          if (callCount === 1) {
            return {
              result: await run("deepinfra", "moonshotai/Kimi-K2.5"),
              provider: "deepinfra",
              model: "moonshotai/Kimi-K2.5",
              attempts: [
                {
                  provider: "fireworks",
                  model: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
                  error: "Provider fireworks is in cooldown (all profiles unavailable)",
                  reason: "rate_limit",
                },
              ],
            };
          }
          return {
            result: await run(provider, model),
            provider,
            model,
            attempts: [],
          };
        },
      );
    try {
      const { run } = createMinimalRun({
        resolvedVerboseLevel: "on",
        sessionEntry,
        sessionStore,
        sessionKey: "main",
      });
      const phases: string[] = [];
      const off = onAgentEvent((evt) => {
        const phase = typeof evt.data?.phase === "string" ? evt.data.phase : null;
        if (evt.stream === "lifecycle" && phase) {
          phases.push(phase);
        }
      });
      const first = await run();
      const second = await run();
      const third = await run();
      off();

      const firstText = Array.isArray(first) ? first[0]?.text : first?.text;
      const secondText = Array.isArray(second) ? second[0]?.text : second?.text;
      const thirdText = Array.isArray(third) ? third[0]?.text : third?.text;
      expect(firstText).toContain("Model Fallback:");
      expect(secondText).toContain("Model Fallback cleared:");
      expect(thirdText).not.toContain("Model Fallback cleared:");
      expect(phases.filter((phase) => phase === "fallback")).toHaveLength(1);
      expect(phases.filter((phase) => phase === "fallback_cleared")).toHaveLength(1);
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("emits fallback lifecycle events while verbose is off", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore = { main: sessionEntry };
    let callCount = 0;

    state.runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "final" }],
      meta: {},
    });
    const fallbackSpy = vi
      .spyOn(modelFallbackModule, "runWithModelFallback")
      .mockImplementation(
        async ({
          provider,
          model,
          run,
        }: {
          provider: string;
          model: string;
          run: (provider: string, model: string) => Promise<unknown>;
        }) => {
          callCount += 1;
          if (callCount === 1) {
            return {
              result: await run("deepinfra", "moonshotai/Kimi-K2.5"),
              provider: "deepinfra",
              model: "moonshotai/Kimi-K2.5",
              attempts: [
                {
                  provider: "fireworks",
                  model: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
                  error: "Provider fireworks is in cooldown (all profiles unavailable)",
                  reason: "rate_limit",
                },
              ],
            };
          }
          return {
            result: await run(provider, model),
            provider,
            model,
            attempts: [],
          };
        },
      );
    try {
      const { run } = createMinimalRun({
        resolvedVerboseLevel: "off",
        sessionEntry,
        sessionStore,
        sessionKey: "main",
      });
      const phases: string[] = [];
      const off = onAgentEvent((evt) => {
        const phase = typeof evt.data?.phase === "string" ? evt.data.phase : null;
        if (evt.stream === "lifecycle" && phase) {
          phases.push(phase);
        }
      });
      const first = await run();
      const second = await run();
      off();

      const firstText = Array.isArray(first) ? first[0]?.text : first?.text;
      const secondText = Array.isArray(second) ? second[0]?.text : second?.text;
      expect(firstText).not.toContain("Model Fallback:");
      expect(secondText).not.toContain("Model Fallback cleared:");
      expect(phases.filter((phase) => phase === "fallback")).toHaveLength(1);
      expect(phases.filter((phase) => phase === "fallback_cleared")).toHaveLength(1);
    } finally {
      fallbackSpy.mockRestore();
    }
  });

  it("updates fallback reason summary while fallback stays active", async () => {
    const cases = [
      {
        existingReason: undefined,
        reportedReason: "rate_limit",
        expectedReason: "rate limit",
      },
      {
        existingReason: undefined,
        reportedReason: "overloaded",
        expectedReason: "overloaded",
      },
      {
        existingReason: "rate limit",
        reportedReason: "timeout",
        expectedReason: "timeout",
      },
    ] as const;

    for (const testCase of cases) {
      const sessionEntry: SessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        fallbackNoticeSelectedModel: "anthropic/claude",
        fallbackNoticeActiveModel: "deepinfra/moonshotai/Kimi-K2.5",
        ...(testCase.existingReason ? { fallbackNoticeReason: testCase.existingReason } : {}),
        modelProvider: "deepinfra",
        model: "moonshotai/Kimi-K2.5",
      };
      const sessionStore = { main: sessionEntry };

      state.runEmbeddedPiAgentMock.mockResolvedValue({
        payloads: [{ text: "final" }],
        meta: {},
      });
      const fallbackSpy = vi
        .spyOn(modelFallbackModule, "runWithModelFallback")
        .mockImplementation(
          async ({ run }: { run: (provider: string, model: string) => Promise<unknown> }) => ({
            result: await run("deepinfra", "moonshotai/Kimi-K2.5"),
            provider: "deepinfra",
            model: "moonshotai/Kimi-K2.5",
            attempts: [
              {
                provider: "anthropic",
                model: "claude",
                error: "Provider anthropic is in cooldown (all profiles unavailable)",
                reason: testCase.reportedReason,
              },
            ],
          }),
        );
      try {
        const { run } = createMinimalRun({
          resolvedVerboseLevel: "on",
          sessionEntry,
          sessionStore,
          sessionKey: "main",
        });
        const res = await run();
        const firstText = Array.isArray(res) ? res[0]?.text : res?.text;
        expect(firstText).not.toContain("Model Fallback:");
        expect(sessionEntry.fallbackNoticeReason).toBe(testCase.expectedReason);
      } finally {
        fallbackSpy.mockRestore();
      }
    }
  });

  it("surfaces overflow fallback when embedded run returns empty payloads", async () => {
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => ({
      payloads: [],
      meta: {
        durationMs: 1,
        error: {
          kind: "context_overflow",
          message: 'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
        },
      },
    }));

    const { run } = createMinimalRun();
    const res = await run();
    const payload = Array.isArray(res) ? res[0] : res;
    expect(payload).toMatchObject({
      text: expect.stringContaining("conversation is too large"),
    });
    if (!payload) {
      throw new Error("expected payload");
    }
    expect(payload.text).toContain("/new");
  });

  it("surfaces overflow fallback when embedded payload text is whitespace-only", async () => {
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => ({
      payloads: [{ text: "   \n\t  ", isError: true }],
      meta: {
        durationMs: 1,
        error: {
          kind: "context_overflow",
          message: 'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
        },
      },
    }));

    const { run } = createMinimalRun();
    const res = await run();
    const payload = Array.isArray(res) ? res[0] : res;
    expect(payload).toMatchObject({
      text: expect.stringContaining("conversation is too large"),
    });
    if (!payload) {
      throw new Error("expected payload");
    }
    expect(payload.text).toContain("/new");
  });

  it("returns friendly message for role ordering errors thrown as exceptions", async () => {
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
      throw new Error("400 Incorrect role information");
    });

    const { run } = createMinimalRun({});
    const res = await run();

    expect(res).toMatchObject({
      text: expect.stringContaining("Message ordering conflict"),
    });
    expect(res).toMatchObject({
      text: expect.not.stringContaining("400"),
    });
  });

  it("rewrites Bun socket errors into friendly text", async () => {
    state.runEmbeddedPiAgentMock.mockImplementationOnce(async () => ({
      payloads: [
        {
          text: "TypeError: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
          isError: true,
        },
      ],
      meta: {},
    }));

    const { run } = createMinimalRun();
    const res = await run();
    const payloads = Array.isArray(res) ? res : res ? [res] : [];
    expect(payloads.length).toBe(1);
    expect(payloads[0]?.text).toContain("LLM connection failed");
    expect(payloads[0]?.text).toContain("socket connection was closed unexpectedly");
    expect(payloads[0]?.text).toContain("```");
  });
});

import type { ReplyPayload } from "../types.js";
