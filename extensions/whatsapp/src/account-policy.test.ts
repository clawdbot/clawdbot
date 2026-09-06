import { validateTestChannelConfig } from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it } from "vitest";
import { WhatsAppConfigSchema } from "../config-api.js";
import { resolveMergedWhatsAppAccountConfig } from "./account-config.js";

describe("whatsapp account policy inheritance after validation", () => {
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
