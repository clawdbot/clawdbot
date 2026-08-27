import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buzzSetupContract } from "./setup-core.js";

describe("buzzSetupContract", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    {
      name: "plaintext private key",
      privateKey: "11".repeat(32),
    },
    {
      name: "private-key SecretRef",
      privateKey: { source: "env" as const, provider: "default", id: "BUZZ_EXISTING_KEY" },
    },
  ])("rejects named account setup without changing the existing $name", ({ privateKey }) => {
    const buzz = {
      enabled: false,
      relayUrl: "wss://original.example.com",
      privateKey,
      authTag: '["auth","owner","kind=9","signature"]',
    };
    const cfg = { channels: { buzz } } as OpenClawConfig;
    const input = {
      relayUrl: "wss://new.example.com",
      privateKey: "22".repeat(32),
    };
    const requestedAccountId = "ada";
    const resolvedAccountId =
      buzzSetupContract.resolveAccountId?.({ cfg, accountId: requestedAccountId, input }) ??
      requestedAccountId;

    expect(resolvedAccountId).toBe(requestedAccountId);
    expect(buzzSetupContract.validateInput?.({ cfg, accountId: resolvedAccountId, input })).toBe(
      "Buzz currently supports only the default account.",
    );
    expect(cfg.channels?.buzz).toEqual(buzz);
  });

  it("rejects named environment-backed setup without changing the existing bot identity", () => {
    const existingPrivateKey = "11".repeat(32);
    vi.stubEnv("BUZZ_PRIVATE_KEY", existingPrivateKey);
    const buzz = {
      enabled: false,
      relayUrl: "wss://original.example.com",
      authTag: '["auth","owner","kind=9","signature"]',
    };
    const cfg = { channels: { buzz } } as OpenClawConfig;
    const input = { relayUrl: "wss://new.example.com", useEnv: true };
    const requestedAccountId = "ada";
    const resolvedAccountId =
      buzzSetupContract.resolveAccountId?.({ cfg, accountId: requestedAccountId, input }) ??
      requestedAccountId;

    expect(resolvedAccountId).toBe(requestedAccountId);
    expect(buzzSetupContract.validateInput?.({ cfg, accountId: resolvedAccountId, input })).toBe(
      "Buzz currently supports only the default account.",
    );
    expect(cfg.channels?.buzz).toEqual(buzz);
    expect(process.env.BUZZ_PRIVATE_KEY).toBe(existingPrivateKey);
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
});
