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

  it("reports acknowledgement behavior that the global settings cannot preserve", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        agents: { entries: { main: { default: true, identity: { emoji: "🔥" } } } },
        channels: {
          whatsapp: {
            ackReaction: {
              direct: true,
              group: "mentions",
            },
          },
        },
      },
    });

    expect(result.config.channels?.whatsapp?.ackReaction).toBeUndefined();
    expect(result.config.messages).toEqual({ ackReaction: "🔥" });
    expect(result.changes.join("\n")).toContain(
      "cannot preserve both direct-message and mentioned-group acknowledgements",
    );
  });

  it("reports scope conflicts after root settings win", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          whatsapp: {
            ackReaction: { emoji: "👀", direct: false, group: "always" },
            accounts: {
              work: { ackReaction: { emoji: "✅", direct: true, group: "never" } },
            },
          },
        },
      },
    });

    expect(result.config.messages).toMatchObject({
      ackReaction: "👀",
      ackReactionScope: "group-all",
    });
    expect(result.changes.join("\n")).toContain(
      'channels.whatsapp.accounts.work.ackReaction requested acknowledgement scope "direct", but the final messages.ackReactionScope is "group-all"',
    );
  });

  it('treats legacy "off" and canonical "none" scopes as equivalent', () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        messages: { ackReaction: "👀", ackReactionScope: "none" },
        channels: {
          whatsapp: {
            ackReaction: { emoji: "👀", direct: false, group: "never" },
          },
        },
      },
    });

    expect(result.config.messages?.ackReactionScope).toBe("none");
    expect(result.changes).toStrictEqual([
      "Moved translatable channels.whatsapp.ackReaction settings to messages ack settings.",
    ]);
  });
});
