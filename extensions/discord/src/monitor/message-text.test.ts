import {
  ComponentType,
  MessageFlags,
  MessageReferenceType,
  StickerFormatType,
} from "discord-api-types/v10";
import { beforeAll, describe, expect, it } from "vitest";
import type { Message } from "../internal/discord.js";

let resolveDiscordMessageText: typeof import("./message-utils.js").resolveDiscordMessageText;
let resolveDiscordMessageHistoryText: typeof import("./message-utils.js").resolveDiscordMessageHistoryText;

beforeAll(async () => {
  ({ resolveDiscordMessageHistoryText, resolveDiscordMessageText } =
    await import("./message-utils.js"));
});

function asMessage(payload: Record<string, unknown>): Message {
  return payload as unknown as Message;
}

function asForwardedSnapshotMessage(params: {
  content: string;
  embeds: Array<{ title?: string; description?: string }>;
  attachments?: Array<Record<string, unknown>>;
}) {
  return asMessage({
    content: "",
    rawData: {
      message_snapshots: [
        {
          message: {
            content: params.content,
            embeds: params.embeds,
            attachments: params.attachments ?? [],
            author: { id: "u2", username: "Bob", discriminator: "0" },
          },
        },
      ],
    },
  });
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
      author: { id: "u2", username: "Bob", discriminator: "0" },
    }),
  });
}

describe("resolveDiscordMessageText", () => {
  it("renders definitive video MIME as video on history text carriers", () => {
    expect(
      resolveDiscordMessageHistoryText(
        asMessage({
          content: "",
          attachments: [{ filename: "clip.mp4", content_type: "video/mp4" }],
        }),
      ),
    ).toBe("<media:video>");
  });

  it("includes forwarded message snapshots in body text", () => {
    const text = resolveDiscordMessageText(
      asForwardedSnapshotMessage({ content: "forwarded hello", embeds: [] }),
      { includeForwarded: true },
    );

    expect(text).toContain("[Forwarded message from @Bob]");
    expect(text).toContain("forwarded hello");
  });

  it("falls back to referenced forward message text when snapshots are absent", () => {
    const text = resolveDiscordMessageText(
      asReferencedForwardMessage({ content: "forwarded from referenced message" }),
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
      asMessage({ content: "Hello world", mentionedUsers: [] }),
    );
    expect(text).toBe("Hello world");
  });

  it("keeps the primary body empty for sticker-only messages", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "",
        stickers: [{ id: "sticker-3", name: "party", format_type: StickerFormatType.PNG }],
      }),
    );

    expect(text).toBe("");
  });

  it("renders forwarded media facts as text without the legacy single-item count", () => {
    const attachmentText = resolveDiscordMessageText(
      asMessage({
        content: "",
        rawData: {
          message_snapshots: [
            {
              message: {
                content: "",
                embeds: [],
                attachments: [
                  {
                    id: "forwarded-image",
                    filename: "forwarded.png",
                    content_type: "image/png",
                    url: "https://cdn.discordapp.com/forwarded.png",
                  },
                ],
                author: { id: "u2", username: "Bob", discriminator: "0" },
              },
            },
          ],
        },
      }),
      { includeForwarded: true },
    );

    expect(attachmentText).toContain("<media:image>");
    expect(attachmentText).not.toContain("(1 image)");
  });

  it("renders forwarded captions together with their media facts", () => {
    const text = resolveDiscordMessageText(
      asForwardedSnapshotMessage({
        content: "look at this",
        embeds: [],
        attachments: [
          {
            id: "forwarded-image",
            filename: "forwarded.png",
            content_type: "image/png",
            url: "https://cdn.discordapp.com/forwarded.png",
          },
        ],
      }),
      { includeForwarded: true },
    );

    expect(text).toContain("look at this\n<media:image>");
  });

  it("preserves audio classification in forwarded text-only previews", () => {
    const text = resolveDiscordMessageText(
      asForwardedSnapshotMessage({
        content: "",
        embeds: [],
        attachments: [
          {
            id: "forwarded-audio",
            filename: "voice.ogg",
            content_type: "audio/ogg",
            url: "https://cdn.discordapp.com/voice.ogg",
          },
        ],
      }),
      { includeForwarded: true },
    );

    expect(text).toContain("<media:audio>");
  });

  it("uses embed title when content is empty", () => {
    expect(
      resolveDiscordMessageText(asMessage({ content: "", embeds: [{ title: "Breaking" }] })),
    ).toBe("Breaking");
  });

  it("uses Components v2 text display content when normal message text is empty", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "",
        flags: MessageFlags.IsComponentsV2,
        components: [
          {
            type: ComponentType.Container,
            components: [
              { type: ComponentType.TextDisplay, content: "Component headline" },
              {
                type: ComponentType.Section,
                components: [{ type: ComponentType.TextDisplay, content: "Component body" }],
                accessory: { type: ComponentType.Thumbnail, media: { url: "attachment://x.png" } },
              },
            ],
          },
        ],
      }),
    );

    expect(text).toBe("Component headline\nComponent body");
  });

  it("uses Components v2 text display content from referenced reply messages", () => {
    const text = resolveDiscordMessageText(
      asReferencedForwardMessage({
        components: [
          {
            type: ComponentType.Container,
            components: [{ type: ComponentType.TextDisplay, content: "Referenced component text" }],
          },
        ],
        messageReferenceType: MessageReferenceType.Default,
      }).referencedMessage!,
    );

    expect(text).toBe("Referenced component text");
  });

  it("uses embed description when content is empty", () => {
    expect(
      resolveDiscordMessageText(asMessage({ content: "", embeds: [{ description: "Details" }] })),
    ).toBe("Details");
  });

  it("joins embed title and description when content is empty", () => {
    expect(
      resolveDiscordMessageText(
        asMessage({ content: "", embeds: [{ title: "Breaking", description: "Details" }] }),
      ),
    ).toBe("Breaking\nDetails");
  });

  it("prefers message content over embed fallback text", () => {
    expect(
      resolveDiscordMessageText(
        asMessage({
          content: "hello from content",
          embeds: [{ title: "Breaking", description: "Details" }],
        }),
      ),
    ).toBe("hello from content");
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

  it("includes Components v2 text display content from forwarded snapshots", () => {
    const text = resolveDiscordMessageText(
      asMessage({
        content: "",
        rawData: {
          message_snapshots: [
            {
              message: {
                content: "",
                embeds: [],
                attachments: [],
                components: [
                  {
                    type: ComponentType.Container,
                    components: [
                      { type: ComponentType.TextDisplay, content: "Forwarded component text" },
                    ],
                  },
                ],
                author: { id: "u2", username: "Bob", discriminator: "0" },
              },
            },
          ],
        },
      }),
      { includeForwarded: true },
    );

    expect(text).toContain("[Forwarded message from @Bob]");
    expect(text).toContain("Forwarded component text");
  });
});
