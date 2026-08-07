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
const validPngImage = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de",
  "hex",
);

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accounts.js")>();
  return {
    ...actual,
    resolveFeishuAccount: resolveFeishuAccountMock,
    resolveFeishuRuntimeAccount: resolveFeishuAccountMock,
  };
});

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
      mediaBuffer: validPngImage,
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
      mediaBuffer: validPngImage,
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

  it("falls back to top-level image sends for withdrawn reply targets", async () => {
    messageReplyMock.mockResolvedValueOnce({
      code: 230011,
      msg: "The message was withdrawn.",
    });
    messageCreateMock.mockResolvedValueOnce({
      code: 0,
      data: { message_id: "msg_image_fallback" },
    });

    const result = await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: validPngImage,
      fileName: "photo.png",
      replyToMessageId: "om_parent",
    });

    expect(result.messageId).toBe("msg_image_fallback");
    expect(messageCreateMock).toHaveBeenCalledTimes(1);
    expect(callData<{ msg_type?: string; receive_id?: string }>(messageCreateMock)).toMatchObject({
      msg_type: "image",
      receive_id: "ou_target",
    });
  });

  it("falls back to top-level file sends for thrown withdrawn reply errors", async () => {
    messageReplyMock.mockRejectedValueOnce(
      Object.assign(new Error("request failed"), { code: 230011 }),
    );
    messageCreateMock.mockResolvedValueOnce({
      code: 0,
      data: { message_id: "msg_file_fallback" },
    });

    const result = await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("video"),
      fileName: "reply.mp4",
      replyToMessageId: "om_parent",
    });

    expect(result.messageId).toBe("msg_file_fallback");
    expect(callData<{ msg_type?: string }>(messageCreateMock).msg_type).toBe("media");
  });

  it("keeps thread reply failures top-level safe when fallback is disallowed", async () => {
    messageReplyMock.mockResolvedValueOnce({
      code: 230011,
      msg: "The message was withdrawn.",
    });

    await expect(
      sendMediaFeishu({
        cfg: emptyConfig,
        to: "user:ou_target",
        mediaBuffer: Buffer.from("video"),
        fileName: "reply.mp4",
        replyToMessageId: "om_parent",
        replyInThread: true,
      }),
    ).rejects.toThrow(
      "Feishu thread reply failed: reply target is unavailable and cannot safely fall back to a top-level send.",
    );

    expect(messageCreateMock).not.toHaveBeenCalled();
  });

  it("allows media thread replies to fall back when the dispatcher marks top-level fallback safe", async () => {
    messageReplyMock.mockResolvedValueOnce({
      code: 231003,
      msg: "The message is not found",
    });
    messageCreateMock.mockResolvedValueOnce({
      code: 0,
      data: { message_id: "msg_thread_fallback" },
    });

    const result = await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("video"),
      fileName: "reply.mp4",
      replyToMessageId: "om_parent",
      replyInThread: true,
      allowTopLevelReplyFallback: true,
    });

    expect(result.messageId).toBe("msg_thread_fallback");
    expect(callData<{ msg_type?: string }>(messageCreateMock).msg_type).toBe("media");
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
