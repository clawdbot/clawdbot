import { ChannelType, type Client, type Message } from "@buape/carbon";
import { MessageReferenceType, StickerFormatType } from "discord-api-types/v10";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchRemoteMedia = vi.fn();
const saveMediaBuffer = vi.fn();

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    fetchRemoteMedia: (...args: unknown[]) => fetchRemoteMedia(...args),
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

let __resetDiscordChannelInfoCacheForTest: typeof import("./message-utils.js").__resetDiscordChannelInfoCacheForTest;
let resolveDiscordChannelInfo: typeof import("./message-utils.js").resolveDiscordChannelInfo;
let resolveDiscordMessageChannelId: typeof import("./message-utils.js").resolveDiscordMessageChannelId;
let resolveDiscordMessageText: typeof import("./message-utils.js").resolveDiscordMessageText;
let resolveForwardedMediaList: typeof import("./message-utils.js").resolveForwardedMediaList;
let resolveMediaList: typeof import("./message-utils.js").resolveMediaList;

beforeAll(async () => {
  ({
    __resetDiscordChannelInfoCacheForTest,
    resolveDiscordChannelInfo,
    resolveDiscordMessageChannelId,
    resolveDiscordMessageText,
    resolveForwardedMediaList,
    resolveMediaList,
  } = await import("./message-utils.js"));
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

function expectDiscordCdnSsrFPolicy(policy: unknown) {
  expect(policy).toEqual(
    expect.objectContaining({
      allowRfc2544BenchmarkRange: true,
      hostnameAllowlist: expect.arrayContaining(DISCORD_CDN_HOSTNAMES),
    }),
  );
}

function expectSinglePngDownload(params: {
  result: unknown;
  expectedUrl: string;
  filePathHint: string;
  expectedPath: string;
  placeholder: "<media:image>" | "<media:sticker>";
}) {
  expect(fetchRemoteMedia).toHaveBeenCalledTimes(1);
  const call = fetchRemoteMedia.mock.calls[0]?.[0] as {
    url?: string;
    filePathHint?: string;
    maxBytes?: number;
    fetchImpl?: unknown;
    readIdleTimeoutMs?: number;
    requestInit?: { signal?: AbortSignal };
    ssrfPolicy?: unknown;
  };
  expect(call).toMatchObject({
    url: params.expectedUrl,
    filePathHint: params.filePathHint,
    maxBytes: 512,
    fetchImpl: undefined,
  });
  expectDiscordCdnSsrFPolicy(call.ssrfPolicy);
  expect(saveMediaBuffer).toHaveBeenCalledTimes(1);
  expect(saveMediaBuffer).toHaveBeenCalledWith(expect.any(Buffer), "image/png", "inbound", 512);
  expect(params.result).toEqual([
    {
      path: params.expectedPath,
      contentType: "image/png",
      placeholder: params.placeholder,
    },
  ]);
}

function expectAttachmentImageFallback(params: { result: unknown; attachment: { url: string } }) {
  expect(saveMediaBuffer).not.toHaveBeenCalled();
  expect(params.result).toEqual([
    {
      path: params.attachment.url,
      contentType: "image/png",
      placeholder: "<media:image>",
    },
  ]);
}

function asForwardedSnapshotMessage(params: {
  content: string;
  embeds: Array<{ title?: string; description?: string }>;
}) {
  return asMessage({
    content: "",
    rawData: {
      message_snapshots: [
        {
          message: {
            content: params.content,
            embeds: params.embeds,
            attachments: [],
            author: {
              id: "u2",
              username: "Bob",
              discriminator: "0",
            },
          },
        },
      ],
    },
  });
}

function asReferencedForwardMessage(params: {
  content?: string;
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
      attachments: params.attachments ?? [],
      embeds: params.embeds ?? [],
      stickers: [],
      author: {
        id: "u2",
        username: "Bob",
        discriminator: "0",
      },
    }),
  });
}

describe("resolveDiscordMessageChannelId", () => {
  it.each([
    {
      name: "uses message.channelId when present",
      params: { message: asMessage({ channelId: " 123 " }) },
      expected: "123",
    },
    {
      name: "falls back to message.channel_id",
      params: { message: asMessage({ channel_id: " 234 " }) },
      expected: "234",
    },
    {
      name: "falls back to message.rawData.channel_id",
      params: { message: asMessage({ rawData: { channel_id: "456" } }) },
      expected: "456",
    },
    {
      name: "falls back to eventChannelId and coerces numeric values",
      params: { message: asMessage({}), eventChannelId: 789 },
      expected: "789",
    },
  ] as const)("$name", ({ params, expected }) => {
    expect(resolveDiscordMessageChannelId(params)).toBe(expected);
  });
});

