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

import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
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

const _makeSessionStore = async (
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

describe("broadcast groups", () => {
  it("broadcasts sequentially in configured order", async () => {
    setLoadConfigMock({
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        strategy: "sequential",
        "+1000": ["alfred", "baerbel"],
      },
    } satisfies MoltbotConfig);

    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const seen: string[] = [];
    const resolver = vi.fn(async (ctx: { SessionKey?: unknown }) => {
      seen.push(String(ctx.SessionKey));
      return { text: "ok" };
    });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
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

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(seen[0]).toContain("agent:alfred:");
    expect(seen[1]).toContain("agent:baerbel:");
    resetLoadConfigMock();
  });
  it("shares group history across broadcast agents and clears after replying", async () => {
    setLoadConfigMock({
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        strategy: "sequential",
        "123@g.us": ["alfred", "baerbel"],
      },
    } satisfies MoltbotConfig);

    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello group",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g1",
      senderE164: "+111",
      senderName: "Alice",
      selfE164: "+999",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).not.toHaveBeenCalled();

    await capturedOnMessage?.({
      body: "@bot ping",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g2",
      senderE164: "+222",
      senderName: "Bob",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).toHaveBeenCalledTimes(2);
    for (const call of resolver.mock.calls.slice(0, 2)) {
      const payload = call[0] as {
        Body: string;
        SenderName?: string;
        SenderE164?: string;
        SenderId?: string;
      };
      expect(payload.Body).toContain("Chat messages since your last reply");
      expect(payload.Body).toContain("Alice (+111): hello group");
      expect(payload.Body).toContain("[message_id: g1]");
      expect(payload.Body).toContain("@bot ping");
      expect(payload.SenderName).toBe("Bob");
      expect(payload.SenderE164).toBe("+222");
      expect(payload.SenderId).toBe("+222");
    }

    await capturedOnMessage?.({
      body: "@bot ping 2",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g3",
      senderE164: "+333",
      senderName: "Clara",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).toHaveBeenCalledTimes(4);
    for (const call of resolver.mock.calls.slice(2, 4)) {
      const payload = call[0] as { Body: string };
      expect(payload.Body).not.toContain("Alice (+111): hello group");
      expect(payload.Body).not.toContain("Chat messages since your last reply");
    }

    resetLoadConfigMock();
  });
  it("broadcasts in parallel by default", async () => {
    setLoadConfigMock({
      channels: { whatsapp: { allowFrom: ["*"] } },
      agents: {
        defaults: { maxConcurrent: 10 },
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        strategy: "parallel",
        "+1000": ["alfred", "baerbel"],
      },
    } satisfies MoltbotConfig);

    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();

    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const resolver = vi.fn(async () => {
      started += 1;
      if (started < 2) {
        await gate;
      } else {
        release?.();
      }
      return { text: "ok" };
    });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
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

    expect(resolver).toHaveBeenCalledTimes(2);
    resetLoadConfigMock();
  });
});
