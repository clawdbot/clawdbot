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
import { resetLogger, setLoggerOverride } from "../logging.js";
import { HEARTBEAT_TOKEN, monitorWebChannel } from "./auto-reply.js";
import { resetBaileysMocks, resetLoadConfigMock, setLoadConfigMock } from "./test-helpers.js";

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

describe("web auto-reply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBaileysMocks();
    resetLoadConfigMock();
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
  });

  it("prefixes body with same-phone marker when from === to", async () => {
    // Enable messagePrefix for same-phone mode testing
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {
        messagePrefix: "[same-phone]",
        responsePrefix: undefined,
      },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "reply" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1555",
      to: "+1555", // Same phone!
      id: "msg1",
      sendComposing: vi.fn(),
      reply: vi.fn(),
      sendMedia: vi.fn(),
    });

    // The resolver should receive a prefixed body with the configured marker
    const callArg = resolver.mock.calls[0]?.[0] as { Body?: string };
    expect(callArg?.Body).toBeDefined();
    expect(callArg?.Body).toContain("[WhatsApp +1555");
    expect(callArg?.Body).toContain("[same-phone] hello");
    resetLoadConfigMock();
  });
  it("does not prefix body when from !== to", async () => {
    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "reply" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1555",
      to: "+2666", // Different phones
      id: "msg1",
      sendComposing: vi.fn(),
      reply: vi.fn(),
      sendMedia: vi.fn(),
    });

    // Body should include envelope but not the same-phone prefix
    const callArg = resolver.mock.calls[0]?.[0] as { Body?: string };
    expect(callArg?.Body).toContain("[WhatsApp +1555");
    expect(callArg?.Body).toContain("hello");
  });
  it("forwards reply-to context to resolver", async () => {
    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "reply" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      replyToId: "q1",
      replyToBody: "original",
      replyToSender: "+1999",
      sendComposing: vi.fn(),
      reply: vi.fn(),
      sendMedia: vi.fn(),
    });

    const callArg = resolver.mock.calls[0]?.[0] as {
      ReplyToId?: string;
      ReplyToBody?: string;
      ReplyToSender?: string;
      Body?: string;
    };
    expect(callArg.ReplyToId).toBe("q1");
    expect(callArg.ReplyToBody).toBe("original");
    expect(callArg.ReplyToSender).toBe("+1999");
    expect(callArg.Body).toContain("[Replying to +1999 id:q1]");
    expect(callArg.Body).toContain("original");
  });
  it("applies responsePrefix to regular replies", async () => {
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: "🦞",
      },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const reply = vi.fn();
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "hello there" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hi",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    // Reply should have responsePrefix prepended
    expect(reply).toHaveBeenCalledWith("🦞 hello there");
    resetLoadConfigMock();
  });
  it("defaults responsePrefix for self-chat replies when unset", async () => {
    setLoadConfigMock(() => ({
      agents: {
        list: [
          {
            id: "main",
            default: true,
            identity: { name: "Mainbot", emoji: "🦞", theme: "space lobster" },
          },
        ],
      },
      channels: { whatsapp: { allowFrom: ["+1555"] } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const reply = vi.fn();
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "hello there" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hi",
      from: "+1555",
      to: "+1555",
      selfE164: "+1555",
      chatType: "direct",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    expect(reply).toHaveBeenCalledWith("[Mainbot] hello there");
    resetLoadConfigMock();
  });
  it("does not deliver HEARTBEAT_OK responses", async () => {
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: "🦞",
      },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const reply = vi.fn();
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    // Resolver returns exact HEARTBEAT_OK
    const resolver = vi.fn().mockResolvedValue({ text: HEARTBEAT_TOKEN });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "test",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    expect(reply).not.toHaveBeenCalled();
    resetLoadConfigMock();
  });
  it("does not double-prefix if responsePrefix already present", async () => {
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: "🦞",
      },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const reply = vi.fn();
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    // Resolver returns text that already has prefix
    const resolver = vi.fn().mockResolvedValue({ text: "🦞 already prefixed" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "test",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    // Should not double-prefix
    expect(reply).toHaveBeenCalledWith("🦞 already prefixed");
    resetLoadConfigMock();
  });
});
