import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listBuzzAccountIds, resolveBuzzAccount, resolveDefaultBuzzAccountId } from "./types.js";

describe("listBuzzAccountIds", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

  it("lists and selects configured named accounts", () => {
    const cfg = {
      channels: {
        buzz: {
          defaultAccount: "ada",
          accounts: {
            default: { relayUrl: "wss://default.example.com", privateKey: "11".repeat(32) },
            ada: {
              name: "Ada",
              relayUrl: "wss://ada.example.com",
              privateKey: "22".repeat(32),
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(listBuzzAccountIds(cfg)).toEqual(["ada", "default"]);
    expect(resolveDefaultBuzzAccountId(cfg)).toBe("ada");
    expect(resolveBuzzAccount({ cfg })).toMatchObject({
      accountId: "ada",
      name: "Ada",
      relayUrl: "wss://ada.example.com",
      privateKey: "22".repeat(32),
      configured: true,
    });
  });

  it("keeps default-account environment credentials out of named accounts", () => {
    vi.stubEnv("BUZZ_RELAY_URL", "wss://env.example.com");
    vi.stubEnv("BUZZ_PRIVATE_KEY", "11".repeat(32));
    const cfg = {
      channels: {
        buzz: {
          accounts: { ada: { relayUrl: "wss://ada.example.com" } },
        },
      },
    } as OpenClawConfig;

    expect(resolveBuzzAccount({ cfg, accountId: "default" })).toMatchObject({
      relayUrl: "wss://env.example.com",
      privateKey: "11".repeat(32),
      configured: true,
    });
    expect(resolveBuzzAccount({ cfg, accountId: "ada" })).toMatchObject({
      relayUrl: "wss://ada.example.com",
      privateKey: "",
      configured: false,
    });
  });

  it("keeps legacy root credentials on the default account", () => {
    const cfg = {
      channels: {
        buzz: {
          name: "Legacy Buzz",
          relayUrl: "wss://default.example.com",
          privateKey: "11".repeat(32),
          groups: { "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c": {} },
          accounts: {
            ada: { relayUrl: "wss://ada.example.com", privateKey: "22".repeat(32) },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveBuzzAccount({ cfg, accountId: "default" })).toMatchObject({
      accountId: "default",
      name: "Legacy Buzz",
      relayUrl: "wss://default.example.com",
      privateKey: "11".repeat(32),
      configured: true,
      config: {
        groups: { "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c": {} },
      },
    });
  });

  it("lets a scoped default account override legacy root identity fields", () => {
    const cfg = {
      channels: {
        buzz: {
          relayUrl: "wss://legacy.example.com",
          privateKey: "11".repeat(32),
          accounts: {
            default: { relayUrl: "wss://default.example.com", privateKey: "22".repeat(32) },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveBuzzAccount({ cfg, accountId: "default" })).toMatchObject({
      relayUrl: "wss://default.example.com",
      privateKey: "22".repeat(32),
      configured: true,
    });
  });

  it("keeps root-owned identity and room routing out of named accounts", () => {
    const cfg = {
      channels: {
        buzz: {
          relayUrl: "wss://default.example.com",
          privateKey: "11".repeat(32),
          authTag: "default-auth-tag",
          groups: { "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c": {} },
          defaultTo: "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c",
          groupPolicy: "open",
          configWrites: false,
          accounts: {
            ada: { name: "Ada", relayUrl: "wss://ada.example.com" },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveBuzzAccount({ cfg, accountId: "ada" })).toMatchObject({
      accountId: "ada",
      relayUrl: "wss://ada.example.com",
      privateKey: "",
      authTag: "",
      configured: false,
      config: {
        name: "Ada",
        groupPolicy: "open",
        configWrites: false,
        groups: undefined,
      },
    });
    expect(resolveBuzzAccount({ cfg, accountId: "ada" }).config).not.toHaveProperty("defaultTo");
  });
});
