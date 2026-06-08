// Qqbot tests cover doctor migration behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract.js";

describe("qqbot doctor contract", () => {
  it("detects legacy root and account group toolPolicy config", () => {
    expect(
      legacyConfigRules[0]?.match?.(
        {
          G1: { toolPolicy: "none" },
        },
        {},
      ),
    ).toBe(true);
    expect(
      legacyConfigRules[1]?.match?.(
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
