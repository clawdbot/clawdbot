import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();

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
  }),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("./queue.js", async () => {
  const actual =
    await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
  };
});

import { runReplyAgent } from "./agent-runner.js";

function createMinimalRun(params?: {
  opts?: GetReplyOptions;
  resolvedVerboseLevel?: "off" | "on";
  sessionStore?: Record<string, SessionEntry>;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
  typingMode?: TypingMode;
  blockStreamingEnabled?: boolean;
}) {
  const typing = createMockTypingController();
  const opts = params?.opts;
  const sessionCtx = {
    Provider: "whatsapp",
    MessageSid: "msg",
  } as unknown as TemplateContext;
  const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
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
    },
  } as unknown as FollowupRun;

  return {
    typing,
    opts,
    run: () =>
      runReplyAgent({
        commandBody: "hello",
        followupRun,
        queueKey: "main",
        resolvedQueue,
        shouldSteer: false,
        shouldFollowup: false,
        isActive: false,
        isStreaming: false,
        opts,
        typing,
        sessionEntry: params?.sessionEntry,
        sessionStore: params?.sessionStore,
        sessionKey,
        storePath: params?.storePath,
        sessionCtx,
        defaultModel: "anthropic/claude-opus-4-5",
        resolvedVerboseLevel: params?.resolvedVerboseLevel ?? "off",
        isNewSession: false,
        blockStreamingEnabled: params?.blockStreamingEnabled ?? false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: params?.typingMode ?? "instant",
      }),
  };
}

describe("runReplyAgent typing (heartbeat)", () => {
  it("signals typing for normal runs", async () => {
    const onPartialReply = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: EmbeddedPiAgentParams) => {
        await params.onPartialReply?.({ text: "hi" });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: false, onPartialReply },
    });
    await run();

    expect(onPartialReply).toHaveBeenCalled();
    expect(typing.startTypingOnText).toHaveBeenCalledWith("hi");
    expect(typing.startTypingLoop).toHaveBeenCalled();
  });
  it("signals typing even without consumer partial handler", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: EmbeddedPiAgentParams) => {
        await params.onPartialReply?.({ text: "hi" });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      typingMode: "message",
    });
    await run();

    expect(typing.startTypingOnText).toHaveBeenCalledWith("hi");
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });
  it("never signals typing for heartbeat runs", async () => {
    const onPartialReply = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: EmbeddedPiAgentParams) => {
        await params.onPartialReply?.({ text: "hi" });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: true, onPartialReply },
    });
    await run();

    expect(onPartialReply).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });
  it("suppresses partial streaming for NO_REPLY", async () => {
    const onPartialReply = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: EmbeddedPiAgentParams) => {
        await params.onPartialReply?.({ text: "NO_REPLY" });
        return { payloads: [{ text: "NO_REPLY" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: false, onPartialReply },
    });
    await run();

    expect(onPartialReply).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });
  it("starts typing on assistant message start in message mode", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: EmbeddedPiAgentParams) => {
        await params.onAssistantMessageStart?.();
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      typingMode: "message",
    });
    await run();

    expect(typing.startTypingLoop).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });
  it("starts typing from reasoning stream in thinking mode", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: {
        onPartialReply?: (payload: { text?: string }) => Promise<void> | void;
        onReasoningStream?: (payload: {
          text?: string;
        }) => Promise<void> | void;
      }) => {
        await params.onReasoningStream?.({ text: "Reasoning:\n_step_" });
        await params.onPartialReply?.({ text: "hi" });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      typingMode: "thinking",
    });
    await run();

    expect(typing.startTypingLoop).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });
  it("suppresses typing in never mode", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: {
        onPartialReply?: (payload: { text?: string }) => void;
      }) => {
        params.onPartialReply?.({ text: "hi" });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      typingMode: "never",
    });
    await run();

    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });
});
