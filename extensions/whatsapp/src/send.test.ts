// Whatsapp tests cover send plugin behavior.
import crypto from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { redactIdentifier } from "openclaw/plugin-sdk/logging-core";
import { MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS } from "openclaw/plugin-sdk/media-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAcceptedWhatsAppSendResult } from "./inbound/send-result.test-helper.js";
import type { ActiveWebListener } from "./inbound/types.js";

const hoisted = vi.hoisted(() => ({
  loadOutboundMediaFromUrl: vi.fn(),
  controllerListeners: new Map<string, ActiveWebListener>(),
  runFfmpeg: vi.fn(),
}));
const loadWebMediaMock = vi.fn();
let sendMessageWhatsApp: typeof import("./send.js").sendMessageWhatsApp;
let sendPollWhatsApp: typeof import("./send.js").sendPollWhatsApp;
let sendReactionWhatsApp: typeof import("./send.js").sendReactionWhatsApp;
let sendTypingWhatsApp: typeof import("./send.js").sendTypingWhatsApp;
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

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    runFfmpeg: hoisted.runFfmpeg,
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
  const sendMessage = vi.fn(async () => createAcceptedWhatsAppSendResult("text", "msg123"));
  const sendPoll = vi.fn(async () => createAcceptedWhatsAppSendResult("poll", "poll123"));
  const sendReaction = vi.fn(async () =>
    createAcceptedWhatsAppSendResult("reaction", "reaction123"),
  );

  beforeAll(async () => {
    ({ sendMessageWhatsApp, sendPollWhatsApp, sendReactionWhatsApp, sendTypingWhatsApp } =
      await import("./send.js"));
    ({ resetLogger, setLoggerOverride } = await import("openclaw/plugin-sdk/runtime-env"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.runFfmpeg.mockReset().mockImplementation(async (args: string[]) => {
      fsSync.writeFileSync(args.at(-1) ?? "", Buffer.from("opus-output"));
      return "";
    });
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
          optimizeImages?: boolean;
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

  it("checks send readiness before composing or sending direct messages", async () => {
    const assertSendReady = vi.fn(async () => {
      throw new Error("WhatsApp reachout timelock is active");
    });
    hoisted.controllerListeners.set("default", {
      assertSendReady,
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });

    await expect(
      sendMessageWhatsApp("+1555", "hi", {
        verbose: false,
        cfg: WHATSAPP_TEST_CFG,
      }),
    ).rejects.toThrow("WhatsApp reachout timelock is active");

    expect(assertSendReady).toHaveBeenCalledWith("+1555");
    expect(sendComposingTo).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("returns the actual outbound key remote JID when Baileys resolves a LID target", async () => {
    sendMessage.mockResolvedValueOnce({
      kind: "text",
      messageId: "msg-lid",
      keys: [
        {
          id: "msg-lid",
          remoteJid: "123456789@lid",
          fromMe: true,
        },
      ],
      providerAccepted: true,
    });

    const result = await sendMessageWhatsApp("+1555", "hi", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
    });

    expect(result).toEqual({
      messageId: "msg-lid",
      toJid: "123456789@lid",
    });
  });

  it("sends newsletter messages via the active listener without composing presence", async () => {
    const result = await sendMessageWhatsApp("120363401234567890@newsletter", "hi", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
    });

    expect(result).toEqual({
      messageId: "msg123",
      toJid: "120363401234567890@newsletter",
    });
    expect(sendComposingTo).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      "120363401234567890@newsletter",
      "hi",
      undefined,
      undefined,
    );
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

  it("checks send readiness before standalone direct typing", async () => {
    const assertSendReady = vi.fn(async () => {
      throw new Error("WhatsApp reachout timelock is active");
    });
    hoisted.controllerListeners.set("default", {
      assertSendReady,
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });

    await expect(
      sendTypingWhatsApp("+1555", {
        cfg: WHATSAPP_TEST_CFG,
      }),
    ).rejects.toThrow("WhatsApp reachout timelock is active");

    expect(assertSendReady).toHaveBeenCalledWith("+1555");
    expect(sendComposingTo).not.toHaveBeenCalled();
  });

  it("skips standalone newsletter typing without readiness checks", async () => {
    const assertSendReady = vi.fn(async () => undefined);
    hoisted.controllerListeners.set("default", {
      assertSendReady,
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });

    await sendTypingWhatsApp("120363401234567890@newsletter", {
      cfg: WHATSAPP_TEST_CFG,
    });

    expect(assertSendReady).not.toHaveBeenCalled();
    expect(sendComposingTo).not.toHaveBeenCalled();
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
    expect(sendMessage).toHaveBeenNthCalledWith(1, "+1555", "", buf, "audio/ogg; codecs=opus");
    expect(sendMessage).toHaveBeenNthCalledWith(2, "+1555", "voice note", undefined, undefined);
  });

  it("reports the accepted voice send before a caption failure", async () => {
    const buf = Buffer.from("audio");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "audio/ogg",
      kind: "audio",
    });
    sendMessage
      .mockResolvedValueOnce(createAcceptedWhatsAppSendResult("media", "voice-accepted"))
      .mockRejectedValueOnce(new Error("caption failed"));
    const onDeliveryResult = vi.fn();

    await expect(
      sendMessageWhatsApp("+1555", "voice note", {
        verbose: false,
        cfg: WHATSAPP_TEST_CFG,
        mediaUrl: "/tmp/voice.ogg",
        onDeliveryResult,
      }),
    ).rejects.toThrow("caption failed");

    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "voice-accepted" }),
    );
  });

  it.each([
    { name: "mp3", contentType: "audio/mpeg", fileName: "voice.mp3" },
    { name: "webm", contentType: "audio/webm", fileName: "voice.webm" },
  ])("transcodes $name audio to Ogg Opus before sending a PTT voice note", async (media) => {
    const buf = Buffer.from(media.name);
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: media.contentType,
      kind: "audio",
      fileName: media.fileName,
    });

    await sendMessageWhatsApp("+1555", "voice note", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: `/tmp/${media.fileName}`,
    });

    expect(hoisted.runFfmpeg).toHaveBeenCalledTimes(1);
    const ffmpegArgs = hoisted.runFfmpeg.mock.calls.at(0)?.[0] as string[] | undefined;
    expect(ffmpegArgs?.slice(0, 5)).toEqual(["-hide_banner", "-loglevel", "error", "-y", "-i"]);
    expect(ffmpegArgs?.[5]).toContain(`/input.${media.name}`);
    expect(ffmpegArgs?.slice(6, -1)).toEqual([
      "-vn",
      "-sn",
      "-dn",
      "-t",
      String(MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS),
      "-ar",
      "48000",
      "-ac",
      "1",
      "-c:a",
      "libopus",
      "-b:a",
      "64k",
      "-f",
      "ogg",
    ]);
    const outputPath = ffmpegArgs?.at(-1);
    expect(outputPath).toContain("/fs-safe-output-");
    expect(outputPath).toContain("-voice.ogg.part");
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      "+1555",
      "",
      Buffer.from("opus-output"),
      "audio/ogg; codecs=opus",
    );
    expect(sendMessage).toHaveBeenNthCalledWith(2, "+1555", "voice note", undefined, undefined);
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

  it("sends prehydrated media without loading the original media URL again", async () => {
    const buf = Buffer.from("hydrated");
    await sendMessageWhatsApp("+1555", "hydrated caption", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "https://one-shot.test/photo.png",
      mediaPayload: {
        buffer: buf,
        contentType: "image/png",
        fileName: "photo.png",
      },
    });

    expect(hoisted.loadOutboundMediaFromUrl).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "hydrated caption", buf, "image/png");
  });

  it("uses prehydrated media for forced document sends", async () => {
    const hydrated = Buffer.from("hydrated-original");

    await sendMessageWhatsApp("+1555", "document caption", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/photo.png",
      mediaPayload: {
        buffer: hydrated,
        contentType: "image/png",
        fileName: "photo.png",
      },
      forceDocument: true,
    });

    expect(hoisted.loadOutboundMediaFromUrl).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith(
      "+1555",
      "document caption",
      hydrated,
      "image/png",
      {
        asDocument: true,
        fileName: "photo.png",
      },
    );
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

    expect(loadWebMediaMock).toHaveBeenCalledWith("/tmp/primary.jpg", {
      maxBytes: 50 * 1024 * 1024,
      localRoots: undefined,
      readFile: undefined,
      hostReadCapability: false,
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
      cfg: WHATSAPP_TEST_CFG,
      mediaUrls: ["   ", " /tmp/pic.jpg "],
    });
    expect(loadWebMediaMock).toHaveBeenCalledWith("/tmp/pic.jpg", {
      maxBytes: 50 * 1024 * 1024,
      localRoots: undefined,
      readFile: undefined,
      hostReadCapability: false,
    });
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

  it("keeps explicit document kind for prehydrated image payloads", async () => {
    const buf = Buffer.from("image-as-document");

    await sendMessageWhatsApp("+1555", "doc", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaPayload: {
        buffer: buf,
        contentType: "image/png",
        kind: "document",
        fileName: "photo.png",
      },
    });

    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "doc", buf, "image/png", {
      fileName: "photo.png",
    });
  });

  it("maps documents without fileName to MIME-aware default filename", async () => {
    const buf = Buffer.from("pdf");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "application/pdf",
      kind: "document",
    });
    await sendMessageWhatsApp("+1555", "doc", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "media://generated",
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "doc", buf, "application/pdf", {
      fileName: "file.pdf",
    });
  });

  it("forces document branch when forceDocument is true with image media", async () => {
    const buf = Buffer.from("img");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "image/jpeg",
      kind: "image",
      fileName: "promo.jpg",
    });
    await sendMessageWhatsApp("+1555", "look", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/pic.jpg",
      forceDocument: true,
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "look", buf, "image/jpeg", {
      asDocument: true,
      fileName: "promo.jpg",
    });
    expect(hoisted.loadOutboundMediaFromUrl).toHaveBeenCalledWith(
      "/tmp/pic.jpg",
      expect.objectContaining({ optimizeImages: false }),
    );
  });

  it("forces document branch when forceDocument is true with video media", async () => {
    const buf = Buffer.from("video");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "video/mp4",
      kind: "video",
      fileName: "clip.mp4",
    });
    await sendMessageWhatsApp("+1555", "watch", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/clip.mp4",
      forceDocument: true,
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "watch", buf, "video/mp4", {
      asDocument: true,
      fileName: "clip.mp4",
    });
  });

  it("falls back to a default filename when forceDocument media has no fileName", async () => {
    const buf = Buffer.from("img");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "image/png",
      kind: "image",
    });
    await sendMessageWhatsApp("+1555", "promo", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/pic.png",
      forceDocument: true,
    });
    expect(sendMessage).toHaveBeenLastCalledWith("+1555", "promo", buf, "image/png", {
      asDocument: true,
      fileName: "file.png",
    });
  });

  it("keeps audio on the voice-note path when forceDocument is true", async () => {
    const buf = Buffer.from("audio");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "audio/ogg",
      kind: "audio",
      fileName: "voice.ogg",
    });

    await sendMessageWhatsApp("+1555", "voice note", {
      verbose: false,
      cfg: WHATSAPP_TEST_CFG,
      mediaUrl: "/tmp/voice.ogg",
      forceDocument: true,
    });

    expect(sendMessage).toHaveBeenNthCalledWith(1, "+1555", "", buf, "audio/ogg; codecs=opus");
    expect(sendMessage).toHaveBeenNthCalledWith(2, "+1555", "voice note", undefined, undefined);
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

    expect(loadWebMediaMock).toHaveBeenCalledWith("/tmp/pic.jpg", {
      maxBytes: 100 * 1024 * 1024,
      localRoots: ["/tmp/workspace"],
      readFile: undefined,
      hostReadCapability: false,
    });
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

  it("checks send readiness before sending direct polls", async () => {
    const assertSendReady = vi.fn(async () => {
      throw new Error("WhatsApp reachout timelock is active");
    });
    hoisted.controllerListeners.set("default", {
      assertSendReady,
      sendComposingTo,
      sendMessage,
      sendPoll,
      sendReaction,
    });

    await expect(
      sendPollWhatsApp(
        "+1555",
        { question: "Lunch?", options: ["Pizza", "Sushi"] },
        { verbose: false, cfg: WHATSAPP_TEST_CFG },
      ),
    ).rejects.toThrow("WhatsApp reachout timelock is active");

    expect(assertSendReady).toHaveBeenCalledWith("+1555");
    expect(sendPoll).not.toHaveBeenCalled();
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
