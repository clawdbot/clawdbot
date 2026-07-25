// Whatsapp tests cover group policy plugin behavior.
import { describe, expect, it } from "vitest";
import {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./group-policy.js";
import type { OpenClawConfig } from "./runtime-api.js";

describe("whatsapp group policy", () => {
  it("resolves exact, wildcard, and unconfigured policies", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groups: {
            "1203630@g.us": {
              requireMention: false,
              tools: { deny: ["exec"] },
            },
            "*": {
              requireMention: true,
              tools: { allow: ["message.send"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveWhatsAppGroupRequireMention({ cfg, groupId: "1203630@g.us" })).toBe(false);
    expect(resolveWhatsAppGroupRequireMention({ cfg, groupId: "other@g.us" })).toBe(true);
    expect(resolveWhatsAppGroupToolPolicy({ cfg, groupId: "1203630@g.us" })).toEqual({
      deny: ["exec"],
    });
    expect(resolveWhatsAppGroupToolPolicy({ cfg, groupId: "other@g.us" })).toEqual({
      allow: ["message.send"],
    });
    expect(resolveWhatsAppGroupRequireMention({ cfg: {}, groupId: "other@g.us" })).toBe(true);
    expect(resolveWhatsAppGroupToolPolicy({ cfg: {}, groupId: "other@g.us" })).toBeUndefined();
  });

  it("uses account groups and preserves the single-account empty fallback", () => {
    const overrideCfg = {
      channels: {
        whatsapp: {
          groups: { "1203630@g.us": { requireMention: false } },
          accounts: {
            work: { groups: { "1203630@g.us": { requireMention: true } } },
          },
        },
      },
    } as OpenClawConfig;
    const fallbackCfg = {
      channels: {
        whatsapp: {
          groups: { "1203630@g.us": { requireMention: false } },
          accounts: { work: { groups: {} } },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveWhatsAppGroupRequireMention({
        cfg: overrideCfg,
        accountId: "work",
        groupId: "1203630@g.us",
      }),
    ).toBe(true);
    expect(
      resolveWhatsAppGroupRequireMention({
        cfg: fallbackCfg,
        accountId: "work",
        groupId: "1203630@g.us",
      }),
    ).toBe(false);
  });

  it("prefers sender-scoped tools", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groups: {
            "1203630@g.us": {
              tools: { deny: ["exec"] },
              toolsBySender: { "channel:whatsapp:alice": { allow: ["message.send"] } },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveWhatsAppGroupToolPolicy({
        cfg,
        groupId: "1203630@g.us",
        senderId: "alice",
      }),
    ).toEqual({ allow: ["message.send"] });
  });
});
