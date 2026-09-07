import {
  createAccountPolicyInheritanceCases,
  validateTestChannelConfig,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import { resolveIMessageAccount } from "./accounts.js";
import { IMessageConfigSchema } from "./config-schema.js";

describe("imessage account policy inheritance after validation", () => {
  it.each(createAccountPolicyInheritanceCases())("$name", async ({ root, account, expected }) => {
    const channel = IMessageConfigSchema.parse({ ...root, accounts: { work: account } });
    const cfg = await validateTestChannelConfig("imessage", channel);
    const resolved = resolveIMessageAccount({
      cfg,
      accountId: "work",
    }).config;

    expect(resolved).toMatchObject(expected);
  });

  it("does not turn omitted account policies into explicit configuration", () => {
    const channel = IMessageConfigSchema.parse({ accounts: { work: {} } });

    expect(channel.accounts?.work).toBeDefined();
    expect(channel.accounts?.work).not.toHaveProperty("groupPolicy");
    expect(channel.accounts?.work).not.toHaveProperty("dmPolicy");
  });
});
