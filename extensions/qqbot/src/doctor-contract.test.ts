// Qqbot tests cover doctor migration behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract.js";

function findRule(pathSuffix: string, messageFragment: string) {
  const rule = legacyConfigRules.find(
    (candidate) =>
      candidate.path.join(".").endsWith(pathSuffix) && candidate.message.includes(messageFragment),
  );
  if (!rule) {
    throw new Error(`missing rule for ${pathSuffix} (${messageFragment})`);
  }
  return rule;
}

describe("qqbot doctor contract", () => {
  it("detects legacy root and account group toolPolicy config", () => {
    expect(
      findRule("qqbot.groups", "toolPolicy").match?.(
        {
          G1: { toolPolicy: "none" },
        },
        {},
      ),
    ).toBe(true);
    expect(
      findRule("qqbot.accounts", "toolPolicy").match?.(
        {
          bot2: {
            groups: {
              G1: { toolPolicy: "none" },
            },
          },
        },
        {},
      ),
    ).toBe(true);
  });

  it("detects legacy scalar streaming and c2cStreamApi config", () => {
    const rootRule = findRule("channels.qqbot", "nativeTransport");
    expect(rootRule.match?.({ streaming: true }, {})).toBe(true);
    expect(rootRule.match?.({ streaming: false }, {})).toBe(true);
    expect(rootRule.match?.({ streaming: { mode: "off", c2cStreamApi: true } }, {})).toBe(true);
    expect(rootRule.match?.({ streaming: { mode: "partial", nativeTransport: true } }, {})).toBe(
      false,
    );
    const accountsRule = findRule("qqbot.accounts", "nativeTransport");
    expect(accountsRule.match?.({ bot2: { streaming: true } }, {})).toBe(true);
    expect(accountsRule.match?.({ bot2: { streaming: { mode: "off" } } }, {})).toBe(false);
  });

  it("migrates streaming true to the full nested enable (mode + nativeTransport)", () => {
    const cfg = { channels: { qqbot: { streaming: true } } } as OpenClawConfig;
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.config.channels?.qqbot?.streaming).toStrictEqual({
      mode: "partial",
      nativeTransport: true,
    });
    expect(result.changes).toContain(
      "Moved channels.qqbot.streaming (boolean) → channels.qqbot.streaming.nativeTransport.",
    );
  });

  it("migrates streaming false to mode off without nativeTransport", () => {
    const cfg = { channels: { qqbot: { streaming: false } } } as OpenClawConfig;
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.config.channels?.qqbot?.streaming).toStrictEqual({ mode: "off" });
  });

  it("renames c2cStreamApi to nativeTransport preserving the rest of the object", () => {
    const cfg = {
      channels: {
        qqbot: {
          streaming: { mode: "off", c2cStreamApi: true },
          accounts: {
            bot2: { streaming: { c2cStreamApi: false } },
          },
        },
      },
    } as never as OpenClawConfig;
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.config.channels?.qqbot?.streaming).toStrictEqual({
      mode: "off",
      nativeTransport: true,
    });
    expect(result.config.channels?.qqbot?.accounts?.bot2?.streaming).toStrictEqual({
      nativeTransport: false,
    });
  });

  it("drops c2cStreamApi when nativeTransport is already set", () => {
    const cfg = {
      channels: {
        qqbot: { streaming: { nativeTransport: false, c2cStreamApi: true } },
      },
    } as never as OpenClawConfig;
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.config.channels?.qqbot?.streaming).toStrictEqual({ nativeTransport: false });
    expect(result.changes).toContain(
      "Removed channels.qqbot.streaming.c2cStreamApi (channels.qqbot.streaming.nativeTransport already set).",
    );
  });

  it("migrates account-level scalar streaming without touching other accounts", () => {
    const cfg = {
      channels: {
        qqbot: {
          accounts: {
            bot2: { streaming: true },
            bot3: { streaming: { mode: "partial" } },
          },
        },
      },
    } as never as OpenClawConfig;
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.config.channels?.qqbot?.accounts?.bot2?.streaming).toStrictEqual({
      mode: "partial",
      nativeTransport: true,
    });
    expect(result.config.channels?.qqbot?.accounts?.bot3?.streaming).toStrictEqual({
      mode: "partial",
    });
  });

  it("is idempotent: a second run reports no changes", () => {
    const cfg = {
      channels: {
        qqbot: { streaming: true, accounts: { bot2: { streaming: false } } },
      },
    } as never as OpenClawConfig;
    const first = normalizeCompatibilityConfig({ cfg });
    expect(first.changes.length).toBeGreaterThan(0);
    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(first.config);
  });

  it("migrates root legacy toolPolicy values to canonical tools", () => {
    const cfg = {
      channels: {
        qqbot: {
          groups: {
            G1: { toolPolicy: "none", requireMention: true },
            G2: { toolPolicy: "full" },
            G3: { toolPolicy: "restricted" },
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.changes).toHaveLength(3);
    expect(result.config.channels?.qqbot?.groups).toStrictEqual({
      G1: { requireMention: true, tools: { deny: ["*"] } },
      G2: { tools: { allow: [] } },
      G3: { tools: { deny: ["exec", "read", "write"] } },
    });
  });

  it("migrates named-account group toolPolicy values", () => {
    const cfg = {
      channels: {
        qqbot: {
          accounts: {
            bot2: {
              groups: {
                G1: { toolPolicy: "none" },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.changes).toContain(
      "Moved channels.qqbot.accounts.bot2.groups.G1.toolPolicy=none to channels.qqbot.accounts.bot2.groups.G1.tools.",
    );
    expect(result.config.channels?.qqbot?.accounts?.bot2?.groups).toStrictEqual({
      G1: { tools: { deny: ["*"] } },
    });
  });

  it("preserves existing canonical tools while deleting legacy toolPolicy", () => {
    const cfg = {
      channels: {
        qqbot: {
          groups: {
            G1: { toolPolicy: "none", tools: { allow: ["read"] } },
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.changes).toContain(
      "Removed channels.qqbot.groups.G1.toolPolicy (channels.qqbot.groups.G1.tools already exists).",
    );
    expect(result.config.channels?.qqbot?.groups).toStrictEqual({
      G1: { tools: { allow: ["read"] } },
    });
  });
});
