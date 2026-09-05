// Nostr tests cover the lightweight setup plugin behavior.
import { nip19 } from "nostr-tools";
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { nostrSetupPlugin } from "./channel.setup.js";
import { nostrSetupContract } from "./setup-surface.js";
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

  it.each([
    ["truncated", "nsec1not-a-real-secret"],
    [
      "bad checksum",
      (() => {
        const nsec = nip19.nsecEncode(Buffer.from(TEST_HEX_PRIVATE_KEY, "hex"));
        return `${nsec.slice(0, -1)}${nsec.endsWith("q") ? "p" : "q"}`;
      })(),
    ],
    ["short payload", nip19.nsecEncode(new Uint8Array(31))],
    ["long payload", nip19.nsecEncode(new Uint8Array(33))],
    ["invalid-scalar", nip19.nsecEncode(new Uint8Array(32))],
    ["zero scalar hex", "0".repeat(64)],
    ["curve-order scalar hex", "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"],
  ])("rejects %s private keys consistently across setup surfaces", (_label, privateKey) => {
    const input = { cfg: {}, accountId: "default", input: { privateKey } } as never;
    const validationError = "Nostr private key must be valid nsec or 64-character hex.";

    expect(nostrSetupContract.validateInput?.(input)).toBe(validationError);
    expect(nostrSetupPlugin.setupContract?.validateInput?.(input)).toBe(validationError);
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
