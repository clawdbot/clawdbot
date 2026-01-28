import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import * as sessions from "../../config/sessions.js";
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
  it("resets corrupted Gemini sessions and deletes transcripts", async () => {
    const prevStateDir = process.env.CLAWDBOT_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(tmpdir(), "moltbot-session-reset-"));
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    try {
      const sessionId = "session-corrupt";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const sessionEntry = { sessionId, updatedAt: Date.now() };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");

      const transcriptPath = sessions.resolveSessionTranscriptPath(sessionId);
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "bad", "utf-8");

      runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
        throw new Error(
          "function call turn comes immediately after a user turn or after a function response turn",
        );
      });

      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();

      expect(res).toMatchObject({
        text: expect.stringContaining("Session history was corrupted"),
      });
      expect(sessionStore.main).toBeUndefined();
      await expect(fs.access(transcriptPath)).rejects.toThrow();

      const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(persisted.main).toBeUndefined();
    } finally {
      if (prevStateDir) {
        process.env.CLAWDBOT_STATE_DIR = prevStateDir;
      } else {
        delete process.env.CLAWDBOT_STATE_DIR;
      }
    }
  });
  it("keeps sessions intact on other errors", async () => {
    const prevStateDir = process.env.CLAWDBOT_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(tmpdir(), "moltbot-session-noreset-"));
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    try {
      const sessionId = "session-ok";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const sessionEntry = { sessionId, updatedAt: Date.now() };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");

      const transcriptPath = sessions.resolveSessionTranscriptPath(sessionId);
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "ok", "utf-8");

      runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
        throw new Error("INVALID_ARGUMENT: some other failure");
      });

      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();

      expect(res).toMatchObject({
        text: expect.stringContaining("Agent failed before reply"),
      });
      expect(sessionStore.main).toBeDefined();
      await expect(fs.access(transcriptPath)).resolves.toBeUndefined();

      const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(persisted.main).toBeDefined();
    } finally {
      if (prevStateDir) {
        process.env.CLAWDBOT_STATE_DIR = prevStateDir;
      } else {
        delete process.env.CLAWDBOT_STATE_DIR;
      }
    }
  });
  it("returns friendly message for role ordering errors thrown as exceptions", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
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
  it("returns friendly message for 'roles must alternate' errors thrown as exceptions", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
      throw new Error('messages: roles must alternate between "user" and "assistant"');
    });

    const { run } = createMinimalRun({});
    const res = await run();

    expect(res).toMatchObject({
      text: expect.stringContaining("Message ordering conflict"),
    });
  });
});