describe("resolveForwardedMediaList", () => {
  beforeEach(() => {
    fetchRemoteMedia.mockClear();
    saveMediaBuffer.mockClear();
  });

  it("downloads forwarded attachments", async () => {
    const attachment = {
      id: "att-1",
      url: "https://cdn.discordapp.com/attachments/1/image.png",
      filename: "image.png",
      content_type: "image/png",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
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
      placeholder: "<media:image>",
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
    fetchRemoteMedia.mockResolvedValueOnce({
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

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ fetchImpl: proxyFetch }),
    );
  });

  it("keeps forwarded attachment metadata when download fails", async () => {
    const attachment = {
      id: "att-fallback",
      url: "https://cdn.discordapp.com/attachments/1/fallback.png",
      filename: "fallback.png",
      content_type: "image/png",
    };
    fetchRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

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
    fetchRemoteMedia.mockResolvedValueOnce({
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
      placeholder: "<media:sticker>",
    });
  });

  it("returns empty when no snapshots are present", async () => {
    const result = await resolveForwardedMediaList(asMessage({}), 512);

    expect(result).toEqual([]);
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
  });

  it("downloads forwarded referenced attachments when snapshots are absent", async () => {
    const attachment = {
      id: "att-ref-1",
      url: "https://cdn.discordapp.com/attachments/1/ref-image.png",
      filename: "ref-image.png",
      content_type: "image/png",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
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
      placeholder: "<media:image>",
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

    expect(result).toEqual([]);
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
  });

  it("passes readIdleTimeoutMs to forwarded attachment downloads", async () => {
    const attachment = {
      id: "att-timeout-forwarded",
      url: "https://cdn.discordapp.com/attachments/1/forwarded-timeout.png",
      filename: "forwarded-timeout.png",
      content_type: "image/png",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
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

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ readIdleTimeoutMs: 60_000 }),
    );
  });

  it("passes readIdleTimeoutMs to forwarded sticker downloads", async () => {
    const sticker = {
      id: "sticker-timeout-forwarded",
      name: "timeout-forwarded",
      format_type: StickerFormatType.PNG,
    };
    fetchRemoteMedia.mockResolvedValueOnce({
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

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ readIdleTimeoutMs: 60_000 }),
    );
  });
});

