import crypto from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { redactIdentifier } from "openclaw/plugin-sdk/logging-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveWebListener } from "./inbound/types.js";

const hoisted = vi.hoisted(() => ({
  loadOutboundMediaFromUrl: vi.fn(),
  controllerListeners: new Map<string, ActiveWebListener>(),
}));
const loadWebMediaMock = vi.fn();
let sendMessageWhatsApp: typeof import("./send.js").sendMessageWhatsApp;
let sendPollWhatsApp: typeof import("./send.js").sendPollWhatsApp;
let sendReactionWhatsApp: typeof import("./send.js").sendReactionWhatsApp;
let resetLogger: typeof import("openclaw/plugin-sdk/runtime-env").resetLogger;
let setLoggerOverride: typeof import("openclaw/plugin-sdk/runtime-env").setLoggerOverride;

const WHATSAPP_TEST_CFG: OpenClawConfig = {
  channels: { whatsapp: {} },
};

vi.mock("./connection-controller-registry.js", async () => {
  const actual = await vi.importActual<typeof import("./connection-controller-registry.js")>(
    "./connection-controller-registry.js",
  );
  return {
    ...actual,
    getRegisteredWhatsAppConnectionController: vi.fn((accountId: string) => {
      const listener = hoisted.controllerListeners.get(accountId) ?? null;
      return listener
        ? {
            getActiveListener: () => listener,
          }
        : null;
    }),
  };
});

vi.mock("./outbound-media.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./outbound-media.runtime.js")>(
    "./outbound-media.runtime.js",
  );
  return {
    ...actual,
    loadOutboundMediaFromUrl: hoisted.loadOutboundMediaFromUrl,
  };
});

vi.mock("./text-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./text-runtime.js")>("./text-runtime.js");
  return {
    ...actual,
    sleep: vi.fn(async () => {}),
  };
});

