import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const normalizeFeishuTargetMock = vi.hoisted(() => vi.fn());
const resolveReceiveIdTypeMock = vi.hoisted(() => vi.fn());
const loadWebMediaMock = vi.hoisted(() => vi.fn());
const runFfmpegMock = vi.hoisted(() => vi.fn());

const fileCreateMock = vi.hoisted(() => vi.fn());
const imageCreateMock = vi.hoisted(() => vi.fn());
const imageGetMock = vi.hoisted(() => vi.fn());
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
  };
});

let downloadImageFeishu: typeof import("./media.js").downloadImageFeishu;
let downloadMessageResourceFeishu: typeof import("./media.js").downloadMessageResourceFeishu;
let sanitizeFileNameForUpload: typeof import("./media.js").sanitizeFileNameForUpload;
let sendMediaFeishu: typeof import("./media.js").sendMediaFeishu;
let shouldSuppressFeishuTextForVoiceMedia: typeof import("./media.js").shouldSuppressFeishuTextForVoiceMedia;

function expectPathIsolatedToTmpRoot(pathValue: string, key: string): void {
  expect(pathValue).not.toContain(key);
  expect(pathValue).not.toContain("..");

  const tmpRoot = realpathSync(resolvePreferredOpenClawTmpDir());
  const resolved = path.resolve(pathValue);
  const rel = path.relative(tmpRoot, resolved);
  expect(rel === ".." || rel.startsWith(`..${path.sep}`)).toBe(false);
}

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

