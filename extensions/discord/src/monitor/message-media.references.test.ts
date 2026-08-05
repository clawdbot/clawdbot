import { MessageReferenceType } from "discord-api-types/v10";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

let resolveMediaList: typeof import("./message-utils.js").resolveMediaList;
let resolveReferencedReplyMediaList: typeof import("./message-utils.js").resolveReferencedReplyMediaList;

beforeAll(async () => {
  ({ resolveMediaList, resolveReferencedReplyMediaList } = await import("./message-utils.js"));
});

beforeEach(() => {
  readRemoteMediaBuffer.mockReset();
  saveMediaBuffer.mockReset();
});

function asMessage(payload: Record<string, unknown>): Message {
  return payload as unknown as Message;
}

function asReferencedMessage(params: {
  referenceType: MessageReferenceType;
  attachments: Array<Record<string, unknown>>;
}): Message {
  return asMessage({
    messageReference: { type: params.referenceType },
    referencedMessage: asMessage({ attachments: params.attachments }),
  });
}

describe("resolveReferencedReplyMediaList", () => {
  it("downloads referenced reply attachments", async () => {
    const attachment = {
      id: "att-reply-1",
      url: "https://cdn.discordapp.com/attachments/1/reply-image.png",
      filename: "reply-image.png",
      content_type: "image/png",
    };
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/reply-image.png",
      contentType: "image/png",
    });

    const result = await resolveReferencedReplyMediaList(
      asReferencedMessage({
        referenceType: MessageReferenceType.Default,
        attachments: [attachment],
      }),
      512,
    );

    expect(result).toEqual([{ path: "/tmp/reply-image.png", contentType: "image/png" }]);
    expect(readRemoteMediaBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        url: attachment.url,
        filePathHint: attachment.filename,
        maxBytes: 512,
      }),
    );
  });

  it("ignores forwarded references", async () => {
    const result = await resolveReferencedReplyMediaList(
      asReferencedMessage({
        referenceType: MessageReferenceType.Forward,
        attachments: [
          {
            id: "att-forward-1",
            url: "https://cdn.discordapp.com/attachments/1/forward.png",
            filename: "forward.png",
            content_type: "image/png",
          },
        ],
      }),
      512,
    );

    expect(result).toEqual([]);
    expect(readRemoteMediaBuffer).not.toHaveBeenCalled();
  });
});

describe("Discord media SSRF policy", () => {
  it("passes Discord CDN hostname allowlist with RFC2544 enabled", async () => {
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("img"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({ path: "/tmp/a.png", contentType: "image/png" });

    await resolveMediaList(
      asMessage({
        attachments: [{ id: "a1", url: "https://cdn.discordapp.com/a.png", filename: "a.png" }],
      }),
      1024,
    );

    const call = readRemoteMediaBuffer.mock.calls[0]?.[0] as
      | { ssrfPolicy?: Record<string, unknown> }
      | undefined;
    expect(call?.ssrfPolicy?.allowRfc2544BenchmarkRange).toBe(true);
    expect(call?.ssrfPolicy?.hostnameAllowlist).toEqual(
      expect.arrayContaining(["cdn.discordapp.com", "media.discordapp.net"]),
    );
  });

  it("merges provided ssrfPolicy with Discord CDN defaults", async () => {
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("img"),
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({ path: "/tmp/b.png", contentType: "image/png" });

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

    const call = readRemoteMediaBuffer.mock.calls[0]?.[0] as
      | { ssrfPolicy?: Record<string, unknown> }
      | undefined;
    expect(call?.ssrfPolicy).toMatchObject({
      allowPrivateNetwork: true,
      allowRfc2544BenchmarkRange: true,
    });
    expect(call?.ssrfPolicy?.hostnameAllowlist).toEqual(
      expect.arrayContaining(["assets.example.com", "cdn.discordapp.com"]),
    );
  });
});
