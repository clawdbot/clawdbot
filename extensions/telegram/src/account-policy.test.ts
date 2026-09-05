import { validateTestChannelConfig } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import { mergeTelegramAccountConfig } from "./account-config.js";
import { TelegramConfigSchema } from "./config-schema.js";

describe("telegram account policy inheritance after validation", () => {
  it.each([
    {
      name: "inherits explicit open channel policies",
      root: { groupPolicy: "open", dmPolicy: "open", allowFrom: ["*"] },
      account: {},
      expected: { groupPolicy: "open", dmPolicy: "open" },
    },
    {
      name: "keeps unset group access closed and DMs paired",
      root: {},
      account: {},
      expected: { groupPolicy: "allowlist", dmPolicy: "pairing" },
    },
    {
      name: "honors explicit account policies even when they equal the defaults",
      root: { groupPolicy: "open", dmPolicy: "open", allowFrom: ["*"] },
      account: { groupPolicy: "allowlist", dmPolicy: "pairing" },
      expected: { groupPolicy: "allowlist", dmPolicy: "pairing" },
    },
    {
      name: "honors explicit open account policies over disabled channel policies",
      root: { groupPolicy: "disabled", dmPolicy: "disabled" },
      account: { groupPolicy: "open", dmPolicy: "open", allowFrom: ["*"] },
      expected: { groupPolicy: "open", dmPolicy: "open" },
    },
  ] as const)("$name", async ({ root, account, expected }) => {
    const channel = TelegramConfigSchema.parse({ ...root, accounts: { work: account } });
    const cfg = await validateTestChannelConfig("telegram", channel);
    const resolved = mergeTelegramAccountConfig(cfg, "work");

    expect(resolved).toMatchObject(expected);
  });

  it("does not turn omitted account policies into explicit configuration", () => {
    const channel = TelegramConfigSchema.parse({ accounts: { work: {} } });

    expect(channel.accounts?.work).toBeDefined();
    expect(channel.accounts?.work).not.toHaveProperty("groupPolicy");
    expect(channel.accounts?.work).not.toHaveProperty("dmPolicy");
  });
});

describe("Telegram capability collection inheritance", () => {
  it.each([
    { capabilities: [], expected: { inlineButtons: "off" } },
    { capabilities: {}, expected: {} },
    { capabilities: { inlineButtons: "all" }, expected: { inlineButtons: "all" } },
  ] as const)(
    "preserves authored capabilities $capabilities",
    async ({ capabilities, expected }) => {
      const channel = TelegramConfigSchema.parse({
        capabilities: { inlineButtons: "off" },
        accounts: { work: { capabilities } },
      });

      const cfg = await validateTestChannelConfig("telegram", channel);
      expect(mergeTelegramAccountConfig(cfg, "work").capabilities).toEqual(expected);
    },
  );
});
