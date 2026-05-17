import { describe, expect, it } from "vitest";
import { normalizeAttachments } from "../../media-understanding/attachments.normalize.js";
import {
  buildChannelInboundMediaPayload,
  toHistoryMediaEntries,
  toInboundMediaFacts,
} from "./media.js";

describe("channel inbound media facts", () => {
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
