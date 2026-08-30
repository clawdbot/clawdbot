/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { buildLocalUserMessage } from "./user-message-content.ts";

function buildAttachmentContent(
  attachments: Parameters<typeof buildLocalUserMessage>[0]["attachments"],
) {
  return buildLocalUserMessage({ attachments, createdAt: 1, text: "" })?.content;
}

describe("buildUserChatMessageContentBlocks", () => {
  it("keeps staged video attachments typed as video content", () => {
    expect(
      buildAttachmentContent([
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
    const [block] =
      buildAttachmentContent([
        {
          id: `video-${fileName}-${mimeType}`,
          mimeType,
          fileName,
          previewUrl: `blob:${fileName}`,
        },
      ]) ?? [];

    expect(block?.attachment?.kind).toBe("video");
  });
});
