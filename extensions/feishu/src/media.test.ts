// Feishu tests cover media plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
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
const messageResourceGetMock = vi.hoisted(() => vi.fn());
const messageReplyMock = vi.hoisted(() => vi.fn());

const FEISHU_MEDIA_HTTP_TIMEOUT_MS = 120_000;
const emptyConfig: ClawdbotConfig = {};

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: resolveFeishuAccountMock,
  resolveFeishuRuntimeAccount: resolveFeishuAccountMock,
}));

vi.mock("./targets.js", () => ({
  normalizeFeishuTarget: normalizeFeishuTargetMock,
  resolveReceiveIdType: resolveReceiveIdTypeMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    media: {
      loadWebMedia: loadWebMediaMock,
    },
  }),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  return {
    ...actual,
    runFfmpeg: runFfmpegMock,
    runFfprobe: runFfprobeMock,
  };
});

let saveMessageResourceFeishu: typeof import("./media.js").saveMessageResourceFeishu;
let sendMediaFeishu: typeof import("./media.js").sendMediaFeishu;
let shouldSuppressFeishuTextForVoiceMedia: typeof import("./media.js").shouldSuppressFeishuTextForVoiceMedia;

function expectMediaTimeoutClientConfigured(): void {
  const options = mockCallArg<{ httpTimeoutMs?: number }>(createFeishuClientMock, 0, 0);
  expect(options.httpTimeoutMs).toBe(FEISHU_MEDIA_HTTP_TIMEOUT_MS);
}

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

