// Imessage tests cover group policy plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
} from "./group-policy.js";

describe("imessage group policy", () => {
  it("resolves exact, wildcard, and unconfigured policies", () => {
    const cfg = {
      channels: {
        imessage: {
          groups: {
            exact: { requireMention: false, tools: { deny: ["exec"] } },
            "*": { requireMention: true, tools: { allow: ["message.send"] } },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveIMessageGroupRequireMention({ cfg, groupId: "exact" })).toBe(false);
    expect(resolveIMessageGroupRequireMention({ cfg, groupId: "other" })).toBe(true);
    expect(resolveIMessageGroupToolPolicy({ cfg, groupId: "exact" })).toEqual({
      deny: ["exec"],
    });
    expect(resolveIMessageGroupToolPolicy({ cfg, groupId: "other" })).toEqual({
      allow: ["message.send"],
    });
    expect(resolveIMessageGroupRequireMention({ cfg: {}, groupId: "other" })).toBe(true);
    expect(resolveIMessageGroupToolPolicy({ cfg: {}, groupId: "other" })).toBeUndefined();
  });

  it("uses account groups and preserves the single-account empty fallback", () => {
    const overrideCfg = {
      channels: {
        imessage: {
          groups: { exact: { requireMention: false } },
          accounts: { work: { groups: { exact: { requireMention: true } } } },
        },
      },
    } as OpenClawConfig;
    const fallbackCfg = {
      channels: {
        imessage: {
          groups: { exact: { requireMention: false } },
          accounts: { work: { groups: {} } },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveIMessageGroupRequireMention({
        cfg: overrideCfg,
        accountId: "work",
        groupId: "exact",
      }),
    ).toBe(true);
    expect(
      resolveIMessageGroupRequireMention({
        cfg: fallbackCfg,
        accountId: "work",
        groupId: "exact",
      }),
    ).toBe(false);
  });

  it("prefers sender-scoped tools", () => {
    const cfg = {
      channels: {
        imessage: {
          groups: {
            exact: {
              tools: { deny: ["exec"] },
              toolsBySender: { "channel:imessage:alice": { allow: ["message.send"] } },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveIMessageGroupToolPolicy({ cfg, groupId: "exact", senderId: "alice" })).toEqual({
      allow: ["message.send"],
    });
  });
});
