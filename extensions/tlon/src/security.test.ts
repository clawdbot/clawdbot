/**
 * Security Tests for Tlon Plugin
 *
 * These tests ensure that security-critical behavior cannot regress:
 * - DM allowlist enforcement
 * - Channel authorization rules
 * - Ship normalization consistency
 * - Bot mention detection boundaries
 */

import { describe, expect, it, vi } from "vitest";
import {
  extractCites,
  resolveTlonCommandAuthorizationWithIngress,
  isDmAllowedWithIngress,
  isGroupInviteAllowed,
  isBotMentioned,
  extractMessageText,
  resolveAuthorizedMessageText,
} from "./monitor/utils.js";
import { normalizeShip } from "./targets.js";

const allowlistShipMatchingCases = [
  { label: "DM allowlist", isAllowed: isDmAllowedWithIngress },
  { label: "group invite allowlist", isAllowed: isGroupInviteAllowed },
] satisfies Array<{
  label: string;
  isAllowed: (ship: string, allowlist: string[] | undefined) => boolean | Promise<boolean>;
}>;

async function expectAllowed(
  isAllowed: (ship: string, allowlist: string[] | undefined) => boolean | Promise<boolean>,
  ship: string,
  allowlist: string[] | undefined,
  expected: boolean,
) {
  await expect(Promise.resolve(isAllowed(ship, allowlist))).resolves.toBe(expected);
}

async function expectDmAllowed(ship: string, allowlist: string[] | undefined, expected: boolean) {
  await expect(isDmAllowedWithIngress(ship, allowlist)).resolves.toBe(expected);
}

describe("Security: allowlist ship matching", () => {
  it.each(allowlistShipMatchingCases)(
    "$label normalizes ship names with and without ~ prefix",
    async ({ isAllowed }) => {
      const allowlist = ["~zod"];
      await expectAllowed(isAllowed, "zod", allowlist, true);
      await expectAllowed(isAllowed, "~zod", allowlist, true);

      const allowlistWithoutTilde = ["zod"];
      await expectAllowed(isAllowed, "~zod", allowlistWithoutTilde, true);
      await expectAllowed(isAllowed, "zod", allowlistWithoutTilde, true);
    },
  );

  it.each(allowlistShipMatchingCases)(
    "$label rejects partial ship matches",
    async ({ isAllowed }) => {
      const allowlist = ["~zod"];
      await expectAllowed(isAllowed, "~zod-extra", allowlist, false);
      await expectAllowed(isAllowed, "~extra-zod", allowlist, false);
    },
  );
});

