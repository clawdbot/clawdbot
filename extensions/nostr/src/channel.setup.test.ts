// Nostr tests cover the lightweight setup plugin behavior.
import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { nostrSetupPlugin } from "./channel.setup.js";
import { TEST_HEX_PRIVATE_KEY } from "./test-fixtures.js";

describe("nostr setup plugin", () => {
  it("accepts uppercase bech32 private keys", () => {
    const nsec = nip19.nsecEncode(Buffer.from(TEST_HEX_PRIVATE_KEY, "hex")).toUpperCase();

    expect(
      nostrSetupPlugin.setup?.validateInput?.({
        cfg: {},
        accountId: "default",
        input: { privateKey: nsec },
      } as never),
    ).toBeNull();
  });
});