describe("resolveMediaList", () => {
  beforeEach(() => {
    fetchRemoteMedia.mockClear();
    saveMediaBuffer.mockClear();
  });

  it("downloads stickers", async () => {
    const sticker = {
      id: "sticker-2",
      name: "hello",
      format_type: StickerFormatType.PNG,
    };
    fetchRemoteMedia.mockResolvedValueOnce({
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
      placeholder: "<media:sticker>",
    });
  });

  it("forwards fetchImpl to sticker downloads", async () => {
    const proxyFetch = vi.fn() as unknown as typeof fetch;
    const sticker = {
      id: "sticker-proxy",
      name: "proxy-sticker",
      format_type: StickerFormatType.PNG,
    };
    fetchRemoteMedia.mockResolvedValueOnce({
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

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ fetchImpl: proxyFetch }),
    );
  });

  it("keeps attachment metadata when download fails", async () => {
    const attachment = {
      id: "att-main-fallback",
      url: "https://cdn.discordapp.com/attachments/1/main-fallback.png",
      filename: "main-fallback.png",
      content_type: "image/png",
    };
    fetchRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(
      asMessage({
        attachments: [attachment],
      }),
      512,
    );

    expectAttachmentImageFallback({ result, attachment });
  });

  it("skips attachments without a usable URL", async () => {
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

    expect(fetchRemoteMedia).not.toHaveBeenCalled();
    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("classifies audio attachments by filename when content type is missing", async () => {
    const attachment = {
      id: "att-audio-fallback",
      url: "https://cdn.discordapp.com/attachments/1/voice.ogg",
      filename: "voice.ogg",
    };
    fetchRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(
      asMessage({
        attachments: [attachment],
      }),
      512,
    );

    expect(result).toEqual([
      {
        path: attachment.url,
        contentType: undefined,
        placeholder: "<media:audio>",
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
    fetchRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(
      asMessage({
        attachments: [attachment],
      }),
      512,
    );

    expect(result).toEqual([
      {
        path: attachment.url,
        contentType: undefined,
        placeholder: "<media:audio>",
      },
    ]);
  });

  it("falls back to URL when saveMediaBuffer fails", async () => {
    const attachment = {
      id: "att-save-fail",
      url: "https://cdn.discordapp.com/attachments/1/photo.png",
      filename: "photo.png",
      content_type: "image/png",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
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

    expect(fetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(saveMediaBuffer).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        path: attachment.url,
        contentType: "image/png",
        placeholder: "<media:image>",
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

    fetchRemoteMedia
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
        placeholder: "<media:image>",
      },
      {
        path: badAttachment.url,
        contentType: "application/pdf",
        placeholder: "<media:document>",
      },
    ]);
  });

  it("keeps sticker metadata when sticker download fails", async () => {
    const sticker = {
      id: "sticker-fallback",
      name: "fallback",
      format_type: StickerFormatType.PNG,
    };
    fetchRemoteMedia.mockRejectedValueOnce(new Error("blocked by ssrf guard"));

    const result = await resolveMediaList(
      asMessage({
        stickers: [sticker],
      }),
      512,
    );

    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        path: "https://media.discordapp.net/stickers/sticker-fallback.png",
        contentType: "image/png",
        placeholder: "<media:sticker>",
      },
    ]);
  });

  it("passes readIdleTimeoutMs to fetchRemoteMedia for attachments", async () => {
    const attachment = {
      id: "att-timeout",
      url: "https://cdn.discordapp.com/attachments/1/timeout.png",
      filename: "timeout.png",
      content_type: "image/png",
    };
    fetchRemoteMedia.mockResolvedValueOnce({
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

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ readIdleTimeoutMs: 60_000 }),
    );
  });

  it("passes readIdleTimeoutMs to fetchRemoteMedia for stickers", async () => {
    const sticker = {
      id: "sticker-timeout",
      name: "timeout",
      format_type: StickerFormatType.PNG,
    };
    fetchRemoteMedia.mockResolvedValueOnce({
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

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ readIdleTimeoutMs: 60_000 }),
    );
  });

  it("times out slow attachment downloads and returns fallback", async () => {
    const attachment = {
      id: "att-total-timeout",
      url: "https://cdn.discordapp.com/attachments/1/slow.png",
      filename: "slow.png",
      content_type: "image/png",
    };
    vi.useFakeTimers();
    fetchRemoteMedia.mockImplementation(
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
          path: attachment.url,
          contentType: "image/png",
          placeholder: "<media:image>",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes abortSignal to fetchRemoteMedia and falls back when aborted", async () => {
    const attachment = {
      id: "att-abort",
      url: "https://cdn.discordapp.com/attachments/1/abort.png",
      filename: "abort.png",
      content_type: "image/png",
    };
    const abortController = new AbortController();
    fetchRemoteMedia.mockImplementationOnce(
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
        path: attachment.url,
        contentType: "image/png",
        placeholder: "<media:image>",
      },
    ]);
    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        requestInit: expect.objectContaining({ signal: abortController.signal }),
      }),
    );
  });
});

describe("Discord media SSRF policy", () => {
  beforeEach(() => {
    fetchRemoteMedia.mockClear();
    saveMediaBuffer.mockClear();
  });

  it("passes Discord CDN hostname allowlist with RFC2544 enabled", async () => {
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("img"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/a.png",
      contentType: "image/png",
    });

    await resolveMediaList(
      asMessage({
        attachments: [{ id: "a1", url: "https://cdn.discordapp.com/a.png", filename: "a.png" }],
      }),
      1024,
    );

    const policy = fetchRemoteMedia.mock.calls[0]?.[0]?.ssrfPolicy;
    expectDiscordCdnSsrFPolicy(policy);
  });

  it("merges provided ssrfPolicy with Discord CDN defaults", async () => {
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("img"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/b.png",
      contentType: "image/png",
    });

    await resolveMediaList(
      asMessage({
        attachments: [{ id: "b1", url: "https://cdn.discordapp.com/b.png", filename: "b.png" }],
      }),
      1024,
      {
        ssrfPolicy: {
          allowPrivateNetwork: true,
          hostnameAllowlist: ["assets.example.com"],
          allowedHostnames: ["assets.example.com"],
        },
      },
    );

    const policy = fetchRemoteMedia.mock.calls[0]?.[0]?.ssrfPolicy;
    expect(policy).toEqual(
      expect.objectContaining({
        allowPrivateNetwork: true,
        allowRfc2544BenchmarkRange: true,
        allowedHostnames: expect.arrayContaining(["assets.example.com"]),
        hostnameAllowlist: expect.arrayContaining(["assets.example.com", ...DISCORD_CDN_HOSTNAMES]),
      }),
    );
  });
});