describe("sendMediaFeishu msg_type routing", () => {
  beforeAll(async () => {
    ({
      downloadImageFeishu,
      downloadMessageResourceFeishu,
      sanitizeFileNameForUpload,
      sendMediaFeishu,
      shouldSuppressFeishuTextForVoiceMedia,
    } = await import("./media.js"));
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
          get: imageGetMock,
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

    imageGetMock.mockResolvedValue(Buffer.from("image-bytes"));
    messageResourceGetMock.mockResolvedValue(Buffer.from("resource-bytes"));
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      await fs.writeFile(args.at(-1) ?? "", Buffer.from("opus-output"));
      return "";
    });
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

  it("uses msg_type=media for mp4 video", async () => {
    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: Buffer.from("video"),
      fileName: "clip.mp4",
    });

    expect(callData<{ file_type?: string }>(fileCreateMock).file_type).toBe("mp4");
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
    for (const arg of ["-c:a", "libopus", "-ar", "48000", "-b:a", "64k"]) {
      expect(ffmpegArgs).toContain(arg);
    }
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

  it("uses isolated temp paths for image downloads", async () => {
    const imageKey = "img_v3_01abc123";
    let capturedPath: string | undefined;

    imageGetMock.mockResolvedValueOnce({
      writeFile: async (tmpPath: string) => {
        capturedPath = tmpPath;
        await fs.writeFile(tmpPath, Buffer.from("image-data"));
      },
    });

    const result = await downloadImageFeishu({
      cfg: emptyConfig,
      imageKey,
    });

    const request = mockCallArg<{ path?: { image_key?: string } }>(imageGetMock, 0, 0);
    expect(request.path).toEqual({ image_key: imageKey });
    expectMediaTimeoutClientConfigured();
    expect(result.buffer).toEqual(Buffer.from("image-data"));
    if (!capturedPath) {
      throw new Error("expected Feishu image temp path");
    }
    expectPathIsolatedToTmpRoot(capturedPath, imageKey);
  });

  it("uses isolated temp paths for message resource downloads", async () => {
    const fileKey = "file_v3_01abc123";
    let capturedPath: string | undefined;

    messageResourceGetMock.mockResolvedValueOnce({
      writeFile: async (tmpPath: string) => {
        capturedPath = tmpPath;
        await fs.writeFile(tmpPath, Buffer.from("resource-data"));
      },
    });

    const result = await downloadMessageResourceFeishu({
      cfg: emptyConfig,
      messageId: "om_123",
      fileKey,
      type: "image",
    });

    expect(result.buffer).toEqual(Buffer.from("resource-data"));
    if (!capturedPath) {
      throw new Error("expected Feishu resource temp path");
    }
    expectPathIsolatedToTmpRoot(capturedPath, fileKey);
  });

  it("rejects invalid image keys before calling feishu api", async () => {
    await expect(
      downloadImageFeishu({
        cfg: emptyConfig,
        imageKey: "a/../../bad",
      }),
    ).rejects.toThrow("invalid image_key");

    expect(imageGetMock).not.toHaveBeenCalled();
  });

  it("rejects invalid file keys before calling feishu api", async () => {
    await expect(
      downloadMessageResourceFeishu({
        cfg: emptyConfig,
        messageId: "om_123",
        fileKey: "x/../../bad",
        type: "file",
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

describe("sanitizeFileNameForUpload", () => {
  it("returns ASCII filenames unchanged", () => {
    expect(sanitizeFileNameForUpload("report.pdf")).toBe("report.pdf");
    expect(sanitizeFileNameForUpload("my-file_v2.txt")).toBe("my-file_v2.txt");
  });

  it("preserves Chinese characters", () => {
    expect(sanitizeFileNameForUpload("测试文件.md")).toBe("测试文件.md");
    expect(sanitizeFileNameForUpload("武汉15座山登山信息汇总.csv")).toBe(
      "武汉15座山登山信息汇总.csv",
    );
  });

  it("preserves em-dash and full-width brackets", () => {
    expect(sanitizeFileNameForUpload("文件—说明（v2）.pdf")).toBe("文件—说明（v2）.pdf");
  });

  it("preserves single quotes and parentheses", () => {
    expect(sanitizeFileNameForUpload("文件'(test).txt")).toBe("文件'(test).txt");
  });

  it("preserves filenames without extension", () => {
    expect(sanitizeFileNameForUpload("测试文件")).toBe("测试文件");
  });

  it("preserves mixed ASCII and non-ASCII", () => {
    expect(sanitizeFileNameForUpload("Report_报告_2026.xlsx")).toBe("Report_报告_2026.xlsx");
  });

  it("preserves emoji filenames", () => {
    expect(sanitizeFileNameForUpload("report_😀.txt")).toBe("report_😀.txt");
  });

  it("strips control characters", () => {
    expect(sanitizeFileNameForUpload("bad\x00file.txt")).toBe("bad_file.txt");
    expect(sanitizeFileNameForUpload("inject\r\nheader.txt")).toBe("inject__header.txt");
  });

  it("strips quotes and backslashes to prevent header injection", () => {
    expect(sanitizeFileNameForUpload('file"name.txt')).toBe("file_name.txt");
    expect(sanitizeFileNameForUpload("file\\name.txt")).toBe("file_name.txt");
  });
});

describe("downloadMessageResourceFeishu", () => {
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
    const result = await downloadMessageResourceFeishu({
      cfg: emptyConfig,
      messageId: "om_audio_msg",
      fileKey: "file_key_audio",
      type: "file",
    });

    const request = mockCallArg<{
      params?: { type?: string };
      path?: { file_key?: string; message_id?: string };
    }>(messageResourceGetMock, 0, 0);
    expect(request.path).toEqual({ message_id: "om_audio_msg", file_key: "file_key_audio" });
    expect(request.params).toEqual({ type: "file" });
    expectMediaTimeoutClientConfigured();
    expect(result.buffer).toBeInstanceOf(Buffer);
  });

  it("image uses type=image", async () => {
    messageResourceGetMock.mockResolvedValue(Buffer.from("fake-image-data"));

    const result = await downloadMessageResourceFeishu({
      cfg: emptyConfig,
      messageId: "om_img_msg",
      fileKey: "img_key_1",
      type: "image",
    });

    const request = mockCallArg<{
      params?: { type?: string };
      path?: { file_key?: string; message_id?: string };
    }>(messageResourceGetMock, 0, 0);
    expect(request.path).toEqual({ message_id: "om_img_msg", file_key: "img_key_1" });
    expect(request.params).toEqual({ type: "image" });
    expectMediaTimeoutClientConfigured();
    expect(result.buffer).toBeInstanceOf(Buffer);
  });

  it("extracts content-type and filename metadata from download headers", async () => {
    messageResourceGetMock.mockResolvedValueOnce({
      data: Buffer.from("fake-video-data"),
      headers: {
        "content-type": "video/mp4",
        "content-disposition": `attachment; filename="clip.mp4"`,
      },
    });

    const result = await downloadMessageResourceFeishu({
      cfg: emptyConfig,
      messageId: "om_video_msg",
      fileKey: "file_key_video",
      type: "file",
    });

    expect(result.buffer).toEqual(Buffer.from("fake-video-data"));
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

    const result = await downloadMessageResourceFeishu({
      cfg: emptyConfig,
      messageId: "om_ios_video_msg",
      fileKey: "file_key_ios_video",
      type: "file",
    });

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
    expect(result.buffer).toEqual(Buffer.from("fake-ios-video-data"));
    expect(result.contentType).toBe("video/mp4");
    expect(result.fileName).toBe("ios-video.mp4");
  });

  it("rethrows the original HTTP 502 when the media retry fails", async () => {
    const originalError = httpStatusError(502);
    messageResourceGetMock
      .mockRejectedValueOnce(originalError)
      .mockRejectedValueOnce(new Error("media retry failed"));

    await expect(
      downloadMessageResourceFeishu({
        cfg: emptyConfig,
        messageId: "om_ios_video_msg",
        fileKey: "file_key_ios_video",
        type: "file",
      }),
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
        downloadMessageResourceFeishu({
          cfg: emptyConfig,
          messageId: scenario.messageId,
          fileKey: scenario.fileKey,
          type: scenario.type,
        }),
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

    const result = await downloadMessageResourceFeishu({
      cfg: emptyConfig,
      messageId: "om_file_msg",
      fileKey: "file_key_csv",
      type: "file",
    });

    expect(result.fileName).toBe(fileName);
  });

  it("keeps valid Latin-1 filenames from plain Content-Disposition headers unchanged", async () => {
    messageResourceGetMock.mockResolvedValueOnce({
      data: Buffer.from("fake-file-data"),
      headers: {
        "content-disposition": `attachment; filename="café-Â©.txt"`,
      },
    });

    const result = await downloadMessageResourceFeishu({
      cfg: emptyConfig,
      messageId: "om_latin1_msg",
      fileKey: "file_key_latin1",
      type: "file",
    });

    expect(result.fileName).toBe("café-Â©.txt");
  });

  it("keeps JSON-derived file_name metadata unchanged", async () => {
    const fileName = "武汉15座山登山信息汇总.csv";
    const latin1LookingFileName = Buffer.from(fileName, "utf8").toString("latin1");
    messageResourceGetMock.mockResolvedValueOnce({
      data: Buffer.from("fake-file-data"),
      file_name: latin1LookingFileName,
    });

    const result = await downloadMessageResourceFeishu({
      cfg: emptyConfig,
      messageId: "om_json_file_msg",
      fileKey: "file_key_json",
      type: "file",
    });

    expect(result.fileName).toBe(latin1LookingFileName);
  });
});