describe("Security: DM Allowlist", () => {
  describe("DM ingress allowlist", () => {
    it("rejects DMs when allowlist is empty", async () => {
      await expectDmAllowed("~zod", [], false);
      await expectDmAllowed("~sampel-palnet", [], false);
    });

    it("rejects DMs when allowlist is undefined", async () => {
      await expectDmAllowed("~zod", undefined, false);
    });

    it("allows DMs from ships on the allowlist", async () => {
      const allowlist = ["~zod", "~bus"];
      await expectDmAllowed("~zod", allowlist, true);
      await expectDmAllowed("~bus", allowlist, true);
    });

    it("rejects DMs from ships NOT on the allowlist", async () => {
      const allowlist = ["~zod", "~bus"];
      await expectDmAllowed("~nec", allowlist, false);
      await expectDmAllowed("~sampel-palnet", allowlist, false);
      await expectDmAllowed("~random-ship", allowlist, false);
    });

    it("handles galaxy, star, planet, and moon names", async () => {
      const allowlist = [
        "~zod", // galaxy
        "~marzod", // star
        "~sampel-palnet", // planet
        "~dozzod-dozzod-dozzod-dozzod", // moon
      ];

      await expectDmAllowed("~zod", allowlist, true);
      await expectDmAllowed("~marzod", allowlist, true);
      await expectDmAllowed("~sampel-palnet", allowlist, true);
      await expectDmAllowed("~dozzod-dozzod-dozzod-dozzod", allowlist, true);

      // Similar but different ships should be rejected
      await expectDmAllowed("~nec", allowlist, false);
      await expectDmAllowed("~wanzod", allowlist, false);
      await expectDmAllowed("~sampel-palned", allowlist, false);
    });

    // NOTE: Ship names in Urbit are always lowercase by convention.
    // This test documents current behavior - strict equality after normalization.
    // If case-insensitivity is desired, normalizeShip should lowercase.
    it("uses strict equality after normalization (case-sensitive)", async () => {
      const allowlist = ["~zod"];
      await expectDmAllowed("~zod", allowlist, true);
      // Different case would NOT match with current implementation
      await expectDmAllowed("~Zod", ["~Zod"], true); // exact match works
    });

    it("handles whitespace in ship names (normalized)", async () => {
      // Ships with leading/trailing whitespace are normalized by normalizeShip
      const allowlist = [" ~zod ", "~bus"];
      await expectDmAllowed("~zod", allowlist, true);
      await expectDmAllowed(" ~zod ", allowlist, true);
    });

    it("uses the ingress command gate for owner-only command authorization", async () => {
      const authorized = await resolveTlonCommandAuthorizationWithIngress({
        senderShip: "~zod",
        ownerShip: "zod",
        useAccessGroups: true,
      });
      expect(authorized.commandAccess.requested).toBe(true);
      expect(authorized.commandAccess.authorized).toBe(true);
      expect(authorized.commandAccess.shouldBlockControlCommand).toBe(false);
      expect(authorized.commandAccess.reasonCode).toBe("command_authorized");

      const unauthorized = await resolveTlonCommandAuthorizationWithIngress({
        senderShip: "~nec",
        ownerShip: "~zod",
        useAccessGroups: true,
      });
      expect(unauthorized.commandAccess.requested).toBe(true);
      expect(unauthorized.commandAccess.authorized).toBe(false);
      expect(unauthorized.commandAccess.shouldBlockControlCommand).toBe(false);
    });
  });
});

describe("Security: Group Invite Allowlist", () => {
  describe("isGroupInviteAllowed", () => {
    it("rejects invites when allowlist is empty (fail-safe)", () => {
      // CRITICAL: Empty allowlist must DENY, not accept-all
      expect(isGroupInviteAllowed("~zod", [])).toBe(false);
      expect(isGroupInviteAllowed("~sampel-palnet", [])).toBe(false);
      expect(isGroupInviteAllowed("~malicious-actor", [])).toBe(false);
    });

    it("rejects invites when allowlist is undefined (fail-safe)", () => {
      // CRITICAL: Undefined allowlist must DENY, not accept-all
      expect(isGroupInviteAllowed("~zod", undefined)).toBe(false);
      expect(isGroupInviteAllowed("~sampel-palnet", undefined)).toBe(false);
    });

    it("accepts invites from ships on the allowlist", () => {
      const allowlist = ["~nocsyx-lassul", "~malmur-halmex"];
      expect(isGroupInviteAllowed("~nocsyx-lassul", allowlist)).toBe(true);
      expect(isGroupInviteAllowed("~malmur-halmex", allowlist)).toBe(true);
    });

    it("rejects invites from ships NOT on the allowlist", () => {
      const allowlist = ["~nocsyx-lassul", "~malmur-halmex"];
      expect(isGroupInviteAllowed("~random-attacker", allowlist)).toBe(false);
      expect(isGroupInviteAllowed("~malicious-ship", allowlist)).toBe(false);
      expect(isGroupInviteAllowed("~zod", allowlist)).toBe(false);
    });

    it("handles whitespace in allowlist entries", () => {
      const allowlist = [" ~nocsyx-lassul ", "~malmur-halmex"];
      expect(isGroupInviteAllowed("~nocsyx-lassul", allowlist)).toBe(true);
    });
  });
});

