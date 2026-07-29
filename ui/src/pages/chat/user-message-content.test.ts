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
});
