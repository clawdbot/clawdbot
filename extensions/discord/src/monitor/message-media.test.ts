// Discord tests cover message utils plugin behavior.
import { MessageFlags, MessageReferenceType, StickerFormatType } from "discord-api-types/v10";
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

let resolveForwardedMediaList: typeof import("./message-utils.js").resolveForwardedMediaList;
let resolveMediaList: typeof import("./message-utils.js").resolveMediaList;

beforeAll(async () => {
  ({ resolveForwardedMediaList, resolveMediaList } = await import("./message-utils.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function asMessage(payload: Record<string, unknown>): Message {
  return payload as unknown as Message;
}

const DISCORD_CDN_HOSTNAMES = [
  "cdn.discordapp.com",
  "media.discordapp.net",
  "*.discordapp.com",
  "*.discordapp.net",
];

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

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
      ...(params.kind ? { kind: params.kind } : {}),
    },
  ]);
}

function expectAttachmentImageFallback(params: { result: unknown; attachment: { url: string } }) {
  expect(saveMediaBuffer).not.toHaveBeenCalled();
  expect(params.result).toEqual([
    {
      contentType: "image/png",
    },
  ]);
}

function asReferencedForwardMessage(params: {
  content?: string;
  components?: Array<Record<string, unknown>>;
  embeds?: Array<{ title?: string; description?: string }>;
  attachments?: Array<Record<string, unknown>>;
  messageReferenceType?: MessageReferenceType;
}) {
  return asMessage({
    content: "",
    messageReference: {
      type: params.messageReferenceType ?? MessageReferenceType.Forward,
      message_id: "m0",
      channel_id: "c1",
    },
    referencedMessage: asMessage({
      id: "m0",
      channelId: "c1",
      content: params.content ?? "",
      components: params.components ?? [],
      attachments: params.attachments ?? [],
      embeds: params.embeds ?? [],
      flags: params.components ? MessageFlags.IsComponentsV2 : 0,
      stickers: [],
      author: {
        id: "u2",
        username: "Bob",
        discriminator: "0",
      },
    }),
  });
}

describe("resolveForwardedMediaList", () => {
  beforeEach(() => {
    readRemoteMediaBuffer.mockClear();
    saveMediaBuffer.mockClear();
  });

  it("downloads forwarded attachments", async () => {
    const attachment = {
      id: "att-1",
      url: "https://cdn.discordapp.com/attachments/1/image.png",
      filename: "image.png",
      content_type: "image/png",
    };
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/image.png",
      contentType: "image/png",
    });

    const result = await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { attachments: [attachment] } }],
        },
      }),
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
    const attachment = {
      id: "att-proxy",
      url: "https://cdn.discordapp.com/attachments/1/proxy.png",
      filename: "proxy.png",
      content_type: "image/png",
    };
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/proxy.png",
      contentType: "image/png",
    });

    await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { attachments: [attachment] } }],
        },
      }),
      512,
      { fetchImpl: proxyFetch },
    );

    expect(fetchParams().fetchImpl).toBe(proxyFetch);
  });

  it("keeps forwarded attachment metadata when download fails", async () => {
    const attachment = {
      id: "att-fallback",
      url: "https://cdn.discordapp.com/attachments/1/fallback.png",
      filename: "fallback.png",
      content_type: "image/png",
    };
    readRemoteMediaBuffer.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { attachments: [attachment] } }],
        },
      }),
      512,
    );

    expectAttachmentImageFallback({ result, attachment });
  });

  it("downloads forwarded stickers", async () => {
    const sticker = {
      id: "sticker-1",
      name: "wave",
      format_type: StickerFormatType.PNG,
    };
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("sticker"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/sticker.png",
      contentType: "image/png",
    });

    const result = await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { sticker_items: [sticker] } }],
        },
      }),
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
    const attachment = {
      id: "att-ref-1",
      url: "https://cdn.discordapp.com/attachments/1/ref-image.png",
      filename: "ref-image.png",
      content_type: "image/png",
    };
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/ref-image.png",
      contentType: "image/png",
    });

    const result = await resolveForwardedMediaList(
      asReferencedForwardMessage({
        attachments: [attachment],
      }),
      512,
    );

    expectSinglePngDownload({
      result,
      expectedUrl: attachment.url,
      filePathHint: attachment.filename,
      expectedPath: "/tmp/ref-image.png",
    });
  });

  it("skips snapshots without attachments", async () => {
    const result = await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { content: "hello" } }],
        },
      }),
      512,
    );

    expect(result).toStrictEqual([]);
    expect(readRemoteMediaBuffer).not.toHaveBeenCalled();
  });

  it("passes readIdleTimeoutMs to forwarded attachment downloads", async () => {
    const attachment = {
      id: "att-timeout-forwarded",
      url: "https://cdn.discordapp.com/attachments/1/forwarded-timeout.png",
      filename: "forwarded-timeout.png",
      content_type: "image/png",
    };
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/forwarded-timeout.png",
      contentType: "image/png",
    });

    await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { attachments: [attachment] } }],
        },
      }),
      512,
      { readIdleTimeoutMs: 60_000 },
    );

    expect(fetchParams().readIdleTimeoutMs).toBe(60_000);
  });

  it("passes readIdleTimeoutMs to forwarded sticker downloads", async () => {
    const sticker = {
      id: "sticker-timeout-forwarded",
      name: "timeout-forwarded",
      format_type: StickerFormatType.PNG,
    };
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("sticker"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/forwarded-sticker-timeout.png",
      contentType: "image/png",
    });

    await resolveForwardedMediaList(
      asMessage({
        rawData: {
          message_snapshots: [{ message: { sticker_items: [sticker] } }],
        },
      }),
      512,
      { readIdleTimeoutMs: 60_000 },
    );

    expect(fetchParams().readIdleTimeoutMs).toBe(60_000);
  });
});

