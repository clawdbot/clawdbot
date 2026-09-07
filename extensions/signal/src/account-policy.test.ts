import {
  createAccountPolicyInheritanceCases,
  validateTestChannelConfig,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import { resolveSignalAccountConfig } from "./accounts.js";
import { SignalConfigSchema } from "./config-schema.js";

describe("signal account policy inheritance after validation", () => {
  it.each(createAccountPolicyInheritanceCases())("$name", async ({ root, account, expected }) => {
    const channel = SignalConfigSchema.parse({ ...root, accounts: { work: account } });
    const cfg = await validateTestChannelConfig("signal", channel);
    const resolved = resolveSignalAccountConfig(cfg, "work");

    expect(resolved).toMatchObject(expected);
  });

  it("does not turn omitted account policies into explicit configuration", () => {
    const channel = SignalConfigSchema.parse({ accounts: { work: {} } });

    expect(channel.accounts?.work).toBeDefined();
    expect(channel.accounts?.work).not.toHaveProperty("groupPolicy");
    expect(channel.accounts?.work).not.toHaveProperty("dmPolicy");
  });
});
