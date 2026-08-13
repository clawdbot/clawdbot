/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { buildUserChatMessageContentBlocks } from "./user-message-content.ts";

describe("buildUserChatMessageContentBlocks", () => {
  it("keeps staged video attachments typed as video content", () => {
    expect(
      buildUserChatMessageContentBlocks("", [
        {
          id: "video-1",
          mimeType: "video/mp4",
          fileName: "demo.mp4",
          previewUrl: "blob:demo-video",
        },
      ]),
    ).toEqual([
      {
        type: "attachment",
        attachment: {
          url: "blob:demo-video",
          kind: "video",
          label: "demo.mp4",
          mimeType: "video/mp4",
        },
      },
    ]);
  });

  it.each([
    ["clip.avi", ""],
    ["clip.mp4", ""],
    ["clip.mkv", ""],
    ["clip.mpeg", ""],
    ["clip.mpg", ""],
    ["clip.mkv", "application/octet-stream"],
  ])("falls back to the %s extension when MIME is %s", (fileName, mimeType) => {
    const [block] = buildUserChatMessageContentBlocks("", [
      {
        id: `video-${fileName}-${mimeType}`,
        mimeType,
        fileName,
        previewUrl: `blob:${fileName}`,
      },
    ]);

    expect(block?.attachment?.kind).toBe("video");
  });
});
