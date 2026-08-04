import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listBuzzAccountIds, resolveBuzzAccount, resolveDefaultBuzzAccountId } from "./types.js";

const ROOM_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const SUPPORT_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const ENGINEERING_KEY = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

describe("listBuzzAccountIds", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("discovers the default account from a configured private-key SecretRef", () => {
    const cfg = {
      channels: {
        buzz: {
          privateKey: { source: "file", provider: "vault", id: "/buzz/private-key" },
        },
      },
    } as OpenClawConfig;

    expect(listBuzzAccountIds(cfg)).toEqual(["default"]);
  });

  it("resolves distinct named identities that share one room", () => {
    const cfg = {
      channels: {
        buzz: {
          relayUrl: "wss://buzz.example.com",
          groupPolicy: "open",
          groups: { [ROOM_ID]: { requireMention: true } },
          defaultAccount: "support",
          accounts: {
            support: { name: "Support", privateKey: SUPPORT_KEY },
            engineering: { name: "Engineering", privateKey: ENGINEERING_KEY },
          },
        },
      },
    } as OpenClawConfig;

    expect(listBuzzAccountIds(cfg)).toEqual(["engineering", "support"]);
    expect(resolveDefaultBuzzAccountId(cfg)).toBe("support");

    const support = resolveBuzzAccount({ cfg, accountId: "support" });
    const engineering = resolveBuzzAccount({ cfg, accountId: "engineering" });
    expect(support).toMatchObject({
      accountId: "support",
      name: "Support",
      configured: true,
      relayUrl: "wss://buzz.example.com",
      config: { groupPolicy: "open", groups: { [ROOM_ID]: { requireMention: true } } },
    });
    expect(engineering).toMatchObject({
      accountId: "engineering",
      name: "Engineering",
      configured: true,
      relayUrl: "wss://buzz.example.com",
      config: { groupPolicy: "open", groups: { [ROOM_ID]: { requireMention: true } } },
    });
    expect(support.publicKey).not.toBe(engineering.publicKey);
  });

  it("does not apply default-account environment credentials to named accounts", () => {
    vi.stubEnv("BUZZ_RELAY_URL", "wss://env.buzz.example.com");
    vi.stubEnv("BUZZ_PRIVATE_KEY", SUPPORT_KEY);
    const cfg = {
      channels: { buzz: { accounts: { engineering: {} } } },
    } as OpenClawConfig;

    expect(resolveBuzzAccount({ cfg, accountId: "engineering" })).toMatchObject({
      configured: false,
      relayUrl: "",
      privateKey: "",
    });
  });
});
