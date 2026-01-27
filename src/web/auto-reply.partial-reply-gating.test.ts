import "./test-helpers.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { MoltbotConfig } from "../config/config.js";
import { monitorWebChannel } from "./auto-reply.js";
import { resetLoadConfigMock, setLoadConfigMock } from "./test-helpers.js";

let previousHome: string | undefined;
let tempHome: string | undefined;

const rmDirWithRetries = async (dir: string): Promise<void> => {
  // Some tests can leave async session-store writes in-flight; recursive deletion can race and throw ENOTEMPTY.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;
      if (code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      throw err;
    }
  }

  await fs.rm(dir, { recursive: true, force: true });
};

beforeEach(async () => {
  resetInboundDedupe();
  previousHome = process.env.HOME;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-web-home-"));
  process.env.HOME = tempHome;
});

afterEach(async () => {
  process.env.HOME = previousHome;
  if (tempHome) {
    await rmDirWithRetries(tempHome);
    tempHome = undefined;
  }
});

const makeSessionStore = async (
  entries: Record<string, unknown> = {},
): Promise<{ storePath: string; cleanup: () => Promise<void> }> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-session-"));
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(storePath, JSON.stringify(entries));
  const cleanup = async () => {
    // Session store writes can be in-flight when the test finishes (e.g. updateLastRoute
    // after a message flush). `fs.rm({ recursive })` can race and throw ENOTEMPTY.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        return;
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: unknown }).code)
            : null;
        if (code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM") {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        throw err;
      }
    }

    await fs.rm(dir, { recursive: true, force: true });
  };
  return {
    storePath,
    cleanup,
  };
};