describe("resolveDiscordMessageText", () => {
  it("includes forwarded message snapshots in body text", () => {
    const text = resolveDiscordMessageText(
      asForwardedSnapshotMessage({
        content: "forwarded hello",
        embeds: [],
      }),
      { includeForwarded: true },
    );

    expect(text).toContain("[Forwarded message from @Bob]");
    expect(text).toContain("forwarded hello");
  });

  it("falls back to referenced forward message text when snapshots are absent", () => {
    const text = resolveDiscordMessageText(
      asReferencedForwardMessage({
        content: "forwarded from referenced message",
      }),
      { includeForwarded: true },
    );

    expect(text).toContain("[Forwarded message from @Bob]");
    expect(text).toContain("forwarded from referenced message");
  });

  it("does not treat ordinary replies as forwarded context", () => {
    const text = resolveDiscordMessageText(
      asReferencedForwardMessage({
        content: "quoted reply content",
        messageReferenceType: MessageReferenceType.Default,
      }),
      { includeForwarded: true },
    );

    expect(text).toBe("");
  });

  it("resolves user mentions in content", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "Hello <@123> and <@456>!",
        mentionedUsers: [
          { id: "123", username: "alice", globalName: "Alice Wonderland", discriminator: "0" },
          { id: "456", username: "bob", discriminator: "0" },
        ],
      }),
    );
    expect(text).toBe("Hello @Alice Wonderland and @bob!");
  });

  it("leaves content unchanged if no mentions present", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "Hello world",
        mentionedUsers: [],
      }),
    );
    expect(text).toBe("Hello world");
  });

  it("uses sticker placeholders when content is empty", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "",
        stickers: [
          {
            id: "sticker-3",
            name: "party",
            format_type: StickerFormatType.PNG,
          },
        ],
      }),
    );

    expect(text).toBe("<media:sticker> (1 sticker)");
  });

  it("uses embed title when content is empty", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "",
        embeds: [{ title: "Breaking" }],
      }),
    );

    expect(text).toBe("Breaking");
  });

  it("uses embed description when content is empty", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "",
        embeds: [{ description: "Details" }],
      }),
    );

    expect(text).toBe("Details");
  });

  it("joins embed title and description when content is empty", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "",
        embeds: [{ title: "Breaking", description: "Details" }],
      }),
    );

    expect(text).toBe("Breaking\nDetails");
  });

  it("prefers message content over embed fallback text", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "hello from content",
        embeds: [{ title: "Breaking", description: "Details" }],
      }),
    );

    expect(text).toBe("hello from content");
  });

  it("joins forwarded snapshot embed title and description when content is empty", () => {
    const text = resolveDiscordMessageText(
      asForwardedSnapshotMessage({
        content: "",
        embeds: [{ title: "Forwarded title", description: "Forwarded details" }],
      }),
      { includeForwarded: true },
    );

    expect(text).toContain("[Forwarded message from @Bob]");
    expect(text).toContain("Forwarded title\nForwarded details");
  });
});

describe("resolveDiscordChannelInfo", () => {
  beforeEach(() => {
    __resetDiscordChannelInfoCacheForTest();
  });

  it("caches channel lookups between calls", async () => {
    const fetchChannel = vi.fn().mockResolvedValue({
      type: ChannelType.DM,
      name: "dm",
    });
    const client = { fetchChannel } as unknown as Client;

    const first = await resolveDiscordChannelInfo(client, "cache-channel-1");
    const second = await resolveDiscordChannelInfo(client, "cache-channel-1");

    expect(first).toEqual({
      type: ChannelType.DM,
      name: "dm",
      topic: undefined,
      parentId: undefined,
      ownerId: undefined,
    });
    expect(second).toEqual(first);
    expect(fetchChannel).toHaveBeenCalledTimes(1);
  });

  it("negative-caches missing channels", async () => {
    const fetchChannel = vi.fn().mockResolvedValue(null);
    const client = { fetchChannel } as unknown as Client;

    const first = await resolveDiscordChannelInfo(client, "missing-channel");
    const second = await resolveDiscordChannelInfo(client, "missing-channel");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchChannel).toHaveBeenCalledTimes(1);
  });
});
