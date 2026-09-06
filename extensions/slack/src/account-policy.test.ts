import {
  createAccountPolicyInheritanceCases,
  validateTestChannelConfig,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import { mergeSlackAccountConfig, resolveSlackAccountDmPolicy } from "./accounts.js";
import { SlackConfigSchema } from "./config-schema.js";

describe("slack account policy inheritance after validation", () => {
  it.each(createAccountPolicyInheritanceCases())("$name", async ({ root, account, expected }) => {
    const channel = SlackConfigSchema.parse({ ...root, accounts: { work: account } });
    const cfg = await validateTestChannelConfig("slack", channel);
    const resolved = {
      ...mergeSlackAccountConfig(cfg, "work"),
      dmPolicy: resolveSlackAccountDmPolicy({ cfg, accountId: "work" }),
    };

    expect(resolved).toMatchObject(expected);
  });

  it("does not turn omitted account policies into explicit configuration", () => {
    const channel = SlackConfigSchema.parse({ accounts: { work: {} } });

    expect(channel.accounts?.work).toBeDefined();
    expect(channel.accounts?.work).not.toHaveProperty("groupPolicy");
    expect(channel.accounts?.work).not.toHaveProperty("dmPolicy");
  });
});

describe("Slack account user-token write policy inheritance", () => {
  it.each([
    { root: false, account: {}, expected: false },
    { root: false, account: { userTokenReadOnly: true }, expected: true },
    { root: undefined, account: {}, expected: true },
  ])(
    "resolves root $root and account $account to $expected",
    async ({ root, account, expected }) => {
      const channel = SlackConfigSchema.parse({
        ...(root === undefined ? {} : { userTokenReadOnly: root }),
        accounts: { work: account },
      });
      const cfg = await validateTestChannelConfig("slack", channel);
      const resolved = mergeSlackAccountConfig(cfg, "work");

      expect(resolved.userTokenReadOnly).toBe(expected);
    },
  );
});