async function withIsolatedHome<T>(run: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  return await withTempDir("openclaw-feishu-media-", async (tempHome) => {
    try {
      process.env.HOME = tempHome;
      return await run();
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
}

describe("sendMediaFeishu msg_type routing", () => {
  beforeAll(async () => {
    ({ saveMessageResourceFeishu, sendMediaFeishu, shouldSuppressFeishuTextForVoiceMedia } =
      await import("./media.js"));
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
        file: {
          create: fileCreateMock,
        },
        image: {
          create: imageCreateMock,
        },
        message: {
          create: messageCreateMock,
          reply: messageReplyMock,
        },
        messageResource: {
          get: messageResourceGetMock,
        },
      },
    });

    fileCreateMock.mockResolvedValue({
      code: 0,
      data: { file_key: "file_key_1" },
    });
    imageCreateMock.mockResolvedValue({
      code: 0,
      data: { image_key: "image_key_1" },
    });

    messageCreateMock.mockResolvedValue({
      code: 0,
      data: { message_id: "msg_1" },
    });

    messageReplyMock.mockResolvedValue({
      code: 0,
      data: { message_id: "reply_1" },
    });

    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("remote-audio"),
      fileName: "remote.opus",
      kind: "audio",
      contentType: "audio/ogg",
    });

    messageResourceGetMock.mockResolvedValue(Buffer.from("resource-bytes"));
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      await fs.writeFile(args.at(-1) ?? "", Buffer.from("opus-output"));
      return "";
    });
    runFfprobeMock.mockResolvedValue("1.234\n");
  });

  it("suppresses reply text only for voice-intent or native voice media", () => {
    expect(
      shouldSuppressFeishuTextForVoiceMedia({
        mediaUrl: "https://example.com/reply.mp3",
        audioAsVoice: true,
      }),
    ).toBe(true);
    expect(
      shouldSuppressFeishuTextForVoiceMedia({
        mediaUrl: "https://example.com/reply.ogg?download=1",
      }),
    ).toBe(true);
    expect(
      shouldSuppressFeishuTextForVoiceMedia({
        mediaUrl: "https://example.com/song.mp3",
      }),
    ).toBe(false);
  });

  it("respects ttsSupplement.visibleTextAlreadyDelivered over audioAsVoice", () => {
    expect(
      shouldSuppressFeishuTextForVoiceMedia({
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        ttsSupplement: {
          spokenText: "Hello world",
        },
      }),
    ).toBe(false);

    expect(
      shouldSuppressFeishuTextForVoiceMedia({
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        ttsSupplement: {
          spokenText: "Hello world",
          visibleTextAlreadyDelivered: true,
        },
      }),
    ).toBe(true);
  });

  it("uses msg_type=media for mp4 video", async () => {
    runFfprobeMock.mockResolvedValueOnce("4.2\n");

    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("video"),
      fileName: "clip.mp4",
    });

    expect(callData<{ file_type?: string }>(fileCreateMock).file_type).toBe("mp4");
    expect(callData<{ duration?: number }>(fileCreateMock).duration).toBe(4200);
    const ffprobeArgs = mockCallArg<string[]>(runFfprobeMock, 0, 0);
    expect(ffprobeArgs.slice(0, -1)).toEqual([
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
    ]);
    expect(ffprobeArgs.at(-1)).toMatch(/input\.mp4$/);
    expect(callData<{ msg_type?: string }>(messageCreateMock).msg_type).toBe("media");
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
    expect(ffprobeArgs.slice(0, -1)).toEqual([
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
    ]);
    expect(ffprobeArgs.at(-1)).toMatch(/input\.ogg$/);
    expect(mockCallArg(runFfprobeMock, 0, 1)).toEqual({ timeoutMs: 5_000 });
    expect(callData<{ duration?: number }>(fileCreateMock).duration).toBe(2345);
    const messageData = callData<{ content?: string; msg_type?: string }>(messageCreateMock);
    expect(messageData.msg_type).toBe("audio");
    expect(JSON.parse(messageData.content ?? "{}")).toEqual({
      file_key: "file_key_1",
    });
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
  });

  it("falls back to generic file for unsupported audio formats", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("remote-mp3"),
      fileName: "song.mp3",
      kind: "audio",
      contentType: "audio/mpeg",
    });

    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaUrl: "https://example.com/song.mp3",
    });

    expect(callData<{ file_type?: string }>(fileCreateMock).file_type).toBe("stream");
    expect(callData<{ msg_type?: string }>(messageCreateMock).msg_type).toBe("file");
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it("transcodes voice-intent mp3 to msg_type=audio", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("remote-mp3"),
      fileName: "reply.mp3",
      kind: "audio",
      contentType: "audio/mpeg",
    });

    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaUrl: "https://example.com/reply.mp3",
      audioAsVoice: true,
    });

    const ffmpegArgs = mockCallArg<string[]>(runFfmpegMock, 0, 0);
    for (const arg of ["-c:a", "libopus", "-ar", "48000", "-b:a", "64k", "-f", "ogg"]) {
      expect(ffmpegArgs).toContain(arg);
    }
    expect(ffmpegArgs.slice(-3, -1)).toEqual(["-f", "ogg"]);
    const fileData = callData<{ file?: Buffer; file_name?: string; file_type?: string }>(
      fileCreateMock,
    );
    expect(fileData.file_type).toBe("opus");
    expect(fileData.file_name).toBe("voice.ogg");
    expect(fileData.file).toEqual(Buffer.from("opus-output"));
    expect(callData<{ msg_type?: string }>(messageCreateMock).msg_type).toBe("audio");
  });

  it("leaves native voice audio unchanged when audioAsVoice is true", async () => {
    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("opus"),
      fileName: "reply.ogg",
      audioAsVoice: true,
    });

    expect(runFfmpegMock).not.toHaveBeenCalled();
    const fileData = callData<{ file_name?: string; file_type?: string }>(fileCreateMock);
    expect(fileData.file_type).toBe("opus");
    expect(fileData.file_name).toBe("reply.ogg");
    expect(callData<{ msg_type?: string }>(messageCreateMock).msg_type).toBe("audio");
  });

  it("falls back to file when voice-intent audio cannot be transcoded", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    runFfmpegMock.mockRejectedValueOnce(new Error("ffmpeg missing"));
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("remote-mp3"),
      fileName: "reply.mp3",
      kind: "audio",
      contentType: "audio/mpeg",
    });

    const result = await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaUrl: "https://example.com/reply.mp3",
      audioAsVoice: true,
    });

    const fileData = callData<{ file?: Buffer; file_name?: string; file_type?: string }>(
      fileCreateMock,
    );
    expect(fileData.file_type).toBe("stream");
    expect(fileData.file_name).toBe("reply.mp3");
    expect(fileData.file).toEqual(Buffer.from("remote-mp3"));
    expect(callData<{ msg_type?: string }>(messageCreateMock).msg_type).toBe("file");
    expect(result.voiceIntentDegradedToFile).toBe(true);
    expect(mockCallArg<string>(warnSpy, 0, 0)).toContain("audioAsVoice transcode failed");
    expect(mockCallArg<unknown>(warnSpy, 0, 1)).toBeInstanceOf(Error);
    warnSpy.mockRestore();
  });

  it("configures the media client timeout for image uploads", async () => {
    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("image"),
      fileName: "photo.png",
    });

    expectMediaTimeoutClientConfigured();
    expect(callData<{ msg_type?: string }>(messageCreateMock).msg_type).toBe("image");
  });

  it("preserves Feishu diagnostics when media sends reject before response checks", async () => {
    messageCreateMock.mockRejectedValueOnce(
      Object.assign(new Error("Request failed with status code 400"), {
        response: {
          status: 400,
          data: {
            code: 9499,
            msg: "Bad Request",
            error: {
              log_id: "20260429124731MEDIA",
              troubleshooter: "https://open.feishu.cn/search?log_id=20260429124731MEDIA",
            },
          },
        },
      }),
    );

    const send = sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("image"),
      fileName: "photo.png",
    });

    await expect(send).rejects.toThrow(/Feishu image send failed: .*"feishu_code":9499/);
    await expect(send).rejects.toThrow(/"feishu_log_id":"20260429124731MEDIA"/);
  });

  it("uses msg_type=media when replying with mp4", async () => {
    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("video"),
      fileName: "reply.mp4",
      replyToMessageId: "om_parent",
    });

    const replyRequest = mockCallArg<{
      data?: { msg_type?: string };
      path?: { message_id?: string };
    }>(messageReplyMock, 0, 0);
    expect(replyRequest.path).toEqual({ message_id: "om_parent" });
    expect(replyRequest.data?.msg_type).toBe("media");

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

  it("omits reply_in_thread when replyInThread is false", async () => {
    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("video"),
      fileName: "reply.mp4",
      replyToMessageId: "om_parent",
      replyInThread: false,
    });

    expect(callData<Record<string, unknown>>(messageReplyMock)).not.toHaveProperty(
      "reply_in_thread",
    );
  });

  it("passes mediaLocalRoots as localRoots to loadWebMedia for local paths (#27884)", async () => {
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("local-file"),
      fileName: "doc.pdf",
      kind: "document",
      contentType: "application/pdf",
    });

    const roots = ["/allowed/workspace", "/tmp/openclaw"];
    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaUrl: "/allowed/workspace/file.pdf",
      mediaLocalRoots: roots,
    });

    expect(mockCallArg(loadWebMediaMock, 0, 0)).toBe("/allowed/workspace/file.pdf");
    const options = mockCallArg<{
      localRoots?: string[];
      maxBytes?: number;
      optimizeImages?: boolean;
    }>(loadWebMediaMock, 0, 1);
    expect(typeof options.maxBytes).toBe("number");
    expect(options.optimizeImages).toBe(false);
    expect(options.localRoots).toBe(roots);
  });

  it("fails closed when media URL fetch is blocked", async () => {
    loadWebMediaMock.mockRejectedValueOnce(
      new Error("Blocked: resolves to private/internal IP address"),
    );

    await expect(
      sendMediaFeishu({
        cfg: emptyConfig,
        to: "user:ou_target",
        mediaUrl: "https://x/img",
        fileName: "voice.opus",
      }),
    ).rejects.toThrow(/private\/internal/i);

    expect(fileCreateMock).not.toHaveBeenCalled();
    expect(messageCreateMock).not.toHaveBeenCalled();
    expect(messageReplyMock).not.toHaveBeenCalled();
  });

  it("rejects oversized message resource streams before saving the rest", async () => {
    messageResourceGetMock.mockResolvedValueOnce({
      getReadableStream: () => Readable.from([Buffer.alloc(4), Buffer.alloc(4)]),
    });

    await expect(
      withIsolatedHome(() =>
        saveMessageResourceFeishu({
          cfg: emptyConfig,
          messageId: "om_123",
          fileKey: "file_v3_01abc123",
          type: "file",
          maxBytes: 7,
        }),
      ),
    ).rejects.toThrow(/Media exceeds/i);
  });

  it("rejects oversized writeFile resources before saving the temp file", async () => {
    messageResourceGetMock.mockResolvedValueOnce({
      writeFile: async (tmpPath: string) => {
        await fs.writeFile(tmpPath, Buffer.alloc(8));
      },
    });

    await expect(
      withIsolatedHome(() =>
        saveMessageResourceFeishu({
          cfg: emptyConfig,
          messageId: "om_123",
          fileKey: "file_v3_01abc123",
          type: "file",
          maxBytes: 7,
        }),
      ),
    ).rejects.toThrow(/Media exceeds/i);
  });

  it("rejects invalid file keys before calling feishu api", async () => {
    await expect(
      saveMessageResourceFeishu({
        cfg: emptyConfig,
        messageId: "om_123",
        fileKey: "x/../../bad",
        type: "file",
        maxBytes: 30 * 1024 * 1024,
      }),
    ).rejects.toThrow("invalid file_key");

    expect(messageResourceGetMock).not.toHaveBeenCalled();
  });

  it("preserves Chinese filenames for file uploads", async () => {
    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("doc"),
      fileName: "测试文档.pdf",
    });

    expect(callData<{ file_name?: string }>(fileCreateMock).file_name).toBe("测试文档.pdf");
  });

  it("preserves ASCII filenames unchanged for file uploads", async () => {
    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("doc"),
      fileName: "report-2026.pdf",
    });

    expect(callData<{ file_name?: string }>(fileCreateMock).file_name).toBe("report-2026.pdf");
  });

  it("preserves special Unicode characters (em-dash, full-width brackets) in filenames", async () => {
    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("doc"),
      fileName: "报告—详情（2026）.md",
    });

    expect(callData<{ file_name?: string }>(fileCreateMock).file_name).toBe("报告—详情（2026）.md");
  });
});

