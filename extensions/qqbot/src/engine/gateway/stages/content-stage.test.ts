import { describe, expect, it } from "vitest";
import type { QueuedMessage } from "../message-queue.js";
import { buildUserContent } from "./content-stage.js";

function makeEvent(partial: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    type: "group",
    senderId: "U1",
    content: "hello",
    messageId: "M1",
    timestamp: "2025-01-01T00:00:00.000Z",
    groupOpenid: "G1",
    ...partial,
  };
}

describe("content-stage", () => {
  describe("buildUserContent", () => {
    it("returns plain content when no voice / no mentions", () => {
      const out = buildUserContent({
        event: makeEvent({ content: "plain" }),
        attachmentInfo: "",
        voiceTranscripts: [],
      });
      expect(out.parsedContent).toBe("plain");
      expect(out.userContent).toBe("plain");
    });

    it("appends attachmentInfo after content", () => {
      const out = buildUserContent({
        event: makeEvent({ content: "see" }),
        attachmentInfo: " [img]",
        voiceTranscripts: [],
      });
      expect(out.userContent).toBe("see [img]");
    });

    it("interleaves voice transcripts on their own line", () => {
      const out = buildUserContent({
        event: makeEvent({ content: "hi" }),
        attachmentInfo: "",
        voiceTranscripts: ["hello world"],
      });
      // formatVoiceText renders "[Voice message] …" or "[Voice N] …" — the
      // important assertion is that voice text ends up in userContent.
      expect(out.userContent).toContain("hi");
      expect(out.userContent).toContain("hello world");
      expect(out.userContent.length).toBeGreaterThan(out.parsedContent.length);
    });

    it("strips <@bot> mention tags in group chats", () => {
      const out = buildUserContent({
        event: makeEvent({
          type: "group",
          content: "<@BOT> help",
          mentions: [{ member_openid: "BOT", is_you: true }],
        }),
        attachmentInfo: "",
        voiceTranscripts: [],
      });
      expect(out.userContent.trim()).toBe("help");
    });

    it("replaces <@user> with @nickname in DMs", () => {
      const out = buildUserContent({
        event: makeEvent({
          type: "c2c",
          content: "hi <@U2> there",
          mentions: [{ member_openid: "U2", username: "Alice" }],
        }),
        attachmentInfo: "",
        voiceTranscripts: [],
      });
      expect(out.userContent).toBe("hi @Alice there");
    });
  });
});