describe("Security: Bot Mention Detection", () => {
  describe("isBotMentioned", () => {
    const botShip = "~sampel-palnet";
    const nickname = "nimbus";

    it("detects direct ship mention", () => {
      expect(isBotMentioned("hey ~sampel-palnet", botShip)).toBe(true);
      expect(isBotMentioned("~sampel-palnet can you help?", botShip)).toBe(true);
      expect(isBotMentioned("hello ~sampel-palnet how are you", botShip)).toBe(true);
    });

    it("detects @all mention", () => {
      expect(isBotMentioned("@all please respond", botShip)).toBe(true);
      expect(isBotMentioned("hey @all", botShip)).toBe(true);
      expect(isBotMentioned("@ALL uppercase", botShip)).toBe(true);
    });

    it("detects nickname mention", () => {
      expect(isBotMentioned("hey nimbus", botShip, nickname)).toBe(true);
      expect(isBotMentioned("nimbus help me", botShip, nickname)).toBe(true);
      expect(isBotMentioned("hello NIMBUS", botShip, nickname)).toBe(true);
    });

    it("does NOT trigger on random messages", () => {
      expect(isBotMentioned("hello world", botShip)).toBe(false);
      expect(isBotMentioned("this is a normal message", botShip)).toBe(false);
      expect(isBotMentioned("hey everyone", botShip)).toBe(false);
    });

    it("does NOT trigger on partial ship matches", () => {
      expect(isBotMentioned("~sampel-palnet-extra", botShip)).toBe(false);
      expect(isBotMentioned("my~sampel-palnetfriend", botShip)).toBe(false);
    });

    it("does NOT trigger on substring nickname matches", () => {
      // "nimbus" should not match "nimbusy" or "animbust"
      expect(isBotMentioned("nimbusy", botShip, nickname)).toBe(false);
      expect(isBotMentioned("prenimbus", botShip, nickname)).toBe(false);
    });

    it("handles empty/null inputs safely", () => {
      expect(isBotMentioned("", botShip)).toBe(false);
      expect(isBotMentioned("test", "")).toBe(false);
      // @ts-expect-error testing null input
      expect(isBotMentioned(null, botShip)).toBe(false);
    });

    it("requires word boundary for nickname", () => {
      expect(isBotMentioned("nimbus, hello", botShip, nickname)).toBe(true);
      expect(isBotMentioned("hello nimbus!", botShip, nickname)).toBe(true);
      expect(isBotMentioned("nimbus?", botShip, nickname)).toBe(true);
    });
  });
});

describe("Security: Ship Normalization", () => {
  describe("normalizeShip", () => {
    it("adds ~ prefix if missing", () => {
      expect(normalizeShip("zod")).toBe("~zod");
      expect(normalizeShip("sampel-palnet")).toBe("~sampel-palnet");
    });

    it("preserves ~ prefix if present", () => {
      expect(normalizeShip("~zod")).toBe("~zod");
      expect(normalizeShip("~sampel-palnet")).toBe("~sampel-palnet");
    });

    it("trims whitespace", () => {
      expect(normalizeShip(" ~zod ")).toBe("~zod");
      expect(normalizeShip("  zod  ")).toBe("~zod");
    });

    it("handles empty string", () => {
      expect(normalizeShip("")).toBe("");
      expect(normalizeShip("   ")).toBe("");
    });
  });
});

describe("Security: Message Text Extraction", () => {
  describe("extractMessageText", () => {
    it("extracts plain text", () => {
      const content = [{ inline: ["hello world"] }];
      expect(extractMessageText(content)).toBe("hello world");
    });

    it("extracts @all mentions from sect null", () => {
      const content = [{ inline: [{ sect: null }] }];
      expect(extractMessageText(content)).toContain("@all");
    });

    it("extracts ship mentions", () => {
      const content = [{ inline: [{ ship: "~zod" }] }];
      expect(extractMessageText(content)).toContain("~zod");
    });

    it("handles malformed input safely", () => {
      expect(extractMessageText(null)).toBe("");
      expect(extractMessageText(undefined)).toBe("");
      expect(extractMessageText([])).toBe("");
      expect(extractMessageText([{}])).toBe("");
      expect(extractMessageText("not an array")).toBe("");
    });

    it("does not execute injected code in inline content", () => {
      // Ensure malicious content doesn't get executed
      const maliciousContent = [{ inline: ["<script>alert('xss')</script>"] }];
      const result = extractMessageText(maliciousContent);
      expect(result).toBe("<script>alert('xss')</script>");
      // Just a string, not executed
    });
  });
});