describe("saveMessageResourceFeishu", () => {
  function httpStatusError(status: number): Error & { response: { status: number } } {
    return Object.assign(new Error(`Request failed with status code ${status}`), {
      response: { status },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvedFeishuAccount();

    createFeishuClientMock.mockReturnValue({
      im: {
        messageResource: {
          get: messageResourceGetMock,
        },
      },
    });

    messageResourceGetMock.mockResolvedValue(Buffer.from("fake-audio-data"));
  });

  // Regression: Feishu API only supports type=image|file for messageResource.get.
  // Audio/video resources must use type=file, not type=audio (#8746).
  it("forwards provided type=file for non-image resources", async () => {
    const result = await withIsolatedHome(() =>
      saveMessageResourceFeishu({
        cfg: emptyConfig,
        messageId: "om_audio_msg",
        fileKey: "file_key_audio",
        type: "file",
        maxBytes: 1024,
      }),
    );

    const request = mockCallArg<{
      params?: { type?: string };
      path?: { file_key?: string; message_id?: string };
    }>(messageResourceGetMock, 0, 0);
    expect(request.path).toEqual({ message_id: "om_audio_msg", file_key: "file_key_audio" });
    expect(request.params).toEqual({ type: "file" });
    expectMediaTimeoutClientConfigured();
    expect(result.saved.size).toBe("fake-audio-data".length);
  });

  it("image uses type=image", async () => {
    messageResourceGetMock.mockResolvedValue(Buffer.from("fake-image-data"));

    const result = await withIsolatedHome(() =>
      saveMessageResourceFeishu({
        cfg: emptyConfig,
        messageId: "om_img_msg",
        fileKey: "img_key_1",
        type: "image",
        maxBytes: 1024,
      }),
    );

    const request = mockCallArg<{
      params?: { type?: string };
      path?: { file_key?: string; message_id?: string };
    }>(messageResourceGetMock, 0, 0);
    expect(request.path).toEqual({ message_id: "om_img_msg", file_key: "img_key_1" });
    expect(request.params).toEqual({ type: "image" });
    expectMediaTimeoutClientConfigured();
    expect(result.saved.size).toBe("fake-image-data".length);
  });

  it("extracts content-type and filename metadata from download headers", async () => {
    messageResourceGetMock.mockResolvedValueOnce({
      data: Buffer.from("fake-video-data"),
      headers: {
        "content-type": "video/mp4",
        "content-disposition": `attachment; filename="clip.mp4"`,
      },
    });

    const result = await withIsolatedHome(() =>
      saveMessageResourceFeishu({
        cfg: emptyConfig,
        messageId: "om_video_msg",
        fileKey: "file_key_video",
        type: "file",
        maxBytes: 1024,
      }),
    );

    expect(result.saved.size).toBe("fake-video-data".length);
    expect(result.contentType).toBe("video/mp4");
    expect(result.fileName).toBe("clip.mp4");
  });

  it("retries file resources as media after HTTP 502", async () => {
    const originalError = httpStatusError(502);
    messageResourceGetMock.mockRejectedValueOnce(originalError).mockResolvedValueOnce({
      data: Buffer.from("fake-ios-video-data"),
      headers: {
        "content-type": "video/mp4",
        "content-disposition": `attachment; filename="ios-video.mp4"`,
      },
    });

    const result = await withIsolatedHome(() =>
      saveMessageResourceFeishu({
        cfg: emptyConfig,
        messageId: "om_ios_video_msg",
        fileKey: "file_key_ios_video",
        type: "file",
        maxBytes: 1024,
      }),
    );

    const firstRequest = mockCallArg<{
      params?: { type?: string };
      path?: { file_key?: string; message_id?: string };
    }>(messageResourceGetMock, 0, 0);
    expect(firstRequest.path).toEqual({
      message_id: "om_ios_video_msg",
      file_key: "file_key_ios_video",
    });
    expect(firstRequest.params).toEqual({ type: "file" });
    const secondRequest = mockCallArg<{
      params?: { type?: string };
      path?: { file_key?: string; message_id?: string };
    }>(messageResourceGetMock, 1, 0);
    expect(secondRequest.path).toEqual({
      message_id: "om_ios_video_msg",
      file_key: "file_key_ios_video",
    });
    expect(secondRequest.params).toEqual({ type: "media" });
    expect(result.saved.size).toBe("fake-ios-video-data".length);
    expect(result.contentType).toBe("video/mp4");
    expect(result.fileName).toBe("ios-video.mp4");
  });

  it("rethrows the original HTTP 502 when the media retry fails", async () => {
    const originalError = httpStatusError(502);
    messageResourceGetMock
      .mockRejectedValueOnce(originalError)
      .mockRejectedValueOnce(new Error("media retry failed"));

    await expect(
      withIsolatedHome(() =>
        saveMessageResourceFeishu({
          cfg: emptyConfig,
          messageId: "om_ios_video_msg",
          fileKey: "file_key_ios_video",
          type: "file",
          maxBytes: 1024,
        }),
      ),
    ).rejects.toBe(originalError);

    expect(
      mockCallArg<{ params?: { type?: string } }>(messageResourceGetMock, 0, 0).params,
    ).toEqual({ type: "file" });
    expect(
      mockCallArg<{ params?: { type?: string } }>(messageResourceGetMock, 1, 0).params,
    ).toEqual({ type: "media" });
  });

  it("does not retry non-fallback download failures", async () => {
    for (const scenario of [
      { messageId: "om_image_msg", fileKey: "img_key_502", type: "image" as const, status: 502 },
      { messageId: "om_file_msg", fileKey: "file_key_500", type: "file" as const, status: 500 },
    ]) {
      const originalError = httpStatusError(scenario.status);
      messageResourceGetMock.mockClear();
      messageResourceGetMock.mockRejectedValueOnce(originalError);

      await expect(
        withIsolatedHome(() =>
          saveMessageResourceFeishu({
            cfg: emptyConfig,
            messageId: scenario.messageId,
            fileKey: scenario.fileKey,
            type: scenario.type,
            maxBytes: 1024,
          }),
        ),
      ).rejects.toBe(originalError);

      expect(messageResourceGetMock).toHaveBeenCalledTimes(1);
      const request = mockCallArg<{
        params?: { type?: string };
        path?: { file_key?: string; message_id?: string };
      }>(messageResourceGetMock, 0, 0);
      expect(request.path).toEqual({ message_id: scenario.messageId, file_key: scenario.fileKey });
      expect(request.params).toEqual({ type: scenario.type });
    }
  });

  it("recovers CJK filenames from plain Content-Disposition headers decoded as Latin-1", async () => {
    const fileName = "武汉15座山登山信息汇总.csv";
    const latin1HeaderFileName = Buffer.from(fileName, "utf8").toString("latin1");
    messageResourceGetMock.mockResolvedValueOnce({
      data: Buffer.from("fake-file-data"),
      headers: {
        "content-disposition": `attachment; filename="${latin1HeaderFileName}"`,
      },
    });

    const result = await withIsolatedHome(() =>
      saveMessageResourceFeishu({
        cfg: emptyConfig,
        messageId: "om_file_msg",
        fileKey: "file_key_csv",
        type: "file",
        maxBytes: 1024,
      }),
    );

    expect(result.fileName).toBe(fileName);
  });

  it("keeps valid Latin-1 filenames from plain Content-Disposition headers unchanged", async () => {
    messageResourceGetMock.mockResolvedValueOnce({
      data: Buffer.from("fake-file-data"),
      headers: {
        "content-disposition": `attachment; filename="café-Â©.txt"`,
      },
    });

    const result = await withIsolatedHome(() =>
      saveMessageResourceFeishu({
        cfg: emptyConfig,
        messageId: "om_latin1_msg",
        fileKey: "file_key_latin1",
        type: "file",
        maxBytes: 1024,
      }),
    );

    expect(result.fileName).toBe("café-Â©.txt");
  });

  it("keeps JSON-derived file_name metadata unchanged", async () => {
    const fileName = "武汉15座山登山信息汇总.csv";
    const latin1LookingFileName = Buffer.from(fileName, "utf8").toString("latin1");
    messageResourceGetMock.mockResolvedValueOnce({
      data: Buffer.from("fake-file-data"),
      file_name: latin1LookingFileName,
    });

    const result = await withIsolatedHome(() =>
      saveMessageResourceFeishu({
        cfg: emptyConfig,
        messageId: "om_json_file_msg",
        fileKey: "file_key_json",
        type: "file",
        maxBytes: 1024,
      }),
    );

    expect(result.fileName).toBe(latin1LookingFileName);
  });

  it("saves message resource streams directly to the media store", async () => {
    await withIsolatedHome(async () => {
      messageResourceGetMock.mockResolvedValueOnce({
        getReadableStream: () => Readable.from([Buffer.from([0xff, 0xd8, 0xff, 0x00])]),
        headers: {
          "content-type": "image/jpeg",
          "content-disposition": `attachment; filename="photo.jpg"`,
        },
      });

      const result = await saveMessageResourceFeishu({
        cfg: emptyConfig,
        messageId: "om_stream_msg",
        fileKey: "img_key_stream",
        type: "image",
        maxBytes: 1024,
      });

      expect(result.saved.path).toContain(`${path.sep}.openclaw${path.sep}media${path.sep}inbound`);
      expect(result.saved.id).toMatch(/^photo---[a-f0-9-]{36}\.jpg$/);
      expect(result.saved.size).toBe(4);
      await expect(fs.readFile(result.saved.path)).resolves.toEqual(
        Buffer.from([0xff, 0xd8, 0xff, 0x00]),
      );
    });
  });

  it("keeps the shipped 120-second media timeout for stalled stream bodies", async () => {
    vi.useFakeTimers();
    let markReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const stalled = new Readable({
      read() {
        markReadStarted?.();
      },
    });
    messageResourceGetMock.mockResolvedValueOnce({
      getReadableStream: () => stalled,
      headers: { "content-type": "image/jpeg" },
    });

    try {
      let settled = false;
      const download = withIsolatedHome(() =>
        saveMessageResourceFeishu({
          cfg: emptyConfig,
          messageId: "om_stalled_stream",
          fileKey: "img_key_stalled",
          type: "image",
          maxBytes: 1024,
        }),
      );
      void download.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await readStarted;
      await vi.advanceTimersByTimeAsync(FEISHU_MEDIA_HTTP_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(download).rejects.toMatchObject({
        name: "FeishuInboundMediaTimeoutError",
        chunkTimeoutMs: FEISHU_MEDIA_HTTP_TIMEOUT_MS,
      });
      expect(stalled.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers CJK filenames from the inbound message payload fallback", async () => {
    const fileName = "武汉15座山登山信息汇总.csv";
    const latin1LookingFileName = Buffer.from(fileName, "utf8").toString("latin1");
    await withIsolatedHome(async () => {
      messageResourceGetMock.mockResolvedValueOnce({
        getReadableStream: () => Readable.from([Buffer.from("a,b\n1,2\n")]),
        headers: { "content-type": "text/csv" },
      });

      const result = await saveMessageResourceFeishu({
        cfg: emptyConfig,
        messageId: "om_stream_msg_cjk",
        fileKey: "file_key_stream_cjk",
        type: "file",
        maxBytes: 1024,
        originalFilename: latin1LookingFileName,
      });

      expect(result.saved.id).toMatch(/^武汉15座山登山信息汇总---[a-f0-9-]{36}\.csv$/);
    });
  });
});
