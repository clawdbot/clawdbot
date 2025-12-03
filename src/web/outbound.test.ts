import type { AnyMessageContent } from "@whiskeysockets/baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLogger, setLoggerOverride } from "../logging.js";

vi.mock("./session.js", () => {
  const { EventEmitter } = require("node:events");
  const ev = new EventEmitter();
  const sock = {
    ev,
    ws: { close: vi.fn() },
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ key: { id: "msg123" } }),
  };
  return {
    createWaSocket: vi.fn().mockResolvedValue(sock),
    waitForWaConnection: vi.fn().mockResolvedValue(undefined),
  };
});

const loadWebMediaMock = vi.fn();
vi.mock("./media.js", () => ({
  loadWebMedia: (...args: unknown[]) => loadWebMediaMock(...args),
}));

import { sendMessageWeb } from "./outbound.js";

const { createWaSocket } = await import("./session.js");

describe("web outbound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
  });

  it("sends message via web and closes socket", async () => {
    await sendMessageWeb("+1555", "hi", { verbose: false });
    const sock = await createWaSocket();
    expect(sock.sendMessage).toHaveBeenCalled();
    expect(sock.ws.close).toHaveBeenCalled();
  });

  it("maps audio to PTT with opus mime when ogg", async () => {
    const buf = Buffer.from("audio");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "audio/ogg",
      kind: "audio",
    });
    await sendMessageWeb("+1555", "voice note", {
      verbose: false,
      mediaUrl: "/tmp/voice.ogg",
    });
    const sock = await createWaSocket();
    const [, payload] = sock.sendMessage.mock.calls.at(-1) as [
      string,
      AnyMessageContent,
    ];
    expect(payload).toMatchObject({
      audio: buf,
      ptt: true,
      mimetype: "audio/ogg; codecs=opus",
    });
  });

  it("maps video with caption", async () => {
    const buf = Buffer.from("video");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "video/mp4",
      kind: "video",
    });
    await sendMessageWeb("+1555", "clip", {
      verbose: false,
      mediaUrl: "/tmp/video.mp4",
    });
    const sock = await createWaSocket();
    const [, payload] = sock.sendMessage.mock.calls.at(-1) as [
      string,
      AnyMessageContent,
    ];
    expect(payload).toMatchObject({
      video: buf,
      caption: "clip",
      mimetype: "video/mp4",
    });
  });

  it("maps image with caption", async () => {
    const buf = Buffer.from("img");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "image/jpeg",
      kind: "image",
    });
    await sendMessageWeb("+1555", "pic", {
      verbose: false,
      mediaUrl: "/tmp/pic.jpg",
    });
    const sock = await createWaSocket();
    const [, payload] = sock.sendMessage.mock.calls.at(-1) as [
      string,
      AnyMessageContent,
    ];
    expect(payload).toMatchObject({
      image: buf,
      caption: "pic",
      mimetype: "image/jpeg",
    });
  });

  it("maps other kinds to document with filename", async () => {
    const buf = Buffer.from("pdf");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: buf,
      contentType: "application/pdf",
      kind: "document",
      fileName: "file.pdf",
    });
    await sendMessageWeb("+1555", "doc", {
      verbose: false,
      mediaUrl: "/tmp/file.pdf",
    });
    const sock = await createWaSocket();
    const [, payload] = sock.sendMessage.mock.calls.at(-1) as [
      string,
      AnyMessageContent,
    ];
    expect(payload).toMatchObject({
      document: buf,
      fileName: "file.pdf",
      caption: "doc",
      mimetype: "application/pdf",
    });
  });
});
