// Whatsapp tests cover doctor plugin behavior.
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
    expect(result.changes).toStrictEqual([]);
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
    expect(result.changes).toStrictEqual([]);
  });
});
