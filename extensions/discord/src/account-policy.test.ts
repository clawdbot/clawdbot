import {
  createAccountPolicyInheritanceCases,
  validateTestChannelConfig,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import { mergeDiscordAccountConfig, resolveDiscordAccountDmPolicy } from "./accounts.js";
import { DiscordConfigSchema } from "./config-schema.js";

describe("discord account policy inheritance after validation", () => {
  it.each(createAccountPolicyInheritanceCases())("$name", async ({ root, account, expected }) => {
    const channel = DiscordConfigSchema.parse({ ...root, accounts: { work: account } });
    const cfg = await validateTestChannelConfig("discord", channel);
    const resolved = {
      ...mergeDiscordAccountConfig(cfg, "work"),
      dmPolicy: resolveDiscordAccountDmPolicy({ cfg, accountId: "work" }),
    };

    expect(resolved).toMatchObject(expected);
  });

  it("does not turn omitted account policies into explicit configuration", () => {
    const channel = DiscordConfigSchema.parse({ accounts: { work: {} } });

    expect(channel.accounts?.work).toBeDefined();
    expect(channel.accounts?.work).not.toHaveProperty("groupPolicy");
    expect(channel.accounts?.work).not.toHaveProperty("dmPolicy");
  });
});
