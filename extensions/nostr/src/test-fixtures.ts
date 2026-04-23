import type { ResolvedNostrAccount } from "./types.js";

export const TEST_HEX_PRIVATE_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export const TEST_HEX_PUBLIC_KEY =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

export const TEST_NSEC = "nsec1qypqxpq9qtpqscx7peytzfwtdjmcv0mrz5rjpej8vjppfkqfqy8skqfv3l";

export const TEST_RELAY_URL = "wss://relay.example.com";
export const TEST_SETUP_RELAY_URLS = ["wss://relay.damus.io", "wss://relay.primal.net"];
export const TEST_RESOLVED_PRIVATE_KEY = "resolved-nostr-private-key";

export const TEST_HEX_PRIVATE_KEY_BYTES = new Uint8Array(
  TEST_HEX_PRIVATE_KEY.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)),
);

export function createConfiguredNostrCfg(overrides: Record<string, unknown> = {}): {
  channels: { nostr: Record<string, unknown> };
} {
  return {
    channels: {
      nostr: {
        privateKey: TEST_HEX_PRIVATE_KEY,
        ...overrides,
      },
    },
  };
}

export function buildResolvedNostrAccount(
  overrides: Partial<ResolvedNostrAccount> = {},
): ResolvedNostrAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    privateKey: TEST_HEX_PRIVATE_KEY,
    publicKey: TEST_HEX_PUBLIC_KEY,
    relays: [TEST_RELAY_URL],
    config: {},
    ...overrides,
  };
}
