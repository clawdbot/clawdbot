import fs from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const normalizeFeishuTargetMock = vi.hoisted(() => vi.fn());
const resolveReceiveIdTypeMock = vi.hoisted(() => vi.fn());
const loadWebMediaMock = vi.hoisted(() => vi.fn());
const runFfmpegMock = vi.hoisted(() => vi.fn());
const runFfprobeMock = vi.hoisted(() => vi.fn());
const fileCreateMock = vi.hoisted(() => vi.fn());
const imageCreateMock = vi.hoisted(() => vi.fn());
const messageCreateMock = vi.hoisted(() => vi.fn());
const messageReplyMock = vi.hoisted(() => vi.fn());

const FEISHU_DURATION_FFPROBE_ARGS = [
  "-v",
  "error",
  "-show_entries",
  "format=duration",
  "-of",
  "csv=p=0",
];
const emptyConfig: ClawdbotConfig = {};

vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: resolveFeishuAccountMock,
  resolveFeishuRuntimeAccount: resolveFeishuAccountMock,
}));
vi.mock("./targets.js", () => ({
  normalizeFeishuTarget: normalizeFeishuTargetMock,
  resolveReceiveIdType: resolveReceiveIdTypeMock,
}));
vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({ media: { loadWebMedia: loadWebMediaMock } }),
}));
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  return { ...actual, runFfmpeg: runFfmpegMock, runFfprobe: runFfprobeMock };
});

let sendMediaFeishu: typeof import("./media.js").sendMediaFeishu;

function mockResolvedFeishuAccount() {
  resolveFeishuAccountMock.mockReturnValue({
    configured: true,
    accountId: "main",
    config: {},
    appId: "app_id",
    appSecret: "app_secret",
    domain: "feishu",
  });
}

