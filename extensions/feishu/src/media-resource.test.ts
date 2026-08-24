// Feishu tests cover inbound media resource persistence.
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

const messageResourceGetMock = vi.hoisted(() => vi.fn());

const FEISHU_MEDIA_HTTP_TIMEOUT_MS = 120_000;
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
  return {
    ...actual,
    runFfmpeg: runFfmpegMock,
    runFfprobe: runFfprobeMock,
  };
});

let saveMessageResourceFeishu: typeof import("./media.js").saveMessageResourceFeishu;

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

describe("saveMessageResourceFeishu", () => {
  beforeAll(async () => {
    ({ saveMessageResourceFeishu } = await import("./media.js"));
  });

  afterAll(() => {
    vi.doUnmock("./client.js");
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./targets.js");
    vi.doUnmock("./runtime.js");
    vi.doUnmock("openclaw/plugin-sdk/media-runtime");
    vi.resetModules();
  });

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
