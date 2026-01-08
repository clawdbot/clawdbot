import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { getReplyFromConfig } from "./reply.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) =>
    `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-stream-"));
  const previousHome = process.env.HOME;
  process.env.HOME = base;
  try {
    return await fn(base);
  } finally {
    process.env.HOME = previousHome;
    await fs.rm(base, { recursive: true, force: true });
  }
}

describe("block streaming", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([
      { id: "claude-opus-4-5", name: "Opus 4.5", provider: "anthropic" },
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
    ]);
  });

  async function waitForCalls(fn: () => number, calls: number) {
    const deadline = Date.now() + 1500;
    while (fn() < calls) {
      if (Date.now() > deadline) {
        throw new Error(`Expected ${calls} call(s), got ${fn()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("waits for block replies before returning final payloads", async () => {
    await withTempHome(async (home) => {
      let releaseTyping: (() => void) | undefined;
      const typingGate = new Promise<void>((resolve) => {
        releaseTyping = resolve;
      });
      const onReplyStart = vi.fn(() => typingGate);
      const onBlockReply = vi.fn().mockResolvedValue(undefined);

      vi.mocked(runEmbeddedPiAgent).mockImplementation(async (params) => {
        void params.onBlockReply?.({ text: "hello" });
        return {
          payloads: [{ text: "hello" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "s", provider: "p", model: "m" },
          },
        };
      });

      const replyPromise = getReplyFromConfig(
        {
          Body: "ping",
          From: "+1004",
          To: "+2000",
          MessageSid: "msg-123",
          Provider: "discord",
        },
        {
          onReplyStart,
          onBlockReply,
        },
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
          },
          whatsapp: { allowFrom: ["*"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      await waitForCalls(() => onReplyStart.mock.calls.length, 1);
      releaseTyping?.();

      const res = await replyPromise;
      expect(res).toBeUndefined();
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
  });

  it("preserves block reply ordering when typing start is slow", async () => {
    await withTempHome(async (home) => {
      let releaseTyping: (() => void) | undefined;
      const typingGate = new Promise<void>((resolve) => {
        releaseTyping = resolve;
      });
      const onReplyStart = vi.fn(() => typingGate);
      const seen: string[] = [];
      const onBlockReply = vi.fn(async (payload) => {
        seen.push(payload.text ?? "");
      });

      vi.mocked(runEmbeddedPiAgent).mockImplementation(async (params) => {
        void params.onBlockReply?.({ text: "first" });
        void params.onBlockReply?.({ text: "second" });
        return {
          payloads: [{ text: "first" }, { text: "second" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "s", provider: "p", model: "m" },
          },
        };
      });

      const replyPromise = getReplyFromConfig(
        {
          Body: "ping",
          From: "+1004",
          To: "+2000",
          MessageSid: "msg-125",
          Provider: "telegram",
        },
        {
          onReplyStart,
          onBlockReply,
        },
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
          },
          telegram: { allowFrom: ["*"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      await waitForCalls(() => onReplyStart.mock.calls.length, 1);
      releaseTyping?.();

      const res = await replyPromise;
      expect(res).toBeUndefined();
      expect(seen).toEqual(["first", "second"]);
    });
  });

  it("drops final payloads when block replies streamed", async () => {
    await withTempHome(async (home) => {
      const onBlockReply = vi.fn().mockResolvedValue(undefined);

      vi.mocked(runEmbeddedPiAgent).mockImplementation(async (params) => {
        void params.onBlockReply?.({ text: "chunk-1" });
        return {
          payloads: [{ text: "chunk-1\nchunk-2" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "s", provider: "p", model: "m" },
          },
        };
      });

      const res = await getReplyFromConfig(
        {
          Body: "ping",
          From: "+1004",
          To: "+2000",
          MessageSid: "msg-124",
          Provider: "discord",
        },
        {
          onBlockReply,
        },
        {
          agent: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "clawd"),
          },
          whatsapp: { allowFrom: ["*"] },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      expect(res).toBeUndefined();
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
  });
});