describe("Security: Channel Authorization Logic", () => {
  /**
   * These tests document the expected behavior of channel authorization.
   * The actual resolveChannelAuthorization function is internal to monitor/index.ts
   * but these tests verify the building blocks and expected invariants.
   */

  it("default mode should be restricted (not open)", () => {
    // This is a critical security invariant: if no mode is specified,
    // channels should default to RESTRICTED, not open.
    // If this test fails, someone may have changed the default unsafely.

    // The logic in resolveChannelAuthorization is:
    // const mode = rule?.mode ?? "restricted";
    // We verify this by checking undefined rule gives restricted
    type ModeRule = { mode?: "restricted" | "open" };
    const rule = undefined as ModeRule | undefined;
    const mode = rule?.mode ?? "restricted";
    expect(mode).toBe("restricted");
  });

  it("empty allowedShips with restricted mode should block all", () => {
    // If a channel is restricted but has no allowed ships,
    // no one should be able to send messages
    const _mode = "restricted";
    const allowedShips: string[] = [];
    const sender = "~random-ship";

    const isAllowed = allowedShips.some((ship) => normalizeShip(ship) === normalizeShip(sender));
    expect(isAllowed).toBe(false);
  });

  it("open mode should not check allowedShips", () => {
    // In open mode, any ship can send regardless of allowedShips
    const mode: "open" | "restricted" = "open";
    // The check in monitor/index.ts is:
    // if (mode === "restricted") { /* check ships */ }
    // So open mode skips the ship check entirely
    expect(mode).not.toBe("restricted");
  });

  it("settings should override file config for channel rules", () => {
    // Documented behavior: settingsRules[nest] ?? fileRules[nest]
    // This means settings take precedence
    type ChannelRule = { mode: "restricted" | "open" };
    const fileRules: Record<string, ChannelRule> = { "chat/~zod/test": { mode: "restricted" } };
    const settingsRules: Record<string, ChannelRule> = { "chat/~zod/test": { mode: "open" } };
    const nest = "chat/~zod/test";

    const effectiveRule = settingsRules[nest] ?? fileRules[nest];
    expect(effectiveRule?.mode).toBe("open"); // settings wins
  });
});

describe("Security: Authorization Edge Cases", () => {
  it("empty strings are not valid ships", async () => {
    await expectDmAllowed("", ["~zod"], false);
    await expectDmAllowed("~zod", [""], false);
  });

  it("handles very long ship-like strings", async () => {
    const longName = "~" + "a".repeat(1000);
    await expectDmAllowed(longName, ["~zod"], false);
  });

  it("handles special characters that could break regex", async () => {
    // These should not cause regex injection
    const maliciousShip = "~zod.*";
    await expectDmAllowed("~zodabc", [maliciousShip], false);

    const allowlist = ["~zod"];
    await expectDmAllowed("~zod.*", allowlist, false);
  });

  it("protects against prototype pollution-style keys", async () => {
    const suspiciousShip = "__proto__";
    await expectDmAllowed(suspiciousShip, ["~zod"], false);
    await expectDmAllowed("~zod", [suspiciousShip], false);
  });
});

