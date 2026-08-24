// Feishu tests cover media plugin behavior.
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

const emptyConfig: ClawdbotConfig = {};
const FEISHU_MEDIA_HTTP_TIMEOUT_MS = 120_000;
const validPngImage = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de",
  "hex",
);

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
  return {
    ...actual,
    runFfmpeg: runFfmpegMock,
    runFfprobe: runFfprobeMock,
  };
});

let sendMediaFeishu: typeof import("./media.js").sendMediaFeishu;
let shouldSuppressFeishuTextForVoiceMedia: typeof import("./media.js").shouldSuppressFeishuTextForVoiceMedia;

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

function expectMediaTimeoutClientConfigured(): void {
  const options = mockCallArg<{ httpTimeoutMs?: number }>(createFeishuClientMock, 0, 0);
  expect(options.httpTimeoutMs).toBe(FEISHU_MEDIA_HTTP_TIMEOUT_MS);
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

describe("sendMediaFeishu msg_type routing", () => {
  beforeAll(async () => {
    ({ sendMediaFeishu, shouldSuppressFeishuTextForVoiceMedia } = await import("./media.js"));
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
    expect(callData<{ image?: Buffer }>(imageCreateMock).image).toEqual(Buffer.from("opus-output"));
    const ffmpegArgs = mockCallArg<string[]>(runFfmpegMock, 0, 0);
    expect(ffmpegArgs).toEqual(
      expect.arrayContaining([
        "-ss",
        "0.5",
        "-vf",
        "scale=1280:720:force_original_aspect_ratio=decrease",
        "-frames:v",
        "1",
        "-c:v",
        "mjpeg",
        "-f",
        "image2",
        "-fs",
        String(10 * 1024 * 1024 + 1),
      ]),
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

  it("sends video without a cover when the preview exceeds its image limit", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    runFfmpegMock.mockImplementationOnce(async (args: string[]) => {
      const outputPath = args.at(-1);
      const sizeLimitIndex = args.indexOf("-fs");
      const sizeLimit = Number(args[sizeLimitIndex + 1]);
      if (!outputPath || sizeLimitIndex < 0 || !Number.isSafeInteger(sizeLimit)) {
        throw new Error("test ffmpeg output limit setup failed");
      }
      await fs.writeFile(outputPath, Buffer.alloc(sizeLimit));
      return "";
    });

    try {
      await sendTestVideo();
      expect(imageCreateMock).not.toHaveBeenCalled();
      expect(JSON.parse(callData<{ content?: string }>(messageCreateMock).content ?? "{}")).toEqual(
        {
          file_key: "file_key_1",
        },
      );
      expect(mockCallArg<string>(warnSpy, 0, 0)).toContain("failed to render video preview");
    } finally {
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
    const options = mockCallArg<{ localRoots: readonly string[] }>(loadWebMediaMock, 0, 1);
    expect(options).toEqual({
      maxBytes: expect.any(Number),
      optimizeImages: false,
      localRoots: roots,
    });
    expect(options.localRoots).toBe(roots);
  });

  it("keeps approved workspace access authoritative over legacy access", async () => {
    const readFile = vi.fn(async () => Buffer.from("approved image"));
    const legacyReadFile = vi.fn(async () => Buffer.from("legacy image"));
    const localRoots = ["/approved/workspace"];
    const mediaAccess = { localRoots, workspaceDir: "/approved/workspace", readFile };
    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaUrl: "chart.png",
      mediaAccess,
      mediaLocalRoots: ["/legacy/workspace"],
      mediaReadFile: legacyReadFile,
    });
    expect(mockCallArg(loadWebMediaMock, 0, 0)).toBe("chart.png");
    const options = mockCallArg<{ localRoots: readonly string[] }>(loadWebMediaMock, 0, 1);
    expect(options).toEqual({
      maxBytes: expect.any(Number),
      localRoots,
      readFile,
      hostReadCapability: true,
      optimizeImages: false,
      workspaceDir: "/approved/workspace",
    });
    expect(options.localRoots).toBe(localRoots);
  });

  it("rejects host readers without approved roots before any media dispatch", async () => {
    const readFile = vi.fn(async () => Buffer.from("unapproved image"));
    await expect(
      sendMediaFeishu({
        cfg: emptyConfig,
        to: "user:ou_target",
        mediaUrl: "chart.png",
        mediaAccess: { readFile, workspaceDir: "/unapproved/workspace" },
      }),
    ).rejects.toThrow("Host media read requires explicit localRoots");
    expect(loadWebMediaMock).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(fileCreateMock).not.toHaveBeenCalled();
    expect(imageCreateMock).not.toHaveBeenCalled();
    expect(messageCreateMock).not.toHaveBeenCalled();
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
