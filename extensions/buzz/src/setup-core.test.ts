import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { moveSingleAccountChannelSectionToDefaultAccount } from "openclaw/plugin-sdk/setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buzzSetupContract } from "./setup-core.js";

describe("buzzSetupContract", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("validates and applies BUZZ_PRIVATE_KEY setup without storing the key", () => {
    expect(buzzSetupContract.metadata.fields.find((field) => field.key === "useEnv")).toMatchObject(
      {
        kind: "boolean",
        envVars: ["BUZZ_PRIVATE_KEY"],
      },
    );
    expect(
      buzzSetupContract.validateInput?.({
        cfg: {},
        accountId: "default",
        input: { relayUrl: "wss://buzz.example.com", useEnv: true },
      }),
    ).toBeNull();
    vi.stubEnv("BUZZ_PRIVATE_KEY", "22".repeat(32));
    const cfg = {
      channels: {
        buzz: {
          enabled: true,
          relayUrl: "wss://old.example.com",
          privateKey: "11".repeat(32),
        },
      },
    } as OpenClawConfig;

    const result = buzzSetupContract.applyAccountConfig({
      cfg,
      accountId: "default",
      input: { relayUrl: "wss://buzz.example.com", useEnv: true },
    });

    expect(result.channels?.buzz).toEqual({
      enabled: true,
      relayUrl: "wss://buzz.example.com",
    });
  });

  it("clears an identity-bound auth tag when changing the private key", () => {
    const cfg = {
      channels: {
        buzz: {
          relayUrl: "wss://buzz.example.com",
          privateKey: "11".repeat(32),
          authTag: '["auth","owner","kind=9","signature"]',
        },
      },
    } as OpenClawConfig;

    const result = buzzSetupContract.applyAccountConfig({
      cfg,
      accountId: "default",
      input: { relayUrl: "wss://buzz.example.com", privateKey: "22".repeat(32) },
    });

    expect(result.channels?.buzz?.privateKey).toBe("22".repeat(32));
    expect(result.channels?.buzz?.authTag).toBeUndefined();
  });

  it("clears an auth tag when replacing an unresolved SecretRef with the environment", () => {
    vi.stubEnv("BUZZ_PRIVATE_KEY", "22".repeat(32));
    const cfg = {
      channels: {
        buzz: {
          relayUrl: "wss://buzz.example.com",
          privateKey: { source: "env", provider: "default", id: "OTHER_BUZZ_KEY" },
          authTag: '["auth","owner","kind=9","signature"]',
        },
      },
    } as OpenClawConfig;

    const result = buzzSetupContract.applyAccountConfig({
      cfg,
      accountId: "default",
      input: { relayUrl: "wss://buzz.example.com", useEnv: true },
    });

    expect(result.channels?.buzz?.privateKey).toBeUndefined();
    expect(result.channels?.buzz?.authTag).toBeUndefined();
  });

  it("preserves an auth tag when the environment keeps the same identity", () => {
    vi.stubEnv("BUZZ_PRIVATE_KEY", "11".repeat(32));
    const cfg = {
      channels: {
        buzz: {
          relayUrl: "wss://buzz.example.com",
          privateKey: "11".repeat(32),
          authTag: '["auth","owner","kind=9","signature"]',
        },
      },
    } as OpenClawConfig;

    const result = buzzSetupContract.applyAccountConfig({
      cfg,
      accountId: "default",
      input: { relayUrl: "wss://buzz.example.com", useEnv: true },
    });

    expect(result.channels?.buzz?.privateKey).toBeUndefined();
    expect(result.channels?.buzz?.authTag).toBe('["auth","owner","kind=9","signature"]');
  });

  it("adds a named account without overwriting the legacy default account", () => {
    const cfg = {
      channels: {
        buzz: {
          enabled: true,
          relayUrl: "wss://default.example.com",
          privateKey: "11".repeat(32),
        },
      },
    } as OpenClawConfig;
    const accountId = buzzSetupContract.resolveAccountId?.({
      cfg,
      accountId: "Ada",
      input: {},
    });
    const promoted = moveSingleAccountChannelSectionToDefaultAccount({
      cfg,
      channelKey: "buzz",
      setupSurface: buzzSetupContract,
    });

    expect(accountId).toBe("ada");
    expect(
      buzzSetupContract.validateInput?.({
        cfg: promoted,
        accountId: accountId!,
        input: {
          name: "Ada",
          relayUrl: "wss://ada.example.com",
          privateKey: "22".repeat(32),
        },
      }),
    ).toBeNull();
    const result = buzzSetupContract.applyAccountConfig({
      cfg: promoted,
      accountId: accountId!,
      input: {
        name: "Ada",
        relayUrl: "wss://ada.example.com",
        privateKey: "22".repeat(32),
      },
    });

    expect(result.channels?.buzz).toMatchObject({
      enabled: true,
      accounts: {
        default: {
          relayUrl: "wss://default.example.com",
          privateKey: "11".repeat(32),
        },
        ada: {
          name: "Ada",
          enabled: true,
          relayUrl: "wss://ada.example.com",
          privateKey: "22".repeat(32),
        },
      },
    });
    expect(result.channels?.buzz?.relayUrl).toBeUndefined();
    expect(result.channels?.buzz?.privateKey).toBeUndefined();
  });

  it("updates an existing account without changing its key casing", () => {
    const result = buzzSetupContract.applyAccountConfig({
      cfg: {
        channels: {
          buzz: {
            accounts: {
              Ada: {
                name: "Ada old",
                relayUrl: "wss://old.example.com",
                privateKey: "11".repeat(32),
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "ada",
      input: {
        name: "Ada new",
        relayUrl: "wss://new.example.com",
        privateKey: "22".repeat(32),
      },
    });

    expect(result.channels?.buzz?.accounts).toEqual({
      Ada: {
        name: "Ada new",
        enabled: true,
        relayUrl: "wss://new.example.com",
        privateKey: "22".repeat(32),
      },
    });
  });

  it("rejects default-account environment credentials for named accounts", () => {
    expect(
      buzzSetupContract.validateInput?.({
        cfg: {},
        accountId: "ada",
        input: { relayUrl: "wss://ada.example.com", useEnv: true },
      }),
    ).toBe("Buzz --use-env is only available for the default account.");
  });

  it("moves lingering root credentials to default while preserving shared policy", () => {
    const cfg = {
      channels: {
        buzz: {
          configWrites: false,
          markdown: { tables: "code" },
          groupPolicy: "allowlist",
          groupAllowFrom: ["shared-sender"],
          relayUrl: "wss://default.example.com",
          privateKey: "11".repeat(32),
          groups: { "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c": {} },
          defaultTo: "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c",
          accounts: {
            ada: { relayUrl: "wss://ada.example.com", privateKey: "22".repeat(32) },
          },
        },
      },
    } as OpenClawConfig;

    const result = moveSingleAccountChannelSectionToDefaultAccount({
      cfg,
      channelKey: "buzz",
      setupSurface: buzzSetupContract,
    });

    expect(result.channels?.buzz?.groupPolicy).toBe("allowlist");
    expect(result.channels?.buzz?.groupAllowFrom).toEqual(["shared-sender"]);
    expect(result.channels?.buzz?.configWrites).toBe(false);
    expect(result.channels?.buzz?.markdown).toEqual({ tables: "code" });
    expect(result.channels?.buzz?.accounts?.ada).toMatchObject({
      relayUrl: "wss://ada.example.com",
      privateKey: "22".repeat(32),
    });
    expect(result.channels?.buzz?.accounts?.ada?.configWrites).toBeUndefined();
    expect(result.channels?.buzz?.accounts?.default?.configWrites).toBeUndefined();
    expect(result.channels?.buzz?.accounts?.default).toMatchObject({
      relayUrl: "wss://default.example.com",
      privateKey: "11".repeat(32),
      groups: { "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c": {} },
      defaultTo: "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c",
    });
    expect(result.channels?.buzz?.relayUrl).toBeUndefined();
    expect(result.channels?.buzz?.privateKey).toBeUndefined();
    expect(result.channels?.buzz?.groups).toBeUndefined();
    expect(result.channels?.buzz?.defaultTo).toBeUndefined();
  });
});