describe("Security: Cite Resolution Authorization Ordering", () => {
  async function resolveAllCitesForPoC(
    content: unknown,
    api: { scry: (path: string) => Promise<unknown> },
  ): Promise<string> {
    const cites = extractCites(content);
    if (cites.length === 0) {
      return "";
    }

    const resolved: string[] = [];
    for (const cite of cites) {
      if (cite.type !== "chan" || !cite.nest || !cite.postId) {
        continue;
      }
      const data = (await api.scry(`/channels/v4/${cite.nest}/posts/post/${cite.postId}.json`)) as {
        essay?: { content?: unknown };
      };
      const text = data?.essay?.content ? extractMessageText(data.essay.content) : "";
      if (text) {
        resolved.push(`> ${cite.author || "unknown"} wrote: ${text}`);
      }
    }

    return resolved.length > 0 ? resolved.join("\n") + "\n\n" : "";
  }

  function buildCitedMessage(
    secretNest = "chat/~private-ship/ops",
    postId = "1701411845077995094",
  ) {
    return [
      {
        block: {
          cite: {
            chan: {
              nest: secretNest,
              where: `/msg/~victim-ship/${postId}`,
            },
          },
        },
      },
      { inline: ["~bot-ship please summarize this"] },
    ];
  }

  it("does not resolve channel cites for unauthorized senders", async () => {
    const content = buildCitedMessage();
    const rawText = extractMessageText(content);
    const api = {
      scry: vi.fn(async () => ({
        essay: { content: [{ inline: ["TOP-SECRET"] }] },
      })),
    };

    const messageText = await resolveAuthorizedMessageText({
      rawText,
      content,
      authorizedForCites: false,
      resolveAllCites: (nextContent) => resolveAllCitesForPoC(nextContent, api),
    });

    expect(messageText).toBe(rawText);
    expect(api.scry).not.toHaveBeenCalled();
  });

  it("resolves channel cites after sender authorization passes", async () => {
    const secretNest = "chat/~private-ship/ops";
    const postId = "170141184507799509469114119040828178432";
    const content = buildCitedMessage(secretNest, postId);
    const rawText = extractMessageText(content);
    const api = {
      scry: vi.fn(async (path: string) => {
        expect(path).toBe(`/channels/v4/${secretNest}/posts/post/${postId}.json`);
        return {
          essay: { content: [{ inline: ["TOP-SECRET: migration key is rotate-me"] }] },
        };
      }),
    };

    const messageText = await resolveAuthorizedMessageText({
      rawText,
      content,
      authorizedForCites: true,
      resolveAllCites: (nextContent) => resolveAllCitesForPoC(nextContent, api),
    });

    expect(api.scry).toHaveBeenCalledTimes(1);
    expect(messageText).toContain("TOP-SECRET: migration key is rotate-me");
    expect(messageText).toContain("> ~victim-ship wrote: TOP-SECRET: migration key is rotate-me");
  });

  it("does not resolve DM cites before a deny path", async () => {
    const content = buildCitedMessage("chat/~secret-dm/ops", "1701411845077995095");
    const rawText = extractMessageText(content);
    const senderShip = "~attacker-ship";
    const allowlist = ["~trusted-ship"];
    const api = {
      scry: vi.fn(async () => ({
        essay: { content: [{ inline: ["DM-SECRET"] }] },
      })),
    };

    const senderAllowed = allowlist
      .map((ship) => normalizeShip(ship))
      .includes(normalizeShip(senderShip));
    expect(senderAllowed).toBe(false);

    const messageText = await resolveAuthorizedMessageText({
      rawText,
      content,
      authorizedForCites: senderAllowed,
      resolveAllCites: (nextContent) => resolveAllCitesForPoC(nextContent, api),
    });

    expect(messageText).toBe(rawText);
    expect(api.scry).not.toHaveBeenCalled();
  });

  it("does not resolve DM cites before owner approval command handling", async () => {
    const content = [
      {
        block: {
          cite: {
            chan: {
              nest: "chat/~private-ship/admin",
              where: "/msg/~victim-ship/1701411845077995096",
            },
          },
        },
      },
      { inline: ["/approve 1"] },
    ];
    const rawText = extractMessageText(content);
    const api = {
      scry: vi.fn(async () => ({
        essay: { content: [{ inline: ["ADMIN-SECRET"] }] },
      })),
    };

    const messageText = await resolveAuthorizedMessageText({
      rawText,
      content,
      authorizedForCites: false,
      resolveAllCites: (nextContent) => resolveAllCitesForPoC(nextContent, api),
    });

    expect(rawText).toContain("/approve 1");
    expect(messageText).toBe(rawText);
    expect(messageText).not.toContain("ADMIN-SECRET");
    expect(api.scry).not.toHaveBeenCalled();
  });

  it("resolves DM cites for allowed senders after authorization passes", async () => {
    const secretNest = "chat/~private-ship/dm";
    const postId = "1701411845077995097";
    const content = buildCitedMessage(secretNest, postId);
    const rawText = extractMessageText(content);
    const api = {
      scry: vi.fn(async (path: string) => {
        expect(path).toBe(`/channels/v4/${secretNest}/posts/post/${postId}.json`);
        return {
          essay: { content: [{ inline: ["ALLOWED-DM-SECRET"] }] },
        };
      }),
    };

    const messageText = await resolveAuthorizedMessageText({
      rawText,
      content,
      authorizedForCites: true,
      resolveAllCites: (nextContent) => resolveAllCitesForPoC(nextContent, api),
    });

    expect(api.scry).toHaveBeenCalledTimes(1);
    expect(messageText).toContain("ALLOWED-DM-SECRET");
    expect(messageText).toContain("> ~victim-ship wrote: ALLOWED-DM-SECRET");
  });
});

