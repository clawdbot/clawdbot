// Tlon tests cover send plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@urbit/aura", () => ({
  scot: vi.fn(() => "mocked-ud"),
  da: {
    fromUnix: vi.fn(() => 123n),
  },
}));

describe("sendDm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses aura v3 helpers for the DM id", async () => {
    const { sendDm } = await import("./send.js");
    const aura = await import("@urbit/aura");
    const scot = vi.mocked(aura.scot);
    const fromUnix = vi.mocked(aura.da.fromUnix);

    const sentAt = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(sentAt);

    const poke = vi.fn(async () => ({}));

    const result = await sendDm({
      api: { poke },
      fromShip: "~zod",
      toShip: "~nec",
      text: "hi",
    });

    expect(fromUnix).toHaveBeenCalledWith(sentAt);
    expect(scot).toHaveBeenCalledWith("ud", 123n);
    expect(poke).toHaveBeenCalledTimes(1);
    expect(result.messageId).toBe("~zod/mocked-ud");
    expect(result.receipt.primaryPlatformMessageId).toBe("~zod/mocked-ud");
  });

  it("passes numeric group reply ids through aura formatting", async () => {
    const { sendGroupMessage } = await import("./send.js");
    const aura = await import("@urbit/aura");
    const scot = vi.mocked(aura.scot);
    scot.mockReturnValueOnce("~2024.1.1");
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const poke = vi.fn(async () => ({}));

    const result = await sendGroupMessage({
      api: { poke },
      fromShip: "~zod",
      hostShip: "~nec",
      channelName: "general",
      text: "threaded",
      replyToId: "1700000000000",
    });

    expect(scot).toHaveBeenCalledWith("ud", 1_700_000_000_000n);
    expect(poke).toHaveBeenCalledWith({
      app: "channels",
      mark: "channel-action-1",
      json: {
        channel: {
          nest: "chat/~nec/general",
          action: {
            post: {
              reply: {
                id: "~2024.1.1",
                action: {
                  add: {
                    content: [{ inline: ["threaded"] }],
                    author: "~zod",
                    sent: 1_700_000_000_000,
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(result.receipt.threadId).toBe("~nec/general");
  });
});

describe("buildMediaStory", () => {
  it("keeps image URLs with fragments as image blocks", async () => {
    const { buildMediaStory } = await import("./send.js");

    expect(buildMediaStory("caption", "https://cdn.example/image.png#preview")).toEqual([
      { inline: ["caption"] },
      {
        block: {
          image: {
            src: "https://cdn.example/image.png#preview",
            height: 0,
            width: 0,
            alt: "",
          },
        },
      },
    ]);
  });

  it("keeps image URLs with queries as image blocks", async () => {
    const { buildMediaStory } = await import("./send.js");

    expect(buildMediaStory(undefined, "https://cdn.example/image.png?token=1")).toEqual([
      {
        block: {
          image: {
            src: "https://cdn.example/image.png?token=1",
            height: 0,
            width: 0,
            alt: "",
          },
        },
      },
    ]);
  });

  it("keeps non-image URL paths with image-looking fragments as links", async () => {
    const { buildMediaStory } = await import("./send.js");

    expect(buildMediaStory("caption", "https://cdn.example/page#preview.png")).toEqual([
      { inline: ["caption"] },
      {
        inline: [
          {
            link: {
              href: "https://cdn.example/page#preview.png",
              content: "https://cdn.example/page#preview.png",
            },
          },
        ],
      },
    ]);
  });
});