describe("web outbound", () => {
  const sendComposingTo = vi.fn(async () => {});
  const sendMessage = vi.fn(async () => ({ messageId: "msg123" }));
  const sendPoll = vi.fn(async () => ({ messageId: "poll123" }));
  const sendReaction = vi.fn(async () => {});

  beforeAll(async () => {
    ({ sendMessageWhatsApp, sendPollWhatsApp, sendReactionWhatsApp } = await import("./send.js"));
    ({ resetLogger, setLoggerOverride } = await import("openclaw/plugin-sdk/runtime-env"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.loadOutboundMediaFromUrl.mockReset().mockImplementation(
      async (
        mediaUrl: string,
        options?: {
          maxBytes?: number;
          mediaAccess?: {
            localRoots?: readonly string[];
            readFile?: (filePath: string) => Promise<Buffer>;
          };
          mediaLocalRoots?: readonly string[];
          mediaReadFile?: (filePath: string) => Promise<Buffer>;
        },
      ) =>
        await loadWebMediaMock(mediaUrl, {
          maxBytes: options?.maxBytes,
          localRoots: options?.mediaAccess?.localRoots ?? options?.mediaLocalRoots,
          readFile: options?.mediaAccess?.readFile ?? options?.mediaReadFile,
          hostReadCapability: Boolean(options?.mediaAccess?.readFile ?? options?.mediaReadFile),
        }),
    );
    hoisted.controllerListeners.clear();
    hoisted.controllerListeners.set("default", {
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    hoisted.controllerListeners.clear();
  });

  it("sends message via active listener", async () => {
    const result = await sendMessageWhatsApp("+1555", "hi", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
    });
    expect(result).toEqual({
      messageId: "msg123",
      toJid: "1555@s.whatsapp.net",
    });
    expect(sendComposingTo).toHaveBeenCalledWith("+1555");
    expect(sendMessage).toHaveBeenCalledWith("+1555", "hi", undefined, undefined);
  });

  it("uses configured defaultAccount when outbound accountId is omitted", async () => {
    hoisted.controllerListeners.clear();
    hoisted.controllerListeners.set("work", {
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });

    const result = await sendMessageWhatsApp("+1555", "hi", {
      verbose: false,
      cfg: {
        channels: {
          whatsapp: {
            defaultAccount: "work",
            accounts: {
              work: {},
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(result).toEqual({
      messageId: "msg123",
      toJid: "1555@s.whatsapp.net",
    });
    expect(sendMessage).toHaveBeenCalledWith("+1555", "hi", undefined, undefined);
  });

  it("trims leading whitespace before sending text and captions", async () => {
    await sendMessageWhatsApp("+1555", "\n \thello", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "hello", undefined, undefined);

    const buf = Buffer.from("img");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "image/jpeg",
      kind: "image",
    });
    await sendMessageWhatsApp("+1555", "\n \tcaption", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/pic.jpg",
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "caption", buf, "image/jpeg");
  });

  it("preserves intentional indentation when the caller opts out of transport trimming", async () => {
    await sendMessageWhatsApp("+1555", "    indented", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      preserveLeadingWhitespace: true,
    });

    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "    indented", undefined, undefined);
  });

  it("skips whitespace-only text sends without media", async () => {
    const result = await sendMessageWhatsApp("+1555", "\n \t", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
    });

    expect(result).toEqual({
      messageId: "",
      toJid: "1555@s.whatsapp.net",
    });
    expect(sendComposingTo).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("throws a helpful error when no active listener exists", async () => {
    hoisted.controllerListeners.clear();
    await expect(
      sendMessageWhatsApp("+1555", "hi", {
        verbose: false,
        cfg: WHATSAPP_TEST_CFG,
        accountId: "work",
      }),
    ).rejects.toThrow(/No active WhatsApp Web listener/);
    await expect(
      sendMessageWhatsApp("+1555", "hi", {
        verbose: false,
        cfg: WHATSAPP_TEST_CFG,
        accountId: "work",
      }),
    ).rejects.toThrow(/channels login/);
    await expect(
      sendMessageWhatsApp("+1555", "hi", {
        verbose: false,
        cfg: WHATSAPP_TEST_CFG,
        accountId: "work",
      }),
    ).rejects.toThrow(/account: work/);
  });

  it("maps audio to PTT with opus mime when ogg", async () => {
    const buf = Buffer.from("audio");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "audio/ogg",
      kind: "audio",
    });
    await sendMessageWhatsApp("+1555", "voice note", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/voice.ogg",
    });
    expect(sendMessage).toHaveBeenLastCalledWith(
      "+1555",
      "voice note",
      buf,
      "audio/ogg; codecs=opus",
    );
  });

  it("maps video with caption", async () => {
    const buf = Buffer.from("video");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "video/mp4",
      kind: "video",
    });
    await sendMessageWhatsApp("+1555", "clip", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/video.mp4",
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "clip", buf, "video/mp4");
  });

  it("marks gif playback for video when requested", async () => {
    const buf = Buffer.from("gifvid");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "video/mp4",
      kind: "video",
    });
    await sendMessageWhatsApp("+1555", "gif", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/anim.mp4",
      gifPlayback: true,
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "gif", buf, "video/mp4", {
      gifPlayback: true,
    });
  });

  it("maps image with caption", async () => {
    const buf = Buffer.from("img");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "image/jpeg",
      kind: "image",
    });
    await sendMessageWhatsApp("+1555", "pic", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/pic.jpg",
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "pic", buf, "image/jpeg");
  });

  it("does not retry transient outbound send failures to avoid duplicate sends", async () => {
    sendMessage.mockRejectedValueOnce({ error: { message: "connection closed" } });

    await expect(
      sendMessageWhatsApp("+1555", "hi", { verbose: false, cfg: WHATSAPP_TEST_CFG }),
    ).rejects.toEqual({ error: { message: "connection closed" } });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("prefers explicit mediaUrl over mediaUrls when both are present", async () => {
    const buf = Buffer.from("img");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "image/jpeg",
      kind: "image",
    });

    await sendMessageWhatsApp("+1555", "pic", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/primary.jpg",
      mediaUrls: [" /tmp/secondary.jpg "],
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "/tmp/primary.jpg",
      expect.objectContaining({
        hostReadCapability: false,
      }),
    );
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "pic", buf, "image/jpeg");
  });

  it("falls back to the first mediaUrls entry when mediaUrl is omitted", async () => {
    const buf = Buffer.from("img");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "image/jpeg",
      kind: "image",
    });
    await sendMessageWhatsApp("+1555", "pic", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrls: ["   ", " /tmp/pic.jpg "],
    });
    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "/tmp/pic.jpg",
      expect.objectContaining({
        hostReadCapability: false,
      }),
    );
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "pic", buf, "image/jpeg");
  });

  it("maps other kinds to document with filename", async () => {
    const buf = Buffer.from("pdf");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "application/pdf",
      kind: "document",
      fileName: "file.pdf",
    });
    await sendMessageWhatsApp("+1555", "doc", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/file.pdf",
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "doc", buf, "application/pdf", {
      fileName: "file.pdf",
    });
  });

  it("uses account-aware WhatsApp media caps for outbound uploads", async () => {
    hoisted.controllerListeners.set("work", {
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("img"),
      contentType: "image/jpeg",
      kind: "image",
    });

    const cfg = {
      channels: {
        whatsapp: {
          mediaMaxMb: 25,
          accounts: {
            work: {
              mediaMaxMb: 100,
            },
          },
        },
      },
    } as OpenClawConfig;

    await sendMessageWhatsApp("+1555", "pic", {
      verbose: false,
      accountId: "work",
      cfg,
      mediaUrl: "/tmp/pic.jpg",
      mediaLocalRoots: ["/tmp/workspace"],
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "/tmp/pic.jpg",
      expect.objectContaining({
        maxBytes: 100 * 1024 * 1024,
        localRoots: ["/tmp/workspace"],
      }),
    );
  });

  it("sends polls via active listener", async () => {
    const result = await sendPollWhatsApp(
      "+1555",
      { question: "Lunch?", options: ["Pizza", "Sushi"], maxSelections: 2 },
      { verbose: false, cfg: WHATSAPP_TEST_CFG },
    );
    expect(result).toEqual({
      messageId: "poll123",
      toJid: "1555@s.whatsapp.net",
    });
    expect(sendPoll).toHaveBeenCalledWith("+1555", {
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 2,
      durationSeconds: undefined,
      durationHours: undefined,
    });
  });

  it("redacts recipients and poll text in outbound logs", async () => {
    const logPath = path.join(os.tmpdir(), `openclaw-outbound-${crypto.randomUUID()}.log`);
    setLoggerOverride({ level: "trace", file: logPath });

    await sendPollWhatsApp(
      "+1555",
      { question: "Lunch?", options: ["Pizza", "Sushi"], maxSelections: 1 },
      { verbose: false, cfg: WHATSAPP_TEST_CFG },
    );

    await vi.waitFor(
      () => {
        expect(fsSync.existsSync(logPath)).toBe(true);
      },
      { timeout: 2_000, interval: 5 },
    );

    const content = fsSync.readFileSync(logPath, "utf-8");
    expect(content).toContain(redactIdentifier("+1555"));
    expect(content).toContain(redactIdentifier("1555@s.whatsapp.net"));
    expect(content).not.toContain(`"to":"+1555"`);
    expect(content).not.toContain(`"jid":"1555@s.whatsapp.net"`);
    expect(content).not.toContain("Lunch?");
  });

  it("sends reactions via active listener", async () => {
    await sendReactionWhatsApp("1555@s.whatsapp.net", "msg123", "✅", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      fromMe: false,
    });
    expect(sendReaction).toHaveBeenCalledWith(
      "1555@s.whatsapp.net",
      "msg123",
      "✅",
      false,
      undefined,
    );
  });
});