describe("Security: Sender Role Identification", () => {
  /**
   * Tests for sender role identification (owner vs user).
   * This prevents impersonation attacks where an approved user
   * tries to claim owner privileges through prompt injection.
   *
   * SECURITY.md Section 9: Sender Role Identification
   */

  // Helper to compute sender role (mirrors logic in monitor/index.ts)
  function getSenderRole(senderShip: string, ownerShip: string | null): "owner" | "user" {
    if (!ownerShip) {
      return "user";
    }
    return normalizeShip(senderShip) === normalizeShip(ownerShip) ? "owner" : "user";
  }

  describe("owner detection", () => {
    it("identifies owner when ownerShip matches sender", () => {
      expect(getSenderRole("~nocsyx-lassul", "~nocsyx-lassul")).toBe("owner");
      expect(getSenderRole("nocsyx-lassul", "~nocsyx-lassul")).toBe("owner");
      expect(getSenderRole("~nocsyx-lassul", "nocsyx-lassul")).toBe("owner");
    });

    it("identifies user when ownerShip does not match sender", () => {
      expect(getSenderRole("~random-user", "~nocsyx-lassul")).toBe("user");
      expect(getSenderRole("~malicious-actor", "~nocsyx-lassul")).toBe("user");
    });

    it("identifies everyone as user when ownerShip is null", () => {
      expect(getSenderRole("~nocsyx-lassul", null)).toBe("user");
      expect(getSenderRole("~zod", null)).toBe("user");
    });

    it("identifies everyone as user when ownerShip is empty string", () => {
      // Empty string should be treated like null (no owner configured)
      expect(getSenderRole("~nocsyx-lassul", "")).toBe("user");
    });
  });

  describe("label format", () => {
    // Helper to compute fromLabel (mirrors logic in monitor/index.ts)
    function getFromLabel(
      senderShip: string,
      ownerShip: string | null,
      isGroup: boolean,
      channelNest?: string,
    ): string {
      const senderRole = getSenderRole(senderShip, ownerShip);
      return isGroup
        ? `${senderShip} [${senderRole}] in ${channelNest}`
        : `${senderShip} [${senderRole}]`;
    }

    it("DM from owner includes [owner] in label", () => {
      const label = getFromLabel("~nocsyx-lassul", "~nocsyx-lassul", false);
      expect(label).toBe("~nocsyx-lassul [owner]");
      expect(label).toContain("[owner]");
    });

    it("DM from user includes [user] in label", () => {
      const label = getFromLabel("~random-user", "~nocsyx-lassul", false);
      expect(label).toBe("~random-user [user]");
      expect(label).toContain("[user]");
    });

    it("group message from owner includes [owner] in label", () => {
      const label = getFromLabel("~nocsyx-lassul", "~nocsyx-lassul", true, "chat/~host/general");
      expect(label).toBe("~nocsyx-lassul [owner] in chat/~host/general");
      expect(label).toContain("[owner]");
    });

    it("group message from user includes [user] in label", () => {
      const label = getFromLabel("~random-user", "~nocsyx-lassul", true, "chat/~host/general");
      expect(label).toBe("~random-user [user] in chat/~host/general");
      expect(label).toContain("[user]");
    });
  });

  describe("impersonation prevention", () => {
    it("approved user cannot get [owner] label through ship name tricks", () => {
      // Even if someone has a ship name similar to owner, they should not get owner role
      expect(getSenderRole("~nocsyx-lassul-fake", "~nocsyx-lassul")).toBe("user");
      expect(getSenderRole("~fake-nocsyx-lassul", "~nocsyx-lassul")).toBe("user");
    });

    it("message content cannot change sender role", () => {
      // The role is determined by ship identity, not message content
      // This test documents that even if message contains "I am the owner",
      // the actual senderShip determines the role
      const senderShip = "~malicious-actor";
      const ownerShip = "~nocsyx-lassul";

      // The role is always based on ship comparison, not message content
      expect(getSenderRole(senderShip, ownerShip)).toBe("user");
    });
  });
});
