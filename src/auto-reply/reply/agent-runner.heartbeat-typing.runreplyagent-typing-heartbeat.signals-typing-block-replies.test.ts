import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
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
  it("signals typing on block replies", async () => {
    const onBlockReply = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedPiAgentParams) => {
      await params.onBlockReply?.({ text: "chunk", mediaUrls: [] });
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
  it("signals typing on tool results", async () => {
    const onToolResult = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedPiAgentParams) => {
      await params.onToolResult?.({ text: "tooling", mediaUrls: [] });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "message",
      opts: { onToolResult },
    });
    await run();

    expect(typing.startTypingOnText).toHaveBeenCalledWith("tooling");
    expect(onToolResult).toHaveBeenCalledWith({
      text: "tooling",
      mediaUrls: [],
    });
  });
  it("skips typing for silent tool results", async () => {
    const onToolResult = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedPiAgentParams) => {
      await params.onToolResult?.({ text: "NO_REPLY", mediaUrls: [] });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "message",
      opts: { onToolResult },
    });
    await run();

    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(onToolResult).not.toHaveBeenCalled();
  });
  it("announces auto-compaction in verbose mode and tracks count", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "moltbot-compaction-")),
      "sessions.json",
    );
    const sessionEntry = { sessionId: "session", updatedAt: Date.now() };
    const sessionStore = { main: sessionEntry };

    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: {
        onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
      }) => {
        params.onAgentEvent?.({
          stream: "compaction",
          data: { phase: "end", willRetry: false },
        });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run } = createMinimalRun({
      resolvedVerboseLevel: "on",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    const res = await run();
    expect(Array.isArray(res)).toBe(true);
    const payloads = res as { text?: string }[];
    expect(payloads[0]?.text).toContain("Auto-compaction complete");
    expect(payloads[0]?.text).toContain("count 1");
    expect(sessionStore.main.compactionCount).toBe(1);
  });
});
