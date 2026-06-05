// Discord tests cover message handler.process.abort skip plugin behavior.
import { describe, expect, it } from "vitest";
import { formatDiscordReplySkip } from "./message-handler.process.js";

describe("formatDiscordReplySkip", () => {
  it("includes target and session when both are present for an aborted skip", () => {
    expect(
      formatDiscordReplySkip({
        kind: "final",
        reason: "aborted before delivery",
        target: "channel:123",
        sessionKey: "agent:main:discord:channel:123",
      }),
    ).toBe(
      "discord final reply skipped (aborted before delivery): target=channel:123 session=agent:main:discord:channel:123",
    );
  });

  it("renders the reasoning-payload reason with the same shape", () => {
    expect(
      formatDiscordReplySkip({
        kind: "block",
        reason: "reasoning payload",
        target: "channel:456",
        sessionKey: "agent:friday:discord:channel:456",
      }),
    ).toBe(
      "discord block reply skipped (reasoning payload): target=channel:456 session=agent:friday:discord:channel:456",
    );
  });

  it("omits the session tag when sessionKey is undefined", () => {
    expect(
      formatDiscordReplySkip({
        kind: "tool",
        reason: "aborted before delivery",
        target: "channel:456",
      }),
    ).toBe("discord tool reply skipped (aborted before delivery): target=channel:456");
  });

  it("treats an empty-string sessionKey the same as undefined", () => {
    expect(
      formatDiscordReplySkip({
        kind: "tool",
        reason: "reasoning payload",
        target: "channel:c1",
        sessionKey: "",
      }),
    ).toBe("discord tool reply skipped (reasoning payload): target=channel:c1");
  });

  it("preserves the kind discriminant in the message prefix", () => {
    for (const kind of ["tool", "block", "final"] as const) {
      expect(
        formatDiscordReplySkip({
          kind,
          reason: "aborted before delivery",
          target: "channel:1",
          sessionKey: "s",
        }),
      ).toContain(`discord ${kind} reply skipped`);
    }
  });
});
