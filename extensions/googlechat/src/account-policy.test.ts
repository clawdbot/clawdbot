import {
  createAccountPolicyInheritanceCases,
  validateTestChannelConfig,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import { GoogleChatConfigSchema } from "../config-api.js";
import { resolveGoogleChatConfigAccessorAccount } from "./accounts.js";

describe("googlechat account policy inheritance after validation", () => {
  it.each(createAccountPolicyInheritanceCases())("$name", async ({ root, account, expected }) => {
    const channel = GoogleChatConfigSchema.parse({ ...root, accounts: { work: account } });
    const cfg = await validateTestChannelConfig("googlechat", channel);
    const resolved = resolveGoogleChatConfigAccessorAccount({
      cfg,
      accountId: "work",
    }).config;

    expect(resolved).toMatchObject(expected);
  });

  it("does not turn omitted account policies into explicit configuration", () => {
    const channel = GoogleChatConfigSchema.parse({ accounts: { work: {} } });

    expect(channel.accounts?.work).toBeDefined();
    expect(channel.accounts?.work).not.toHaveProperty("groupPolicy");
    expect(channel.accounts?.work).not.toHaveProperty("dmPolicy");
  });
});
