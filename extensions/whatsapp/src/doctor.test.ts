import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor.js";

describe("whatsapp doctor compatibility", () => {
  it("does not add whatsapp config when the channel is not configured", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        messages: {
          ackReaction: "👀",
          ackReactionScope: "group-mentions",
        },
      },
    });

    expect(result.config.channels?.whatsapp).toBeUndefined();
    expect(result.changes).toEqual([]);
  });

  it("copies legacy ack reaction into configured whatsapp channel", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        messages: {
          ackReaction: "👀",
          ackReactionScope: "group-mentions",
        },
        channels: {
          whatsapp: {
            accounts: {
              work: {
                authDir: "/tmp/openclaw-wa-auth",
              },
            },
          },
        },
      },
    });

    expect(result.config.channels?.whatsapp?.ackReaction).toEqual({
      emoji: "👀",
      direct: false,
      group: "mentions",
    });
    expect(result.changes).toEqual([
      "Copied messages.ackReaction → channels.whatsapp.ackReaction (scope: group-mentions).",
    ]);
  });

  it("keeps existing whatsapp ack reaction", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        messages: {
          ackReaction: "👀",
          ackReactionScope: "all",
        },
        channels: {
          whatsapp: {
            ackReaction: {
              emoji: "✅",
              direct: true,
              group: "always",
            },
          },
        },
      },
    });

    expect(result.config.channels?.whatsapp?.ackReaction).toEqual({
      emoji: "✅",
      direct: true,
      group: "always",
    });
    expect(result.changes).toEqual([]);
  });
});