function mockCallArg<T>(
  mock: { mock: { calls: unknown[][] } },
  callIndex: number,
  argIndex: number,
  _type?: (value: unknown) => value is T,
): T {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call at index ${callIndex}`);
  }
  return call[argIndex] as T;
}

function callData<T>(
  mock: { mock: { calls: unknown[][] } },
  callIndex = 0,
  _type?: (value: unknown) => value is T,
): T {
  const arg = mockCallArg<{ data?: unknown }>(mock, callIndex, 0);
  if (arg.data === undefined) {
    throw new Error(`Expected mock call data at index ${callIndex}`);
  }
  return arg.data as T;
}

function sendTestVideo(replyToMessageId?: string) {
  return sendMediaFeishu({
    cfg: emptyConfig,
    to: "user:ou_target",
    mediaBuffer: Buffer.from("video"),
    fileName: "clip.mp4",
    ...(replyToMessageId ? { replyToMessageId } : {}),
  });
}

describe("sendMediaFeishu media routing", () => {
  beforeAll(async () => {
    ({ sendMediaFeishu } = await import("./media.js"));
  });

  afterAll(() => {
    vi.doUnmock("./client.js");
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./targets.js");
    vi.doUnmock("./runtime.js");
    vi.doUnmock("openclaw/plugin-sdk/media-runtime");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvedFeishuAccount();
    normalizeFeishuTargetMock.mockReturnValue("ou_target");
    resolveReceiveIdTypeMock.mockReturnValue("open_id");
    createFeishuClientMock.mockReturnValue({
      im: {
        file: { create: fileCreateMock },
        image: { create: imageCreateMock },
        message: { create: messageCreateMock, reply: messageReplyMock },
      },
    });
    fileCreateMock.mockResolvedValue({ code: 0, data: { file_key: "file_key_1" } });
    imageCreateMock.mockResolvedValue({ code: 0, data: { image_key: "image_key_1" } });
    messageCreateMock.mockResolvedValue({ code: 0, data: { message_id: "msg_1" } });
    messageReplyMock.mockResolvedValue({ code: 0, data: { message_id: "reply_1" } });
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("remote-audio"),
      fileName: "remote.opus",
      kind: "audio",
      contentType: "audio/ogg",
    });
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      await fs.writeFile(args.at(-1) ?? "", Buffer.from("opus-output"));
      return "";
    });
    runFfprobeMock.mockResolvedValue("1.234\n");
  });

  it("uses msg_type=media for mp4 video", async () => {
    runFfprobeMock.mockResolvedValueOnce("4.2\n");
    await sendTestVideo();
    expect(callData<{ file_type?: string }>(fileCreateMock).file_type).toBe("mp4");
    expect(callData<{ duration?: number }>(fileCreateMock).duration).toBe(4200);
    const ffprobeArgs = mockCallArg<string[]>(runFfprobeMock, 0, 0);
    expect(ffprobeArgs.slice(0, -1)).toEqual(FEISHU_DURATION_FFPROBE_ARGS);
    expect(ffprobeArgs.at(-1)).toMatch(/input\.mp4$/);
    expect(callData<{ image?: Buffer }>(imageCreateMock).image).toEqual(Buffer.from("opus-output"));
    const ffmpegArgs = mockCallArg<string[]>(runFfmpegMock, 0, 0);
    expect(ffmpegArgs).toEqual(
      expect.arrayContaining(["-ss", "0.5", "-frames:v", "1", "-c:v", "mjpeg", "-f", "image2"]),
    );
    expect(ffmpegArgs.at(-1)).toContain("preview.jpg");
    expect(mockCallArg(runFfmpegMock, 0, 1)).toEqual({ timeoutMs: 5_000 });
    const messageData = callData<{ content?: string; msg_type?: string }>(messageCreateMock);
    expect(messageData.msg_type).toBe("media");
    expect(JSON.parse(messageData.content ?? "{}")).toEqual({
      file_key: "file_key_1",
      image_key: "image_key_1",
    });
  });

  it("sends video without a cover when preview rendering fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    runFfmpegMock.mockRejectedValueOnce(new Error("ffmpeg missing"));
    await sendTestVideo();
    expect(imageCreateMock).not.toHaveBeenCalled();
    expect(JSON.parse(callData<{ content?: string }>(messageCreateMock).content ?? "{}")).toEqual({
      file_key: "file_key_1",
    });
    warnSpy.mockRestore();
  });

  it("sends video without a cover when preview upload times out", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let signalUploadStart: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      signalUploadStart = resolve;
    });
    vi.useFakeTimers();
    imageCreateMock.mockImplementation(() => {
      signalUploadStart();
      return new Promise(() => {
        // Keep the upload pending so the timeout path is exercised.
      });
    });
    try {
      const send = sendTestVideo();
      await uploadStarted;
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      await send;
      expect(imageCreateMock).toHaveBeenCalledOnce();
      expect(
        createFeishuClientMock.mock.calls.some(
          ([credentials]) =>
            typeof credentials === "object" &&
            credentials !== null &&
            "httpTimeoutMs" in credentials &&
            credentials.httpTimeoutMs === 5_000,
        ),
      ).toBe(true);
      expect(JSON.parse(callData<{ content?: string }>(messageCreateMock).content ?? "{}")).toEqual(
        {
          file_key: "file_key_1",
        },
      );
      expect(mockCallArg<string>(warnSpy, 0, 0)).toContain("video preview upload timed out");
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  it("uses msg_type=audio for opus", async () => {
    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("audio"),
      fileName: "voice.opus",
    });
    expect(callData<{ file_type?: string }>(fileCreateMock).file_type).toBe("opus");
    expect(callData<{ msg_type?: string }>(messageCreateMock).msg_type).toBe("audio");
  });

  it("includes audio duration in the Feishu file upload", async () => {
    const audio = Buffer.from("opus");
    runFfprobeMock.mockResolvedValueOnce("2.345\n");
    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: audio,
      fileName: "reply.ogg",
    });
    expect(runFfprobeMock).toHaveBeenCalledTimes(1);
    const ffprobeArgs = mockCallArg<string[]>(runFfprobeMock, 0, 0);
    expect(ffprobeArgs.slice(0, -1)).toEqual(FEISHU_DURATION_FFPROBE_ARGS);
    expect(ffprobeArgs.at(-1)).toMatch(/input\.ogg$/);
    expect(mockCallArg(runFfprobeMock, 0, 1)).toEqual({ timeoutMs: 5_000 });
    expect(callData<{ duration?: number }>(fileCreateMock).duration).toBe(2345);
    const messageData = callData<{ content?: string; msg_type?: string }>(messageCreateMock);
    expect(messageData.msg_type).toBe("audio");
    expect(JSON.parse(messageData.content ?? "{}")).toEqual({ file_key: "file_key_1" });
  });

  it("omits audio duration when probing fails", async () => {
    runFfprobeMock.mockRejectedValueOnce(new Error("ffprobe missing"));
    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("opus"),
      fileName: "reply.ogg",
    });
    expect(callData<{ duration?: number }>(fileCreateMock)).not.toHaveProperty("duration");
    expect(JSON.parse(callData<{ content?: string }>(messageCreateMock).content ?? "{}")).toEqual({
      file_key: "file_key_1",
    });
  });

  it("uses msg_type=file for documents", async () => {
    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("doc"),
      fileName: "paper.pdf",
    });
    expect(callData<{ file_type?: string }>(fileCreateMock).file_type).toBe("pdf");
    expect(callData<{ msg_type?: string }>(messageCreateMock).msg_type).toBe("file");
  });

  it("uses msg_type=media for remote mp4 content even when the filename is generic", async () => {
    runFfprobeMock.mockResolvedValueOnce("6.789\n");
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("remote-video"),
      fileName: "download",
      kind: "video",
      contentType: "video/mp4",
    });
    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaUrl: "https://example.com/video",
    });
    expect(callData<{ file_type?: string }>(fileCreateMock).file_type).toBe("mp4");
    expect(callData<{ duration?: number }>(fileCreateMock).duration).toBe(6789);
    const ffprobeArgs = mockCallArg<string[]>(runFfprobeMock, 0, 0);
    expect(ffprobeArgs.at(-1)).toMatch(/input\.mp4$/);
    expect(callData<{ msg_type?: string }>(messageCreateMock).msg_type).toBe("media");
    expect(imageCreateMock).toHaveBeenCalledOnce();
  });

  it("uses msg_type=media when replying with mp4", async () => {
    await sendTestVideo("om_parent");
    const replyRequest = mockCallArg<{
      data?: { content?: string; msg_type?: string };
      path?: { message_id?: string };
    }>(messageReplyMock, 0, 0);
    expect(replyRequest.path).toEqual({ message_id: "om_parent" });
    expect(replyRequest.data?.msg_type).toBe("media");
    expect(JSON.parse(replyRequest.data?.content ?? "{}")).toEqual({
      file_key: "file_key_1",
      image_key: "image_key_1",
    });
    expect(messageCreateMock).not.toHaveBeenCalled();
  });

  it("passes reply_in_thread when replyInThread is true", async () => {
    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("video"),
      fileName: "reply.mp4",
      replyToMessageId: "om_parent",
      replyInThread: true,
    });
    const replyRequest = mockCallArg<{
      data?: { msg_type?: string; reply_in_thread?: boolean };
      path?: { message_id?: string };
    }>(messageReplyMock, 0, 0);
    expect(replyRequest.path).toEqual({ message_id: "om_parent" });
    expect(replyRequest.data?.msg_type).toBe("media");
    expect(replyRequest.data?.reply_in_thread).toBe(true);
  });
});
