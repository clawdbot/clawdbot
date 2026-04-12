import crypto from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { redactIdentifier } from "openclaw/plugin-sdk/logging-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  loadOutboundMediaFromUrl: vi.fn(),
}));
const loadWebMediaMock = vi.fn();
let sendMessageWhatsApp: typeof import("./send.js").sendMessageWhatsApp;
let sendPollWhatsApp: typeof import("./send.js").sendPollWhatsApp;
let sendReactionWhatsApp: typeof import("./send.js").sendReactionWhatsApp;
let setActiveWebListener: typeof import("./active-listener.js").setActiveWebListener;
let resetLogger: typeof import("openclaw/plugin-sdk/runtime-env").resetLogger;
let setLoggerOverride: typeof import("openclaw/plugin-sdk/runtime-env").setLoggerOverride;

vi.mock("./outbound-media.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./outbound-media.runtime.js")>(
    "./outbound-media.runtime.js",
  );
  return {
    ...actual,
    loadOutboundMediaFromUrl: hoisted.loadOutboundMediaFromUrl,
  };
});

describe("web outbound", () => {
  const sendComposingTo = vi.fn(async () => {});
  const sendMessage = vi.fn(async () => ({ messageId: "msg123" }));
  const sendPoll = vi.fn(async () => ({ messageId: "poll123" }));
  const sendReaction = vi.fn(async () => {});

  beforeAll(async () => {
    ({ sendMessageWhatsApp, sendPollWhatsApp, sendReactionWhatsApp } = await import("./send.js"));
    ({ setActiveWebListener } = await import("./active-listener.js"));
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
    setActiveWebListener({
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    setActiveWebListener(null);
    setActiveWebListener("work", null);
  });

  it("sends message via active listener", async () => {
    const result = await sendMessageWhatsApp("+1555", "hi", { verbose: false });
    expect(result).toEqual({
      messageId: "msg123",
      toJid: "1555@s.whatsapp.net",
    });
    expect(sendComposingTo).toHaveBeenCalledWith("+1555");
    expect(sendMessage).toHaveBeenCalledWith("+1555", "hi", undefined, undefined);
  });

  it("uses configured defaultAccount when outbound accountId is omitted", async () => {
    setActiveWebListener(null);
    setActiveWebListener("work", {
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
    await sendMessageWhatsApp("+1555", "\n \thello", { verbose: false });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "hello", undefined, undefined);

    const buf = Buffer.from("img");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "image/jpeg",
      kind: "image",
    });
    await sendMessageWhatsApp("+1555", "\n \tcaption", {
      verbose: false,
      mediaUrl: "/tmp/pic.jpg",
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "caption", buf, "image/jpeg");
  });

  it("skips whitespace-only text sends without media", async () => {
    const result = await sendMessageWhatsApp("+1555", "\n \t", { verbose: false });

    expect(result).toEqual({
      messageId: "",
      toJid: "1555@s.whatsapp.net",
    });
    expect(sendComposingTo).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("throws a helpful error when no active listener exists", async () => {
    setActiveWebListener(null);
    await expect(
      sendMessageWhatsApp("+1555", "hi", { verbose: false, accountId: "work" }),
    ).rejects.toThrow(/No active WhatsApp Web listener/);
    await expect(
      sendMessageWhatsApp("+1555", "hi", { verbose: false, accountId: "work" }),
    ).rejects.toThrow(/channels login/);
    await expect(
      sendMessageWhatsApp("+1555", "hi", { verbose: false, accountId: "work" }),
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
      mediaUrl: "/tmp/pic.jpg",
    });
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
      mediaUrl: "/tmp/file.pdf",
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "doc", buf, "application/pdf", {
      fileName: "file.pdf",
    });
  });

  it("uses account-aware WhatsApp media caps for outbound uploads", async () => {
    setActiveWebListener("work", {
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
      { verbose: false },
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
      { verbose: false },
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