describe("resolveMediaList", () => {
  beforeEach(() => {
    readRemoteMediaBuffer.mockClear();
    saveMediaBuffer.mockClear();
  });

  it("downloads stickers", async () => {
    const sticker = {
      id: "sticker-2",
      name: "hello",
      format_type: StickerFormatType.PNG,
    };
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("sticker"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/sticker-2.png",
      contentType: "image/png",
    });

    const result = await resolveMediaList(
      asMessage({
        stickers: [sticker],
      }),
      512,
    );

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
    const sticker = {
      id: "sticker-proxy",
      name: "proxy-sticker",
      format_type: StickerFormatType.PNG,
    };
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("sticker"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/sticker-proxy.png",
      contentType: "image/png",
    });

    await resolveMediaList(
      asMessage({
        stickers: [sticker],
      }),
      512,
      { fetchImpl: proxyFetch },
    );

    expect(fetchParams().fetchImpl).toBe(proxyFetch);
  });

  it("keeps attachment metadata when download fails", async () => {
    const attachment = {
      id: "att-main-fallback",
      url: "https://cdn.discordapp.com/attachments/1/main-fallback.png",
      filename: "main-fallback.png",
      content_type: "image/png",
    };
    readRemoteMediaBuffer.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(
      asMessage({
        attachments: [attachment],
      }),
      512,
    );

    expectAttachmentImageFallback({ result, attachment });
  });

  it("keeps type-only facts for attachments without a usable URL", async () => {
    const result = await resolveMediaList(
      asMessage({
        attachments: [
          {
            id: "att-missing-url",
            filename: "voice.ogg",
            content_type: "audio/ogg",
          },
        ],
      }),
      512,
    );

    expect(readRemoteMediaBuffer).not.toHaveBeenCalled();
    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(result).toStrictEqual([{ contentType: "audio/ogg", kind: "audio" }]);
  });

  it("classifies audio attachments by filename when content type is missing", async () => {
    const attachment = {
      id: "att-audio-fallback",
      url: "https://cdn.discordapp.com/attachments/1/voice.ogg",
      filename: "voice.ogg",
    };
    readRemoteMediaBuffer.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(
      asMessage({
        attachments: [attachment],
      }),
      512,
    );

    expect(result).toEqual([
      {
        contentType: undefined,
        kind: "audio",
      },
    ]);
  });

  it("classifies Discord voice attachments by waveform metadata", async () => {
    const attachment = {
      id: "att-voice-metadata",
      url: "https://cdn.discordapp.com/attachments/1/voice",
      filename: "voice",
      duration_secs: 1.5,
      waveform: "AAAA",
    };
    readRemoteMediaBuffer.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(
      asMessage({
        attachments: [attachment],
      }),
      512,
    );

    expect(result).toEqual([
      {
        contentType: undefined,
        kind: "audio",
      },
    ]);
  });

  it("lets native Discord voice metadata override a conflicting definitive MIME", async () => {
    const attachment = {
      id: "att-voice-conflicting-mime",
      url: "https://cdn.discordapp.com/attachments/1/voice",
      filename: "voice",
      content_type: "video/ogg",
      duration_secs: 1.5,
      waveform: "AAAA",
    };
    readRemoteMediaBuffer.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([{ contentType: undefined, kind: "audio" }]);
  });

  it.each(["application/octet-stream", "application/ogg"])(
    "prefers the structured audio kind over non-audio MIME %s",
    async (contentType) => {
      const attachment = {
        id: "att-audio-conflicting-mime",
        url: "https://cdn.discordapp.com/attachments/1/voice.ogg",
        filename: "voice.ogg",
        content_type: contentType,
      };
      readRemoteMediaBuffer.mockResolvedValueOnce({
        buffer: Buffer.from("audio"),
        contentType,
      });
      saveMediaBuffer.mockResolvedValueOnce({
        path: "/tmp/voice.ogg",
        contentType,
      });

      const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

      expect(result).toEqual([
        {
          path: "/tmp/voice.ogg",
          contentType: undefined,
          kind: "audio",
        },
      ]);
    },
  );

  it("normalizes MIME case before classifying audio", async () => {
    const attachment = {
      id: "att-audio-mime-case",
      url: "https://cdn.discordapp.com/attachments/1/voice.bin",
      filename: "voice.bin",
      content_type: "Audio/OGG",
    };
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
    const attachment = {
      id: "att-video-audio-extension",
      url: "https://cdn.discordapp.com/attachments/1/clip.ogg",
      filename: "clip.ogg",
      content_type: "video/ogg",
    };
    readRemoteMediaBuffer.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        contentType: "video/ogg",
      },
    ]);
  });

  it("does not let an audio-looking filename override fetched image MIME", async () => {
    const attachment = {
      id: "att-image-audio-extension",
      url: "https://cdn.discordapp.com/attachments/1/image.ogg",
      filename: "image.ogg",
    };
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/image.png",
      contentType: "image/png",
    });

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        path: "/tmp/image.png",
        contentType: "image/png",
      },
    ]);
  });

  it("keeps declared audio when the fetched MIME is generic", async () => {
    const attachment = {
      id: "att-declared-audio-fetched-generic",
      url: "https://cdn.discordapp.com/attachments/1/voice",
      filename: "voice",
      content_type: "audio/ogg",
    };
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("audio"),
      contentType: "application/octet-stream",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/voice",
      contentType: "application/octet-stream",
    });

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        path: "/tmp/voice",
        contentType: "audio/ogg",
        kind: "audio",
      },
    ]);
  });

  it.each(["application/pdf", "text/plain"])(
    "does not infer audio from an .ogg filename with definitive MIME %s",
    async (contentType) => {
      const attachment = {
        id: `att-definitive-${contentType}`,
        url: "https://cdn.discordapp.com/attachments/1/document.ogg",
        filename: "document.ogg",
        content_type: contentType,
      };
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
    const attachment = {
      id: "att-declared-audio-fetched-image",
      url: "https://cdn.discordapp.com/attachments/1/voice.ogg",
      filename: "voice.ogg",
      content_type: "audio/ogg",
    };
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/image.png",
      contentType: "image/png",
    });

    const result = await resolveMediaList(asMessage({ attachments: [attachment] }), 512);

    expect(result).toEqual([
      {
        path: "/tmp/image.png",
        contentType: "image/png",
      },
    ]);
  });

  it("classifies extensionless Discord voice attachments from native fields", async () => {
    const attachment = {
      id: "att-voice-native-fields",
      url: "https://cdn.discordapp.com/attachments/1/voice",
      filename: "voice",
      duration_secs: 1.5,
      waveform: "AAAA",
    };
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
    const attachment = {
      id: "att-save-fail",
      url: "https://cdn.discordapp.com/attachments/1/photo.png",
      filename: "photo.png",
      content_type: "image/png",
    };
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockRejectedValueOnce(new Error("disk full"));

    const result = await resolveMediaList(
      asMessage({
        attachments: [attachment],
      }),
      512,
    );

    expect(readRemoteMediaBuffer).toHaveBeenCalledTimes(1);
    expect(saveMediaBuffer).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        contentType: "image/png",
      },
    ]);
  });

  it("preserves downloaded attachments alongside failed ones", async () => {
    const goodAttachment = {
      id: "att-good",
      url: "https://cdn.discordapp.com/attachments/1/good.png",
      filename: "good.png",
      content_type: "image/png",
    };
    const badAttachment = {
      id: "att-bad",
      url: "https://cdn.discordapp.com/attachments/1/bad.pdf",
      filename: "bad.pdf",
      content_type: "application/pdf",
    };

    readRemoteMediaBuffer
      .mockResolvedValueOnce({
        buffer: Buffer.from("image"),
        contentType: "image/png",
      })
      .mockRejectedValueOnce(new Error("network timeout"));
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/good.png",
      contentType: "image/png",
    });

    const result = await resolveMediaList(
      asMessage({
        attachments: [goodAttachment, badAttachment],
      }),
      512,
    );

    expect(result).toEqual([
      {
        path: "/tmp/good.png",
        contentType: "image/png",
      },
      {
        contentType: "application/pdf",
      },
    ]);
  });

  it("keeps sticker metadata when sticker download fails", async () => {
    const sticker = {
      id: "sticker-fallback",
      name: "fallback",
      format_type: StickerFormatType.PNG,
    };
    readRemoteMediaBuffer.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(
      asMessage({
        stickers: [sticker],
      }),
      512,
    );

    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        contentType: "image/png",
        kind: "sticker",
      },
    ]);
  });

  it("passes readIdleTimeoutMs to readRemoteMediaBuffer for attachments", async () => {
    const attachment = {
      id: "att-timeout",
      url: "https://cdn.discordapp.com/attachments/1/timeout.png",
      filename: "timeout.png",
      content_type: "image/png",
    };
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/timeout.png",
      contentType: "image/png",
    });

    await resolveMediaList(
      asMessage({
        attachments: [attachment],
      }),
      512,
      { readIdleTimeoutMs: 60_000 },
    );

    expect(fetchParams().readIdleTimeoutMs).toBe(60_000);
  });

  it("passes readIdleTimeoutMs to readRemoteMediaBuffer for stickers", async () => {
    const sticker = {
      id: "sticker-timeout",
      name: "timeout",
      format_type: StickerFormatType.PNG,
    };
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("sticker"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/sticker-timeout.png",
      contentType: "image/png",
    });

    await resolveMediaList(
      asMessage({
        stickers: [sticker],
      }),
      512,
      { readIdleTimeoutMs: 60_000 },
    );

    expect(fetchParams().readIdleTimeoutMs).toBe(60_000);
  });

  it("times out slow attachment downloads and returns a type-only fact", async () => {
    const attachment = {
      id: "att-total-timeout",
      url: "https://cdn.discordapp.com/attachments/1/slow.png",
      filename: "slow.png",
      content_type: "image/png",
    };
    vi.useFakeTimers();
    readRemoteMediaBuffer.mockImplementation(
      () =>
        new Promise(() => {
          // never resolves
        }),
    );

    try {
      const resultPromise = resolveMediaList(
        asMessage({
          attachments: [attachment],
        }),
        512,
        { totalTimeoutMs: 100 },
      );

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
    const attachment = {
      id: "att-abort",
      url: "https://cdn.discordapp.com/attachments/1/abort.png",
      filename: "abort.png",
      content_type: "image/png",
    };
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

    const resultPromise = resolveMediaList(
      asMessage({
        attachments: [attachment],
      }),
      512,
      { abortSignal: abortController.signal },
    );
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
