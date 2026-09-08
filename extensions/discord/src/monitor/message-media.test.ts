import {
  type APIAttachment,
  type APIStickerItem,
  MessageReferenceType,
  StickerFormatType,
} from "discord-api-types/v10";
// Discord tests cover message utils plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../internal/discord.js";

const readRemoteMediaBuffer = vi.fn();
const saveMediaBuffer = vi.fn();

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    readRemoteMediaBuffer: (...args: unknown[]) => readRemoteMediaBuffer(...args),
    saveRemoteMedia: async (...args: unknown[]) => {
      const fetched = await readRemoteMediaBuffer(...args);
      if (fetched && typeof fetched === "object" && "path" in fetched) {
        return fetched;
      }
      const options = (args[0] ?? {}) as { maxBytes?: number; originalFilename?: string };
      return await saveMediaBuffer(
        Buffer.from((fetched as { buffer?: Uint8Array }).buffer ?? new Uint8Array()),
        (fetched as { contentType?: string }).contentType,
        "inbound",
        options.maxBytes,
        options.originalFilename,
      );
    },
    saveMediaBuffer: (...args: unknown[]) => saveMediaBuffer(...args),
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    logVerbose: () => {},
  };
});

let resolveForwardedMediaList: typeof import("./message-media.js").resolveForwardedMediaList;
let resolveMediaList: typeof import("./message-media.js").resolveMediaList;

beforeAll(async () => {
  ({ resolveForwardedMediaList, resolveMediaList } = await import("./message-media.js"));
});

afterEach(() => vi.restoreAllMocks());
beforeEach(() => vi.resetAllMocks());

function asMessage(payload: Record<string, unknown>): Message {
  return payload as unknown as Message;
}

type AttachmentFixture = Pick<APIAttachment, "id" | "filename" | "url"> &
  Partial<Omit<APIAttachment, "id" | "filename" | "url">>;

function attachmentFixture(
  id: string,
  filename: string,
  overrides: Partial<APIAttachment> = {},
): AttachmentFixture {
  return {
    id,
    filename,
    url: `https://cdn.discordapp.com/attachments/1/${filename}`,
    content_type: "image/png",
    ...overrides,
  };
}

function stickerFixture(id: string, name: string): APIStickerItem {
  return { id, name, format_type: StickerFormatType.PNG };
}

function mockDownload(path: string, options: { buffer?: string; contentType?: string } = {}): void {
  const contentType = options.contentType ?? "image/png";
  readRemoteMediaBuffer.mockResolvedValueOnce({
    buffer: Buffer.from(options.buffer ?? "image"),
    contentType,
  });
  saveMediaBuffer.mockResolvedValueOnce({ path, contentType });
}

const DISCORD_CDN_HOSTNAMES = [
  "cdn.discordapp.com",
  "media.discordapp.net",
  "*.discordapp.com",
  "*.discordapp.net",
];

const requireRecord = createRequireRecord("object", "expected-label");

function requireArray(value: unknown, label: string): Array<unknown> {
  expect(Array.isArray(value), label).toBe(true);
  return value as Array<unknown>;
}

function callArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
  const calls = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock?.calls ?? [];
  const call = calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected ${label}`);
  }
  return call[argIndex];
}

function fetchParams(): Record<string, unknown> {
  return requireRecord(
    callArg(readRemoteMediaBuffer, 0, 0, "fetch media params"),
    "fetch media params",
  );
}

function expectDiscordCdnSsrFPolicy(policy: unknown) {
  const policyRecord = requireRecord(policy, "ssrf policy");
  expect(policyRecord.allowRfc2544BenchmarkRange).toBe(true);
  const hostnameAllowlist = requireArray(policyRecord.hostnameAllowlist, "hostname allowlist");
  for (const hostname of DISCORD_CDN_HOSTNAMES) {
    expect(hostnameAllowlist).toContain(hostname);
  }
}

function expectSinglePngDownload(params: {
  result: unknown;
  expectedUrl: string;
  filePathHint: string;
  expectedPath: string;
  kind?: "sticker";
}) {
  expect(readRemoteMediaBuffer).toHaveBeenCalledTimes(1);
  const call = fetchParams();
  expect(call.url).toBe(params.expectedUrl);
  expect(call.filePathHint).toBe(params.filePathHint);
  expect(call.maxBytes).toBe(512);
  expect(call.fetchImpl).toBeUndefined();
  expectDiscordCdnSsrFPolicy(call.ssrfPolicy);
  expect(saveMediaBuffer).toHaveBeenCalledTimes(1);
  expect(Buffer.isBuffer(callArg(saveMediaBuffer, 0, 0, "saved buffer"))).toBe(true);
  expect(callArg(saveMediaBuffer, 0, 1, "saved content type")).toBe("image/png");
  expect(callArg(saveMediaBuffer, 0, 2, "saved direction")).toBe("inbound");
  expect(callArg(saveMediaBuffer, 0, 3, "saved max bytes")).toBe(512);
  expect(callArg(saveMediaBuffer, 0, 4, "saved file path hint")).toBe(params.filePathHint);
  expect(params.result).toEqual([
    {
      path: params.expectedPath,
      contentType: "image/png",
      fileName: params.filePathHint,
      ...(params.kind ? { kind: params.kind } : {}),
    },
  ]);
}

function expectAttachmentImageFallback(params: { result: unknown }) {
  expect(saveMediaBuffer).not.toHaveBeenCalled();
  expect(params.result).toEqual([
    {
      contentType: "image/png",
    },
  ]);
}

function asReferencedForwardMessage(attachments: AttachmentFixture[]) {
  return asMessage({
    messageReference: { type: MessageReferenceType.Forward },
    referencedMessage: asMessage({ attachments }),
  });
}

describe("resolveForwardedMediaList", () => {
  it("downloads forwarded attachments", async () => {
    const attachment = attachmentFixture("att-1", "image.png");
    mockDownload("/tmp/image.png");
    const snapshot = { message: { attachments: [attachment] } };

    const result = await resolveForwardedMediaList(
      asMessage({ rawData: { message_snapshots: [snapshot] } }),
      512,
    );

    expectSinglePngDownload({
      result,
      expectedUrl: attachment.url,
      filePathHint: attachment.filename,
      expectedPath: "/tmp/image.png",
    });
  });

  it("forwards fetchImpl to forwarded attachment downloads", async () => {
    const proxyFetch = vi.fn() as unknown as typeof fetch;
    const attachment = attachmentFixture("att-proxy", "proxy.png");
    mockDownload("/tmp/proxy.png");
    const snapshot = { message: { attachments: [attachment] } };

    await resolveForwardedMediaList(
      asMessage({ rawData: { message_snapshots: [snapshot] } }),
      512,
      { fetchImpl: proxyFetch },
    );

    expect(fetchParams().fetchImpl).toBe(proxyFetch);
  });

  it("keeps forwarded attachment metadata when download fails", async () => {
    const attachment = attachmentFixture("att-fallback", "fallback.png");
    readRemoteMediaBuffer.mockRejectedValueOnce(new Error("blocked by ssrf guard"));
    const snapshot = { message: { attachments: [attachment] } };

    const result = await resolveForwardedMediaList(
      asMessage({ rawData: { message_snapshots: [snapshot] } }),
      512,
    );

    expectAttachmentImageFallback({ result });
  });

  it("downloads forwarded stickers", async () => {
    const sticker = stickerFixture("sticker-1", "wave");
    mockDownload("/tmp/sticker.png", { buffer: "sticker" });
    const snapshot = { message: { sticker_items: [sticker] } };

    const result = await resolveForwardedMediaList(
      asMessage({ rawData: { message_snapshots: [snapshot] } }),
      512,
    );

    expectSinglePngDownload({
      result,
      expectedUrl: "https://media.discordapp.net/stickers/sticker-1.png",
      filePathHint: "wave.png",
      expectedPath: "/tmp/sticker.png",
      kind: "sticker",
    });
  });

  it("returns empty when no snapshots are present", async () => {
    const result = await resolveForwardedMediaList(asMessage({}), 512);

    expect(result).toStrictEqual([]);
    expect(readRemoteMediaBuffer).not.toHaveBeenCalled();
  });

  it("downloads forwarded referenced attachments when snapshots are absent", async () => {
    const attachment = attachmentFixture("att-ref-1", "ref-image.png");
    mockDownload("/tmp/ref-image.png");

    const result = await resolveForwardedMediaList(asReferencedForwardMessage([attachment]), 512);

    expectSinglePngDownload({
      result,
      expectedUrl: attachment.url,
      filePathHint: attachment.filename,
      expectedPath: "/tmp/ref-image.png",
    });
  });

  it("skips snapshots without attachments", async () => {
    const snapshot = { message: { content: "hello" } };
    const result = await resolveForwardedMediaList(
      asMessage({ rawData: { message_snapshots: [snapshot] } }),
      512,
    );

    expect(result).toStrictEqual([]);
    expect(readRemoteMediaBuffer).not.toHaveBeenCalled();
  });

  it("passes readIdleTimeoutMs to forwarded attachment downloads", async () => {
    const attachment = attachmentFixture("att-timeout-forwarded", "forwarded-timeout.png");
    mockDownload("/tmp/forwarded-timeout.png");
    const snapshot = { message: { attachments: [attachment] } };

    await resolveForwardedMediaList(
      asMessage({ rawData: { message_snapshots: [snapshot] } }),
      512,
      { readIdleTimeoutMs: 60_000 },
    );

    expect(fetchParams().readIdleTimeoutMs).toBe(60_000);
  });

  it("passes readIdleTimeoutMs to forwarded sticker downloads", async () => {
    const sticker = stickerFixture("sticker-timeout-forwarded", "timeout-forwarded");
    mockDownload("/tmp/forwarded-sticker-timeout.png", { buffer: "sticker" });
    const snapshot = { message: { sticker_items: [sticker] } };

    await resolveForwardedMediaList(
      asMessage({ rawData: { message_snapshots: [snapshot] } }),
      512,
      { readIdleTimeoutMs: 60_000 },
    );

    expect(fetchParams().readIdleTimeoutMs).toBe(60_000);
  });
});

describe("resolveMediaList", () => {
  it("downloads stickers", async () => {
    const sticker = stickerFixture("sticker-2", "hello");
    mockDownload("/tmp/sticker-2.png", { buffer: "sticker" });
    const message = asMessage({ stickers: [sticker] });

    const result = await resolveMediaList(message, 512);

    expectSinglePngDownload({
      result,
      expectedUrl: "https://media.discordapp.net/stickers/sticker-2.png",
      filePathHint: "hello.png",
      expectedPath: "/tmp/sticker-2.png",
      kind: "sticker",
    });
  });

  it("forwards fetchImpl to sticker downloads", async () => {
    const proxyFetch = vi.fn() as unknown as typeof fetch;
    const sticker = stickerFixture("sticker-proxy", "proxy-sticker");
    mockDownload("/tmp/sticker-proxy.png", { buffer: "sticker" });
    const message = asMessage({ stickers: [sticker] });

    await resolveMediaList(message, 512, { fetchImpl: proxyFetch });

    expect(fetchParams().fetchImpl).toBe(proxyFetch);
  });

  it("keeps attachment metadata when download fails", async () => {
    const attachment = attachmentFixture("att-main-fallback", "main-fallback.png");
    readRemoteMediaBuffer.mockRejectedValueOnce(new Error("blocked by ssrf guard"));
    const message = asMessage({ attachments: [attachment] });

    const result = await resolveMediaList(message, 512);

    expectAttachmentImageFallback({ result });
  });

  it("keeps type-only facts for attachments without a usable URL", async () => {
    const { url: _url, ...attachment } = attachmentFixture("att-missing-url", "voice.ogg", {
      content_type: "audio/ogg",
    });
    const message = asMessage({ attachments: [attachment] });
    const result = await resolveMediaList(message, 512);

    expect(readRemoteMediaBuffer).not.toHaveBeenCalled();
    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(result).toStrictEqual([{ contentType: "audio/ogg", kind: "audio" }]);
  });

  it("classifies audio attachments by filename when content type is missing", async () => {
    const attachment = attachmentFixture("att-audio-fallback", "voice.ogg", {
      content_type: undefined,
    });
    readRemoteMediaBuffer.mockRejectedValueOnce(new Error("blocked by ssrf guard"));
    const message = asMessage({ attachments: [attachment] });

    const result = await resolveMediaList(message, 512);

    expect(result).toEqual([
      {
        contentType: undefined,
        kind: "audio",
      },
    ]);
  });

  it("classifies Discord voice attachments by waveform metadata", async () => {
    const attachment = attachmentFixture("att-voice-metadata", "voice", {
      content_type: undefined,
      duration_secs: 1.5,
      waveform: "AAAA",
    });
    readRemoteMediaBuffer.mockRejectedValueOnce(new Error("blocked by ssrf guard"));
    const message = asMessage({ attachments: [attachment] });

    const result = await resolveMediaList(message, 512);

    expect(result).toEqual([
      {
        contentType: undefined,
        kind: "audio",
      },
    ]);
  });

  it("lets native Discord voice metadata override a conflicting definitive MIME", async () => {
    const attachment = attachmentFixture("att-voice-conflicting-mime", "voice", {
      content_type: "video/ogg",
      duration_secs: 1.5,
      waveform: "AAAA",
    });
    readRemoteMediaBuffer.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([{ contentType: undefined, kind: "audio" }]);
  });

  it.each(["application/octet-stream", "application/ogg"])(
    "prefers the structured audio kind over non-audio MIME %s",
    async (contentType) => {
      const attachment = attachmentFixture("att-audio-conflicting-mime", "voice.ogg", {
        content_type: contentType,
      });
      mockDownload("/tmp/voice.ogg", { buffer: "audio", contentType });

      const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

      expect(result).toEqual([
        {
          path: "/tmp/voice.ogg",
          contentType: undefined,
          fileName: "voice.ogg",
          kind: "audio",
        },
      ]);
    },
  );

  it("normalizes MIME case before classifying audio", async () => {
    const attachment = attachmentFixture("att-audio-mime-case", "voice.bin", {
      content_type: "Audio/OGG",
    });
    readRemoteMediaBuffer.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        contentType: "Audio/OGG",
        kind: "audio",
      },
    ]);
  });

  it("does not let an audio-looking filename override video MIME", async () => {
    const attachment = attachmentFixture("att-video-audio-extension", "clip.ogg", {
      content_type: "video/ogg",
    });
    readRemoteMediaBuffer.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        contentType: "video/ogg",
      },
    ]);
  });

  it("does not let an audio-looking filename override fetched image MIME", async () => {
    const attachment = attachmentFixture("att-image-audio-extension", "image.ogg", {
      content_type: undefined,
    });
    mockDownload("/tmp/image.png");

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        path: "/tmp/image.png",
        contentType: "image/png",
        fileName: "image.ogg",
      },
    ]);
  });

  it("keeps declared audio when the fetched MIME is generic", async () => {
    const attachment = attachmentFixture("att-declared-audio-fetched-generic", "voice", {
      content_type: "audio/ogg",
    });
    mockDownload("/tmp/voice", { buffer: "audio", contentType: "application/octet-stream" });

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        path: "/tmp/voice",
        contentType: "audio/ogg",
        fileName: "voice",
        kind: "audio",
      },
    ]);
  });

  it.each(["application/pdf", "text/plain"])(
    "does not infer audio from an .ogg filename with definitive MIME %s",
    async (contentType) => {
      const attachment = attachmentFixture(`att-definitive-${contentType}`, "document.ogg", {
        content_type: contentType,
      });
      readRemoteMediaBuffer.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

      const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

      expect(result).toEqual([
        {
          contentType,
        },
      ]);
    },
  );

  it("uses fetched image MIME over declared audio", async () => {
    const attachment = attachmentFixture("att-declared-audio-fetched-image", "voice.ogg", {
      content_type: "audio/ogg",
    });
    mockDownload("/tmp/image.png");

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        path: "/tmp/image.png",
        contentType: "image/png",
        fileName: "voice.ogg",
      },
    ]);
  });

  it("classifies extensionless Discord voice attachments from native fields", async () => {
    const attachment = attachmentFixture("att-voice-native-fields", "voice", {
      content_type: undefined,
      duration_secs: 1.5,
      waveform: "AAAA",
    });
    readRemoteMediaBuffer.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        contentType: undefined,
        kind: "audio",
      },
    ]);
  });

  it("keeps a type-only fact when saveMediaBuffer fails", async () => {
    const attachment = attachmentFixture("att-save-fail", "photo.png");
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockRejectedValueOnce(new Error("disk full"));
    const message = asMessage({ attachments: [attachment] });

    const result = await resolveMediaList(message, 512);

    expect(readRemoteMediaBuffer).toHaveBeenCalledTimes(1);
    expect(saveMediaBuffer).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        contentType: "image/png",
      },
    ]);
  });

  it("preserves downloaded attachments alongside failed ones", async () => {
    const goodAttachment = attachmentFixture("att-good", "good.png");
    const badAttachment = attachmentFixture("att-bad", "bad.pdf", {
      content_type: "application/pdf",
    });

    mockDownload("/tmp/good.png");
    readRemoteMediaBuffer.mockRejectedValueOnce(new Error("network timeout"));
    const message = asMessage({ attachments: [goodAttachment, badAttachment] });

    const result = await resolveMediaList(message, 512);

    expect(result).toEqual([
      {
        path: "/tmp/good.png",
        contentType: "image/png",
        fileName: "good.png",
      },
      {
        contentType: "application/pdf",
      },
    ]);
  });

  it("keeps sticker metadata when sticker download fails", async () => {
    const sticker = stickerFixture("sticker-fallback", "fallback");
    readRemoteMediaBuffer.mockRejectedValueOnce(new Error("blocked by ssrf guard"));
    const message = asMessage({ stickers: [sticker] });

    const result = await resolveMediaList(message, 512);

    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        contentType: "image/png",
        kind: "sticker",
      },
    ]);
  });

  it("passes readIdleTimeoutMs to readRemoteMediaBuffer for attachments", async () => {
    const attachment = attachmentFixture("att-timeout", "timeout.png");
    mockDownload("/tmp/timeout.png");
    const message = asMessage({ attachments: [attachment] });

    await resolveMediaList(message, 512, { readIdleTimeoutMs: 60_000 });

    expect(fetchParams().readIdleTimeoutMs).toBe(60_000);
  });

  it("passes readIdleTimeoutMs to readRemoteMediaBuffer for stickers", async () => {
    const sticker = stickerFixture("sticker-timeout", "timeout");
    mockDownload("/tmp/sticker-timeout.png", { buffer: "sticker" });
    const message = asMessage({ stickers: [sticker] });

    await resolveMediaList(message, 512, { readIdleTimeoutMs: 60_000 });

    expect(fetchParams().readIdleTimeoutMs).toBe(60_000);
  });

  it("times out slow attachment downloads and returns a type-only fact", async () => {
    const attachment = attachmentFixture("att-total-timeout", "slow.png");
    const message = asMessage({ attachments: [attachment] });
    vi.useFakeTimers();
    readRemoteMediaBuffer.mockImplementation(
      () =>
        new Promise(() => {
          // never resolves
        }),
    );

    try {
      const resultPromise = resolveMediaList(message, 512, { totalTimeoutMs: 100 });

      await vi.advanceTimersByTimeAsync(100);

      await expect(resultPromise).resolves.toEqual([
        {
          contentType: "image/png",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes abortSignal to readRemoteMediaBuffer and keeps a type-only fact when aborted", async () => {
    const attachment = attachmentFixture("att-abort", "abort.png");
    const message = asMessage({ attachments: [attachment] });
    const abortController = new AbortController();
    readRemoteMediaBuffer.mockImplementationOnce(
      (params: { requestInit?: { signal?: AbortSignal } }) =>
        new Promise((_, reject) => {
          const signal = params.requestInit?.signal;
          const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
          if (signal?.aborted) {
            reject(abortError);
            return;
          }
          signal?.addEventListener("abort", () => reject(abortError), { once: true });
        }),
    );

    const resultPromise = resolveMediaList(message, 512, {
      abortSignal: abortController.signal,
    });
    abortController.abort();

    await expect(resultPromise).resolves.toEqual([
      {
        contentType: "image/png",
      },
    ]);
    const requestInit = requireRecord(fetchParams().requestInit, "fetch request init");
    expect(requestInit.signal).toBe(abortController.signal);
  });
});
