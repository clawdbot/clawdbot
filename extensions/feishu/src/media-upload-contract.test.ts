import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  resolveAccount: vi.fn(),
  loadWebMedia: vi.fn(),
  fileCreate: vi.fn(),
  imageCreate: vi.fn(),
  messageCreate: vi.fn(),
  runFfmpeg: vi.fn(),
}));

vi.mock("./client.js", () => ({ createFeishuClient: mocks.createClient }));
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: mocks.resolveAccount,
  resolveFeishuRuntimeAccount: mocks.resolveAccount,
}));
vi.mock("./targets.js", () => ({
  normalizeFeishuTarget: () => "ou_target",
  resolveReceiveIdType: () => "open_id",
}));
vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({ media: { loadWebMedia: mocks.loadWebMedia } }),
}));
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  runFfmpeg: mocks.runFfmpeg,
}));

let sendMediaFeishu: typeof import("./media.js").sendMediaFeishu;
const emptyConfig: ClawdbotConfig = {};
const pngImage = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de",
  "hex",
);
const svgImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const avifImage = Buffer.from("00000018667479706176696600000000617669666d696631", "hex");
const heicImage = Buffer.from("00000018667479706865696300000000686569636d696631", "hex");
const tiffImage = Buffer.from("49492a000800000000000000", "hex");
const jpegImage = Buffer.from("ffd8ffe000104a46494600010100000100010000ffdb0043", "hex");
const icoImage = Buffer.from("00000100010010100000010020006804000016000000", "hex");

function resolvedAccount(mediaMaxMb?: number) {
  return {
    configured: true,
    accountId: "main",
    config: mediaMaxMb === undefined ? {} : { mediaMaxMb },
    appId: "app_id",
    appSecret: "app_secret",
    domain: "feishu",
  };
}

function mockCallData(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return (mock.mock.calls[0]?.[0] as { data?: Record<string, unknown> } | undefined)?.data ?? {};
}

