// Nostr tests cover the lightweight setup plugin behavior.
import { nip19 } from "nostr-tools";
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { nostrSetupPlugin } from "./channel.setup.js";
import { TEST_HEX_PRIVATE_KEY } from "./test-fixtures.js";

describe("nostr setup plugin", () => {
  it("accepts uppercase bech32 private keys", () => {
    const nsec = nip19.nsecEncode(Buffer.from(TEST_HEX_PRIVATE_KEY, "hex")).toUpperCase();

    expect(
      nostrSetupPlugin.setupContract?.validateInput?.({
        cfg: {},
        accountId: "default",
        input: { privateKey: nsec },
      } as never),
    ).toBeNull();
  });

  it("keeps an unresolved named SecretRef account configured without ambient fallback", () => {
    const cfg = {
      channels: {
        nostr: {
          defaultAccount: "Team.A",
          privateKey: { source: "env" as const, provider: "default", id: "MISSING_NOSTR_KEY" },
        },
      },
    };

    withEnv({ NOSTR_PRIVATE_KEY: TEST_HEX_PRIVATE_KEY }, () => {
      expect(nostrSetupPlugin.config.defaultAccountId?.(cfg)).toBe("team-a");
      expect(nostrSetupPlugin.config.listAccountIds(cfg)).toEqual(["team-a"]);
      expect(nostrSetupPlugin.config.resolveAccount(cfg, undefined)).toMatchObject({
        accountId: "team-a",
        configured: true,
        privateKey: "",
      });
      expect(nostrSetupPlugin.config.resolveAccount(cfg, "Team.A").accountId).toBe("team-a");
    });
  });
});
