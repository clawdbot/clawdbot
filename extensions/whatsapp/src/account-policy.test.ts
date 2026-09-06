import {
  createAccountPolicyInheritanceCases,
  validateTestChannelConfig,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import { WhatsAppConfigSchema } from "../config-api.js";
import { resolveMergedWhatsAppAccountConfig } from "./account-config.js";

describe("whatsapp account policy inheritance after validation", () => {
  it.each(createAccountPolicyInheritanceCases())("$name", async ({ root, account, expected }) => {
    const channel = WhatsAppConfigSchema.parse({ ...root, accounts: { work: account } });
    const cfg = await validateTestChannelConfig("whatsapp", channel);
    const resolved = resolveMergedWhatsAppAccountConfig({
      cfg,
      accountId: "work",
    });

    expect(resolved).toMatchObject(expected);
  });

  it("does not turn omitted account policies into explicit configuration", () => {
    const channel = WhatsAppConfigSchema.parse({ accounts: { work: {} } });

    expect(channel.accounts?.work).toBeDefined();
    expect(channel.accounts?.work).not.toHaveProperty("groupPolicy");
    expect(channel.accounts?.work).not.toHaveProperty("dmPolicy");
  });
});
