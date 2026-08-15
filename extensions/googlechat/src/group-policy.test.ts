// Googlechat tests cover group policy plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveGoogleChatGroupRequireMention } from "./group-policy.js";

describe("googlechat group policy", () => {
  it("resolves exact, wildcard, and unconfigured mention policies", () => {
    const cfg = {
      channels: {
        googlechat: {
          groups: {
            "spaces/exact": { requireMention: false },
            "*": { requireMention: true },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveGoogleChatGroupRequireMention({ cfg, groupId: "spaces/exact" })).toBe(false);
    expect(resolveGoogleChatGroupRequireMention({ cfg, groupId: "spaces/other" })).toBe(true);
    expect(resolveGoogleChatGroupRequireMention({ cfg: {}, groupId: "spaces/other" })).toBe(true);
  });

  it("uses account groups instead of root groups", () => {
    const cfg = {
      channels: {
        googlechat: {
          groups: { "spaces/exact": { requireMention: false } },
          accounts: {
            work: { groups: { "spaces/exact": { requireMention: true } } },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGoogleChatGroupRequireMention({ cfg, accountId: "work", groupId: "spaces/exact" }),
    ).toBe(true);
  });

  it("falls back to root groups for one account with an empty groups map", () => {
    const cfg = {
      channels: {
        googlechat: {
          groups: { "spaces/exact": { requireMention: false } },
          accounts: { work: { groups: {} } },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveGoogleChatGroupRequireMention({ cfg, accountId: "work", groupId: "spaces/exact" }),
    ).toBe(false);
  });
});