describe("Feishu upload contracts", () => {
  beforeAll(async () => {
    ({ sendMediaFeishu } = await import("./media.js"));
  });

  afterAll(() => {
    for (const id of ["./client.js", "./accounts.js", "./targets.js", "./runtime.js"]) {
      vi.doUnmock(id);
    }
    vi.doUnmock("openclaw/plugin-sdk/media-runtime");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAccount.mockReturnValue(resolvedAccount());
    mocks.createClient.mockReturnValue({
      im: {
        file: { create: mocks.fileCreate },
        image: { create: mocks.imageCreate },
        message: { create: mocks.messageCreate, reply: vi.fn() },
      },
    });
    mocks.fileCreate.mockResolvedValue({ code: 0, data: { file_key: "file_1" } });
    mocks.imageCreate.mockResolvedValue({ code: 0, data: { image_key: "image_1" } });
    mocks.messageCreate.mockResolvedValue({ code: 0, data: { message_id: "message_1" } });
  });

  it.each([
    { fileName: "diagram.svg", contentType: "image/svg+xml", buffer: svgImage },
    { fileName: "photo.avif", contentType: "image/avif", buffer: avifImage },
    { fileName: "diagram.png", contentType: "image/svg+xml", buffer: svgImage },
    { fileName: "diagram.png", contentType: undefined, buffer: svgImage },
    { fileName: "diagram.png", contentType: "application/octet-stream", buffer: svgImage },
    { fileName: "diagram.png", contentType: "image/png", buffer: svgImage },
    { fileName: "diagram.heic", contentType: "image/heic", buffer: svgImage },
    { fileName: "photo.heic", contentType: "image/heic", buffer: Buffer.from("heic image") },
    { fileName: "photo.png", contentType: "image/avif", buffer: avifImage },
    { fileName: "photo.png", contentType: undefined, buffer: avifImage },
    { fileName: "photo.png", contentType: "application/octet-stream", buffer: avifImage },
    { fileName: "photo.png", contentType: "image/png", buffer: avifImage },
    { fileName: "photo.heic", contentType: "image/avif", buffer: avifImage },
  ])("sends unsupported image format $contentType as a file attachment", async (media) => {
    mocks.loadWebMedia.mockResolvedValueOnce({
      buffer: media.buffer,
      fileName: media.fileName,
      kind: "image",
      contentType: media.contentType,
    });

    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaUrl: `https://example.com/${media.fileName}`,
    });

    expect(mocks.imageCreate).not.toHaveBeenCalled();
    expect(mockCallData(mocks.fileCreate).file_type).toBe("stream");
    expect(mockCallData(mocks.messageCreate).msg_type).toBe("file");
  });

  it("uses the supported image MIME when the filename has no recognized extension", async () => {
    mocks.loadWebMedia.mockResolvedValueOnce({
      buffer: pngImage,
      fileName: "download",
      kind: "image",
      contentType: "image/png",
    });

    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaUrl: "https://example.com/download",
    });

    expect(mocks.fileCreate).not.toHaveBeenCalled();
    expect(mocks.imageCreate).toHaveBeenCalledOnce();
    expect(mockCallData(mocks.messageCreate).msg_type).toBe("image");
  });

  it.each([
    { fileName: "photo.heic", contentType: "image/heic", buffer: heicImage },
    { fileName: "download", contentType: "image/heic", buffer: heicImage },
    { fileName: "photo.jpg", contentType: "image/heic", buffer: heicImage },
  ])("uploads supported HEIC image $fileName as a native image", async (media) => {
    mocks.loadWebMedia.mockResolvedValueOnce({
      buffer: media.buffer,
      fileName: media.fileName,
      kind: "image",
      contentType: media.contentType,
    });

    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaUrl: `https://example.com/${media.fileName}`,
    });

    expect(mocks.fileCreate).not.toHaveBeenCalled();
    expect(mocks.imageCreate).toHaveBeenCalledOnce();
    expect(mockCallData(mocks.messageCreate).msg_type).toBe("image");
  });

  it.each([
    { fileName: "scan.tif", buffer: tiffImage },
    { fileName: "photo.heic", buffer: heicImage },
    { fileName: "photo.png", buffer: pngImage },
  ])("recognizes actual supported image bytes in $fileName", async ({ fileName, buffer }) => {
    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaBuffer: buffer,
      fileName,
    });

    expect(mocks.imageCreate).toHaveBeenCalledOnce();
    expect(mockCallData(mocks.messageCreate).msg_type).toBe("image");
  });

  it.each([
    { fileName: "photo.bin", contentType: "image/jpg", buffer: jpegImage },
    { fileName: "scan.bin", contentType: "image/tif", buffer: tiffImage },
    { fileName: "icon.bin", contentType: "image/ico", buffer: icoImage },
    { fileName: "download", contentType: "application/octet-stream", buffer: pngImage },
  ])("routes supported image bytes with $contentType metadata natively", async (media) => {
    mocks.loadWebMedia.mockResolvedValueOnce({
      ...media,
      kind: "image",
    });

    await sendMediaFeishu({
      cfg: emptyConfig,
      to: "user:ou_target",
      mediaUrl: `https://example.com/${media.fileName}`,
    });

    expect(mocks.fileCreate).not.toHaveBeenCalled();
    expect(mocks.imageCreate).toHaveBeenCalledOnce();
    expect(mockCallData(mocks.messageCreate).msg_type).toBe("image");
  });

  it("rejects images exceeding the platform image-upload limit before contacting Feishu", async () => {
    const oversizedImage = Buffer.alloc(10 * 1024 * 1024 + 1);
    pngImage.copy(oversizedImage);
    await expect(
      sendMediaFeishu({
        cfg: emptyConfig,
        to: "user:ou_target",
        mediaBuffer: oversizedImage,
        fileName: "oversized.png",
      }),
    ).rejects.toThrow("Feishu image exceeds its 10485760-byte upload limit");

    expect(mocks.imageCreate).not.toHaveBeenCalled();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });

  it("rejects files exceeding the configured attachment limit before contacting Feishu", async () => {
    mocks.resolveAccount.mockReturnValue(resolvedAccount(1 / (1024 * 1024)));

    await expect(
      sendMediaFeishu({
        cfg: emptyConfig,
        to: "user:ou_target",
        mediaBuffer: Buffer.from("too large"),
        fileName: "notes.pdf",
      }),
    ).rejects.toThrow("Feishu file exceeds its 1-byte upload limit");

    expect(mocks.fileCreate).not.toHaveBeenCalled();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });

  it("rejects oversized voice inputs before starting transcoding", async () => {
    mocks.resolveAccount.mockReturnValue(resolvedAccount(1 / (1024 * 1024)));

    await expect(
      sendMediaFeishu({
        cfg: emptyConfig,
        to: "user:ou_target",
        mediaBuffer: Buffer.from("oversized audio"),
        fileName: "voice.mp3",
        audioAsVoice: true,
      }),
    ).rejects.toThrow("Feishu file exceeds its 1-byte upload limit");

    expect(mocks.runFfmpeg).not.toHaveBeenCalled();
    expect(mocks.fileCreate).not.toHaveBeenCalled();
  });

  it.each([
    { name: "image", fileName: "photo.png", prefix: "Feishu image send failed" },
    { name: "file", fileName: "notes.pdf", prefix: "Feishu file send failed" },
  ])("retains accepted $name visibility when its platform identifier is missing", async (media) => {
    mocks.messageCreate.mockResolvedValueOnce({ code: 0, data: {} });

    let caught: unknown;
    try {
      await sendMediaFeishu({
        cfg: emptyConfig,
        to: "user:ou_target",
        mediaBuffer: media.name === "image" ? pngImage : Buffer.from("attachment"),
        fileName: media.fileName,
      });
    } catch (error) {
      caught = error;
    }

    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    if (!(caught instanceof Error) || !isChannelPartialDeliveryError(caught)) {
      throw new Error("expected an accepted Feishu media delivery without an identity");
    }
    expect(caught.message).toBe(`${media.prefix}: no message_id returned`);
    expect(caught.deliveryResult).toEqual({ messageIds: [], visibleReplySent: true });
    expect(mocks.messageCreate).toHaveBeenCalledOnce();
  });

  it("rejects empty image and file attachments before contacting Feishu", async () => {
    for (const fileName of ["empty.png", "empty.pdf"]) {
      await expect(
        sendMediaFeishu({
          cfg: emptyConfig,
          to: "user:ou_target",
          mediaBuffer: Buffer.alloc(0),
          fileName,
        }),
      ).rejects.toThrow("Feishu attachments cannot be empty");
    }

    expect(mocks.imageCreate).not.toHaveBeenCalled();
    expect(mocks.fileCreate).not.toHaveBeenCalled();
  });
});
