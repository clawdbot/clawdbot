// Irc tests cover doctor mutable allowlist warnings.
import { describe, expect, it } from "vitest";
import { collectIrcMutableAllowlistWarnings } from "./doctor.js";

describe("collectIrcMutableAllowlistWarnings", () => {
  it("warns on a host-less nick!user allowlist entry", () => {
    const warnings = collectIrcMutableAllowlistWarnings({
      cfg: {
        channels: {
          irc: {
            allowFrom: ["alice!ident"],
          },
        },
      } as never,
    });
    expect(warnings).toContain("- channels.irc.allowFrom: alice!ident");
  });

  it("does not warn on a full nick!user@host allowlist entry", () => {
    const warnings = collectIrcMutableAllowlistWarnings({
      cfg: {
        channels: {
          irc: {
            allowFrom: ["alice!ident@example.com"],
          },
        },
      } as never,
    });
    expect(warnings).toStrictEqual([]);
  });
});