describe("partial reply gating", () => {
  it("does not send partial replies for WhatsApp provider", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn().mockResolvedValue(undefined);
    const sendMedia = vi.fn().mockResolvedValue(undefined);

    const replyResolver = vi.fn().mockResolvedValue({ text: "final reply" });

    const mockConfig: MoltbotConfig = {
      channels: { whatsapp: { allowFrom: ["*"] } },
    };

    setLoadConfigMock(mockConfig);

    await monitorWebChannel(
      false,
      async ({ onMessage }) => {
        await onMessage({
          id: "m1",
          from: "+1000",
          conversationId: "+1000",
          to: "+2000",
          body: "hello",
          timestamp: Date.now(),
          chatType: "direct",
          chatId: "direct:+1000",
          sendComposing,
          reply,
          sendMedia,
        });
        return { close: vi.fn().mockResolvedValue(undefined) };
      },
      false,
      replyResolver,
    );

    resetLoadConfigMock();

    expect(replyResolver).toHaveBeenCalledTimes(1);
    const resolverOptions = replyResolver.mock.calls[0]?.[1] ?? {};
    expect("onPartialReply" in resolverOptions).toBe(false);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith("final reply");
  });
  it("falls back from empty senderJid to senderE164 for SenderId", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn().mockResolvedValue(undefined);
    const sendMedia = vi.fn().mockResolvedValue(undefined);

    const replyResolver = vi.fn().mockResolvedValue({ text: "final reply" });

    const mockConfig: MoltbotConfig = {
      channels: {
        whatsapp: {
          allowFrom: ["*"],
        },
      },
    };

    setLoadConfigMock(mockConfig);

    await monitorWebChannel(
      false,
      async ({ onMessage }) => {
        await onMessage({
          id: "m1",
          from: "+1000",
          conversationId: "+1000",
          to: "+2000",
          body: "hello",
          timestamp: Date.now(),
          chatType: "direct",
          chatId: "direct:+1000",
          senderJid: "",
          senderE164: "+1000",
          sendComposing,
          reply,
          sendMedia,
        });
        return { close: vi.fn().mockResolvedValue(undefined) };
      },
      false,
      replyResolver,
    );

    resetLoadConfigMock();

    expect(replyResolver).toHaveBeenCalledTimes(1);
    const ctx = replyResolver.mock.calls[0]?.[0] ?? {};
    expect(ctx.SenderE164).toBe("+1000");
    expect(ctx.SenderId).toBe("+1000");
  });
  it("updates last-route for direct chats without senderE164", async () => {
    const now = Date.now();
    const mainSessionKey = "agent:main:main";
    const store = await makeSessionStore({
      [mainSessionKey]: { sessionId: "sid", updatedAt: now - 1 },
    });

    const replyResolver = vi.fn().mockResolvedValue(undefined);

    const mockConfig: MoltbotConfig = {
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: store.storePath },
    };

    setLoadConfigMock(mockConfig);

    await monitorWebChannel(
      false,
      async ({ onMessage }) => {
        await onMessage({
          id: "m1",
          from: "+1000",
          conversationId: "+1000",
          to: "+2000",
          body: "hello",
          timestamp: now,
          chatType: "direct",
          chatId: "direct:+1000",
          sendComposing: vi.fn().mockResolvedValue(undefined),
          reply: vi.fn().mockResolvedValue(undefined),
          sendMedia: vi.fn().mockResolvedValue(undefined),
        });
        return { close: vi.fn().mockResolvedValue(undefined) };
      },
      false,
      replyResolver,
    );

    let stored: Record<string, { lastChannel?: string; lastTo?: string }> | null = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      stored = JSON.parse(await fs.readFile(store.storePath, "utf8")) as Record<
        string,
        { lastChannel?: string; lastTo?: string }
      >;
      if (stored[mainSessionKey]?.lastChannel && stored[mainSessionKey]?.lastTo) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!stored) throw new Error("store not loaded");
    expect(stored[mainSessionKey]?.lastChannel).toBe("whatsapp");
    expect(stored[mainSessionKey]?.lastTo).toBe("+1000");

    resetLoadConfigMock();
    await store.cleanup();
  });
  it("updates last-route for group chats with account id", async () => {
    const now = Date.now();
    const groupSessionKey = "agent:main:whatsapp:group:123@g.us";
    const store = await makeSessionStore({
      [groupSessionKey]: { sessionId: "sid", updatedAt: now - 1 },
    });

    const replyResolver = vi.fn().mockResolvedValue(undefined);

    const mockConfig: MoltbotConfig = {
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: store.storePath },
    };

    setLoadConfigMock(mockConfig);

    await monitorWebChannel(
      false,
      async ({ onMessage }) => {
        await onMessage({
          id: "g1",
          from: "123@g.us",
          conversationId: "123@g.us",
          to: "+2000",
          body: "hello",
          timestamp: now,
          chatType: "group",
          chatId: "123@g.us",
          accountId: "work",
          senderE164: "+1000",
          senderName: "Alice",
          selfE164: "+2000",
          sendComposing: vi.fn().mockResolvedValue(undefined),
          reply: vi.fn().mockResolvedValue(undefined),
          sendMedia: vi.fn().mockResolvedValue(undefined),
        });
        return { close: vi.fn().mockResolvedValue(undefined) };
      },
      false,
      replyResolver,
    );

    let stored: Record<
      string,
      { lastChannel?: string; lastTo?: string; lastAccountId?: string }
    > | null = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      stored = JSON.parse(await fs.readFile(store.storePath, "utf8")) as Record<
        string,
        { lastChannel?: string; lastTo?: string; lastAccountId?: string }
      >;
      if (
        stored[groupSessionKey]?.lastChannel &&
        stored[groupSessionKey]?.lastTo &&
        stored[groupSessionKey]?.lastAccountId
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!stored) throw new Error("store not loaded");
    expect(stored[groupSessionKey]?.lastChannel).toBe("whatsapp");
    expect(stored[groupSessionKey]?.lastTo).toBe("123@g.us");
    expect(stored[groupSessionKey]?.lastAccountId).toBe("work");

    resetLoadConfigMock();
    await store.cleanup();
  });
  it("defaults to self-only when no config is present", async () => {
    vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {
        durationMs: 1,
        agentMeta: { sessionId: "s", provider: "p", model: "m" },
      },
    });

    // Not self: should be blocked
    const blocked = await getReplyFromConfig(
      {
        Body: "hi",
        From: "whatsapp:+999",
        To: "whatsapp:+123",
      },
      undefined,
      {},
    );
    expect(blocked).toBeUndefined();
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();

    // Self: should be allowed
    const allowed = await getReplyFromConfig(
      {
        Body: "hi",
        From: "whatsapp:+123",
        To: "whatsapp:+123",
      },
      undefined,
      {},
    );
    expect(allowed).toMatchObject({ text: "ok", audioAsVoice: false });
    expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
  });
});
