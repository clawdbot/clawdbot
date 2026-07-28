// Googlechat tests cover serviceAccountAdc wiring across the multi-account
// credential surfaces (implicit-default registration, accounts.default
// isolation, and credential cleanup) so keyless (ADC) auth is treated as a
// first-class credential everywhere the older key fields are.
import { DEFAULT_ACCOUNT_ID, type OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { describe, expect, it } from "vitest";
import { listGoogleChatAccountIds, resolveGoogleChatAccount } from "./accounts.js";
import { createGoogleChatPluginBase } from "./channel-base.js";

const cfgOf = (googlechat: Record<string, unknown>): OpenClawConfig =>
  ({ channels: { googlechat } }) as unknown as OpenClawConfig;

describe("googlechat serviceAccountAdc account surfaces", () => {
  it("registers a top-level serviceAccountAdc as an implicit default account", () => {
    const cfg = cfgOf({ serviceAccountAdc: true });

    // Without ADC in the implicit-default channelKeys, a keyless config would
    // not surface the default account at all.
    expect(listGoogleChatAccountIds(cfg)).toContain(DEFAULT_ACCOUNT_ID);

    const resolved = resolveGoogleChatAccount({ cfg });
    expect(resolved.credentialSource).toBe("adc");
    expect(resolved.enabled).toBe(true);
  });

  it("does not leak accounts.default serviceAccountAdc into sibling accounts", () => {
    const cfg = cfgOf({
      accounts: {
        default: { serviceAccountAdc: true },
        teamb: { audience: "https://example.test/teamb", webhookPath: "/teamb" },
      },
    });

    // The default account keeps its own ADC selector...
    expect(resolveGoogleChatAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID }).credentialSource).toBe(
      "adc",
    );
    // ...but a sibling account with no credential of its own must NOT inherit
    // ambient ADC via accounts.default shared defaults.
    expect(resolveGoogleChatAccount({ cfg, accountId: "teamb" }).credentialSource).toBe("none");
  });

  it("clears a root-level serviceAccountAdc when the default account is deleted", () => {
    const cfg = cfgOf({
      serviceAccountAdc: true,
      accounts: { teamb: { audience: "https://example.test/teamb", webhookPath: "/teamb" } },
    });
    const { deleteAccount } = createGoogleChatPluginBase().config;
    if (!deleteAccount) {
      throw new Error("googlechat config adapter is missing deleteAccount");
    }

    expect(resolveGoogleChatAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID }).credentialSource).toBe(
      "adc",
    );

    const cleared = deleteAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });

    // Cleanup must not leave keyless auth silently active.
    expect(
      resolveGoogleChatAccount({ cfg: cleared, accountId: DEFAULT_ACCOUNT_ID }).credentialSource,
    ).toBe("none");
  });
});
