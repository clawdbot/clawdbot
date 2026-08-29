import { describe, expect, it } from "vitest";
import { renderReplyPayloadsToMessages } from "./messenger.js";

describe("msteams voice reply rendering", () => {
  it("preserves audioAsVoice on rendered audio media", () => {
    const messages = renderReplyPayloadsToMessages(
      [{ mediaUrl: "/tmp/reply.mp3", audioAsVoice: true }],
      { textChunkLimit: 4000, tableMode: "code" },
    );

    expect(messages).toEqual([{ mediaUrl: "/tmp/reply.mp3", audioAsVoice: true }]);
  });
});
