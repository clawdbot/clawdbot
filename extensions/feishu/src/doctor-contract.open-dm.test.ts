// Feishu tests cover doctor repair for previously accepted named-account DM access.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract.js";

function feishuConfig(entry: Record<string, unknown>): OpenClawConfig {
  return { channels: { feishu: entry } } as never;
}

function readFeishu(result: ReturnType<typeof normalizeCompatibilityConfig>) {
  return result.config.channels?.feishu as unknown as Record<string, unknown>;
}

describe("feishu named-account open DM doctor repair", () => {
  const openDmRule = legacyConfigRules.find((rule) =>
    rule.message.includes("accounts.<id>.dmPolicy"),
  );

  it("detects effective open accounts without a wildcard", () => {
    expect(openDmRule?.match?.({ accounts: { work: { dmPolicy: "open" } } }, {})).toBe(true);
    expect(
      openDmRule?.match?.(
        { allowFrom: ["*"], accounts: { work: { dmPolicy: "open" } } },
        {},
      ),
    ).toBe(false);
    expect(
      openDmRule?.match?.(
        {
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: { work: { allowFrom: ["ou_alice"] } },
        },
        {},
      ),
    ).toBe(true);
  });

  it.each(["feishu:*", "lark:*"])(
    "does not flag provider-prefixed wildcard %s",
    (wildcard) => {
      expect(
        openDmRule?.match?.(
          { accounts: { work: { dmPolicy: "open", allowFrom: [wildcard] } } },
          {},
        ),
      ).toBe(false);
    },
  );

  it("ignores disabled accounts and channel-disabled account policies", () => {
    expect(
      openDmRule?.match?.(
        { accounts: { work: { enabled: false, dmPolicy: "open" } } },
        {},
      ),
    ).toBe(false);
    expect(
      openDmRule?.match?.(
        { enabled: false, accounts: { work: { dmPolicy: "open" } } },
        {},
      ),
    ).toBe(false);
  });

  it("preserves restricted access by converting invalid effective open accounts to allowlist", () => {
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({
        allowFrom: ["ou_root"],
        accounts: {
          work: { dmPolicy: "open", allowFrom: ["ou_work"] },
          inherited: { dmPolicy: "open" },
        },
      }),
    });
    const feishu = readFeishu(result);
    const accounts = feishu.accounts as Record<string, Record<string, unknown>>;

    expect(accounts.work).toEqual({ dmPolicy: "allowlist", allowFrom: ["ou_work"] });
    expect(accounts.inherited).toEqual({ dmPolicy: "allowlist" });
    expect(result.changes).toEqual([
      expect.stringContaining("channels.feishu.accounts.work.dmPolicy"),
      expect.stringContaining("channels.feishu.accounts.inherited.dmPolicy"),
    ]);
    expect(FeishuConfigSchema.safeParse(feishu).success).toBe(true);
  });

  it("materializes allowlist policy when an account narrows an inherited open policy", () => {
    const result = normalizeCompatibilityConfig({
      cfg: feishuConfig({
        dmPolicy: "open",
        allowFrom: ["*"],
        accounts: { work: { allowFrom: ["ou_alice"] } },
      }),
    });
    const feishu = readFeishu(result);
    const work = (feishu.accounts as Record<string, Record<string, unknown>>).work;

    expect(work).toEqual({ dmPolicy: "allowlist", allowFrom: ["ou_alice"] });
    expect(FeishuConfigSchema.safeParse(feishu).success).toBe(true);
  });

  it.each(["feishu:*", "lark:*"])(
    "leaves provider-prefixed wildcard %s unchanged",
    (wildcard) => {
      const cfg = feishuConfig({
        accounts: { work: { dmPolicy: "open", allowFrom: [wildcard] } },
      });
      const result = normalizeCompatibilityConfig({ cfg });

      expect(result.changes).toEqual([]);
      expect(result.config).toBe(cfg);
      expect(FeishuConfigSchema.safeParse(readFeishu(result)).success).toBe(true);
    },
  );

  it("leaves disabled open DM account policies untouched", () => {
    const accountDisabled = feishuConfig({
      accounts: { work: { enabled: false, dmPolicy: "open", allowFrom: ["ou_alice"] } },
    });
    const accountResult = normalizeCompatibilityConfig({ cfg: accountDisabled });
    expect(accountResult.changes).toEqual([]);
    expect(accountResult.config).toBe(accountDisabled);

    const channelDisabled = feishuConfig({
      enabled: false,
      accounts: { work: { dmPolicy: "open", allowFrom: ["ou_alice"] } },
    });
    const channelResult = normalizeCompatibilityConfig({ cfg: channelDisabled });
    expect(channelResult.changes).toEqual([]);
    expect(channelResult.config).toBe(channelDisabled);
  });

  it("leaves effective wildcard access unchanged and is idempotent", () => {
    const first = normalizeCompatibilityConfig({
      cfg: feishuConfig({
        allowFrom: ["*"],
        accounts: { work: { dmPolicy: "open" } },
      }),
    });
    expect(first.changes).toEqual([]);

    const second = normalizeCompatibilityConfig({ cfg: first.config });
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(first.config);
  });
});
