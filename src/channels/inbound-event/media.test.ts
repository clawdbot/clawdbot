// Inbound event media tests cover channel media attachment normalization.
import { describe, expect, it } from "vitest";
import { normalizeAttachments } from "../../media-understanding/attachments.normalize.js";
import {
  buildChannelInboundMediaPayload,
  formatMediaPlaceholderText,
  formatInboundMediaUnavailableText,
  toHistoryMediaEntries,
  toInboundMediaFacts,
} from "./media.js";

describe("channel inbound media facts", () => {
  it("formats media placeholder text with kind precedence and normalized MIME fallback", () => {
    expect(
      formatMediaPlaceholderText([
        { kind: "document", contentType: "image/png", path: "/tmp/photo.jpg" },
      ]),
    ).toBe("<media:document>");
    expect(formatMediaPlaceholderText([{ contentType: " IMAGE/PNG; charset=binary " }])).toBe(
      "<media:image>",
    );
    expect(
      formatMediaPlaceholderText([{ url: "https://example.test/uploads/clip.MP4?download=1" }]),
    ).toBe("<media:video>");
  });

  it("counts homogeneous media and collapses mixed kinds deterministically", () => {
    expect(formatMediaPlaceholderText([{ kind: "image" }, { contentType: "image/jpeg" }])).toBe(
      "<media:image> (2 images)",
    );
    expect(formatMediaPlaceholderText([{ kind: "image" }, { path: "/tmp/voice-note.mp3" }])).toBe(
      "<media:document> (2 files)",
    );
    expect(formatMediaPlaceholderText([{ kind: "image" }, {}])).toBe(
      "<media:attachment> (2 attachments)",
    );
    expect(formatMediaPlaceholderText([{ kind: "sticker" }])).toBe("<media:sticker>");
    expect(formatMediaPlaceholderText([{ kind: "sticker" }, { kind: "sticker" }])).toBe(
      "<media:sticker> (2 stickers)",
    );
  });

  it("formats type-only attachment facts without filenames or a count side channel", () => {
    expect(formatMediaPlaceholderText([{}, {}, {}])).toBe("<media:attachment> (3 attachments)");
    expect(formatMediaPlaceholderText([])).toBe("");
  });

  it("replaces optimistic media placeholders and preserves real captions", () => {
    expect(
      formatInboundMediaUnavailableText({
        body: "<media:image>",
        mediaPlaceholder: "<media:image>",
        notice: "[test image attachment unavailable]",
      }),
    ).toBe("[test image attachment unavailable]");
    expect(
      formatInboundMediaUnavailableText({
        body: "please inspect this",
        mediaPlaceholder: "<media:image>",
        notice: "[test image attachment unavailable]",
      }),
    ).toBe("please inspect this\n\n[test image attachment unavailable]");
  });

  it("normalizes provider media into inbound media facts", () => {
    expect(
      toInboundMediaFacts(
        [
          {
            path: " /tmp/image.png ",
            contentType: " image/png ",
            messageId: " ",
          },
          {
            url: "https://example.test/audio.mp3",
            contentType: "audio/mpeg",
            kind: "audio",
          },
        ],
        {
          kind: "image",
          messageId: "msg-1",
          transcribed: (_media, index) => index === 1,
        },
      ),
    ).toEqual([
      {
        path: "/tmp/image.png",
        url: undefined,
        contentType: "image/png",
        kind: "image",
        transcribed: false,
        messageId: "msg-1",
      },
      {
        path: undefined,
        url: "https://example.test/audio.mp3",
        contentType: "audio/mpeg",
        kind: "audio",
        transcribed: true,
        messageId: "msg-1",
      },
    ]);
  });

  it("builds legacy media payload fields from inbound media facts", () => {
    expect(
      buildChannelInboundMediaPayload([
        { path: "/tmp/image.png", contentType: "image/png", kind: "image" },
        {
          url: "https://example.test/audio.mp3",
          contentType: "audio/mpeg",
          kind: "audio",
          transcribed: true,
        },
      ]),
    ).toEqual({
      MediaPath: "/tmp/image.png",
      MediaUrl: "/tmp/image.png",
      MediaType: "image/png",
      MediaPaths: ["/tmp/image.png", ""],
      MediaUrls: ["/tmp/image.png", "https://example.test/audio.mp3"],
      MediaTypes: ["image/png", "audio/mpeg"],
      MediaTranscribedIndexes: [1],
    });
  });

  it("keeps legacy media arrays index-aligned for mixed path and URL media", () => {
    const payload = buildChannelInboundMediaPayload([
      { path: "/tmp/image.png", contentType: "image/png", kind: "image" },
      { url: "https://example.test/remote.png", contentType: "image/png", kind: "image" },
    ]);

    expect(payload.MediaPaths).toEqual(["/tmp/image.png", ""]);
    expect(payload.MediaUrls).toEqual(["/tmp/image.png", "https://example.test/remote.png"]);
    expect(payload.MediaTypes).toEqual(["image/png", "image/png"]);
    expect(normalizeAttachments(payload)).toMatchObject([
      { path: "/tmp/image.png", url: "/tmp/image.png", mime: "image/png" },
      { path: undefined, url: "https://example.test/remote.png", mime: "image/png" },
    ]);
  });

  it("maps inbound media facts into history media entries", () => {
    expect(
      toHistoryMediaEntries([{ path: "/tmp/image.png", contentType: "image/png" }], {
        kind: "image",
        messageId: "msg-1",
      }),
    ).toEqual([
      {
        path: "/tmp/image.png",
        url: undefined,
        contentType: "image/png",
        kind: "image",
        messageId: "msg-1",
      },
    ]);
  });
});
