import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  resolveConfiguredSecretInputWithFallback,
  resolveRequiredConfiguredSecretRefInputString,
} from "./resolve-configured-secret-input-string.js";

function createConfig(value: unknown): OpenClawConfig {
  return {
    gateway: {
      auth: {
        token: value,
      },
    },
    secrets: {
      providers: {
        default: { source: "env" },
      },
    },
  } as OpenClawConfig;
}

describe("resolveConfiguredSecretInputWithFallback", () => {
  it("returns plaintext config value when present", async () => {
    const resolved = await resolveConfiguredSecretInputWithFallback({
      config: createConfig("config-token"),
      env: {} as NodeJS.ProcessEnv,
      value: "config-token",
      path: "gateway.auth.token",
      readFallback: () => "env-token",
    });

    expect(resolved).toEqual({
      value: "config-token",
      source: "config",
      secretRefConfigured: false,
    });
  });

  it("returns fallback value when config is empty and no SecretRef is configured", async () => {
    const resolved = await resolveConfiguredSecretInputWithFallback({
      config: createConfig(""),
      env: {} as NodeJS.ProcessEnv,
      value: "",
      path: "gateway.auth.token",
      readFallback: () => "env-token",
    });

    expect(resolved).toEqual({
      value: "env-token",
      source: "fallback",
      secretRefConfigured: false,
    });
  });

  it("returns resolved SecretRef value with fallback metadata", async () => {
    const resolved = await resolveConfiguredSecretInputWithFallback({
      config: createConfig("${CUSTOM_GATEWAY_TOKEN}"),
      env: { CUSTOM_GATEWAY_TOKEN: "resolved-token" } as NodeJS.ProcessEnv,
      value: "${CUSTOM_GATEWAY_TOKEN}",
      path: "gateway.auth.token",
      readFallback: () => undefined,
    });

    expect(resolved).toEqual({
      value: "resolved-token",
      source: "secretRef",
      secretRefConfigured: true,
    });
  });

  it("falls back when SecretRef cannot be resolved", async () => {
    const resolved = await resolveConfiguredSecretInputWithFallback({
      config: createConfig("${MISSING_GATEWAY_TOKEN}"),
      env: {} as NodeJS.ProcessEnv,
      value: "${MISSING_GATEWAY_TOKEN}",
      path: "gateway.auth.token",
      readFallback: () => "env-fallback-token",
    });

    expect(resolved).toEqual({
      value: "env-fallback-token",
      source: "fallback",
      secretRefConfigured: true,
    });
  });

  it("returns unresolved reason when SecretRef cannot be resolved and no fallback exists", async () => {
    const resolved = await resolveConfiguredSecretInputWithFallback({
      config: createConfig("${MISSING_GATEWAY_TOKEN}"),
      env: {} as NodeJS.ProcessEnv,
      value: "${MISSING_GATEWAY_TOKEN}",
      path: "gateway.auth.token",
    });

    expect(resolved.value).toBeUndefined();
    expect(resolved.source).toBeUndefined();
    expect(resolved.secretRefConfigured).toBe(true);
    expect(resolved.unresolvedRefReason).toContain("gateway.auth.token SecretRef is unresolved");
    expect(resolved.unresolvedRefReason).toContain("MISSING_GATEWAY_TOKEN");
  });
});

describe("resolveRequiredConfiguredSecretRefInputString", () => {
  it("returns undefined when no SecretRef is configured", async () => {
    const value = await resolveRequiredConfiguredSecretRefInputString({
      config: createConfig("plain-token"),
      env: {} as NodeJS.ProcessEnv,
      value: "plain-token",
      path: "gateway.auth.token",
    });

    expect(value).toBeUndefined();
  });

  it("returns resolved SecretRef value when required", async () => {
    const value = await resolveRequiredConfiguredSecretRefInputString({
      config: createConfig("${CUSTOM_GATEWAY_TOKEN}"),
      env: { CUSTOM_GATEWAY_TOKEN: "resolved-token" } as NodeJS.ProcessEnv,
      value: "${CUSTOM_GATEWAY_TOKEN}",
      path: "gateway.auth.token",
    });

    expect(value).toBe("resolved-token");
  });

  it("throws when SecretRef cannot be resolved", async () => {
    await expect(
      resolveRequiredConfiguredSecretRefInputString({
        config: createConfig("${MISSING_GATEWAY_TOKEN}"),
        env: {} as NodeJS.ProcessEnv,
        value: "${MISSING_GATEWAY_TOKEN}",
        path: "gateway.auth.token",
      }),
    ).rejects.toThrow(/MISSING_GATEWAY_TOKEN/i);
  });
});
