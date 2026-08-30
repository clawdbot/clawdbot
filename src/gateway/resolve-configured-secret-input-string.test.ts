/**
 * Tests configured secret input resolution for gateway method parameters.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { withMockedWindowsAclVerificationUnavailable } from "../test-utils/vitest-spies.js";
import {
  resolveConfiguredSecretInputWithFallback,
  resolveRequiredConfiguredSecretRefInputString,
} from "./resolve-configured-secret-input-string.js";

let fixtureRoot = "";

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-secret-input-"));
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

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

async function createWindowsAclUnavailableConfig() {
  const filePath = path.join(fixtureRoot, "gateway-token.txt");
  await fs.writeFile(filePath, "secret-token", { mode: 0o600 });
  return {
    filePath,
    config: {
      gateway: {
        auth: {
          token: { source: "file", provider: "filemain", id: "value" },
        },
      },
      secrets: {
        providers: {
          filemain: { source: "file", path: filePath, mode: "singleValue" },
        },
      },
    } as OpenClawConfig,
  };
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

  it("ignores blank fallback values when no SecretRef is configured", async () => {
    const resolved = await resolveConfiguredSecretInputWithFallback({
      config: createConfig(""),
      env: {} as NodeJS.ProcessEnv,
      value: "",
      path: "gateway.auth.token",
      readFallback: () => "   ",
    });

    expect(resolved).toEqual({
      secretRefConfigured: false,
    });
  });

  it("normalizes fallback values when no SecretRef is configured", async () => {
    const resolved = await resolveConfiguredSecretInputWithFallback({
      config: createConfig(""),
      env: {} as NodeJS.ProcessEnv,
      value: "",
      path: "gateway.auth.token",
      readFallback: () => "  env-token  ",
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

  it.each([
    { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
    { source: "file", provider: "missingfile", id: "value" },
    { source: "exec", provider: "missingexec", id: "gateway/token" },
    { source: "store", provider: "missingstore", id: "MISSING_GATEWAY_TOKEN" },
  ] as const)(
    "never reads fallback credentials after an unresolved $source SecretRef",
    async (ref) => {
      const fallbackCredential = "fallback-secret-must-not-be-read-or-disclosed";
      const readFallback = vi.fn(() => fallbackCredential);
      const resolved = await resolveConfiguredSecretInputWithFallback({
        config: createConfig(ref),
        env: {} as NodeJS.ProcessEnv,
        value: ref,
        path: "gateway.auth.token",
        readFallback,
      });

      expect(readFallback).not.toHaveBeenCalled();
      expect(resolved).toEqual({
        unresolvedRefReason: `gateway.auth.token SecretRef is unresolved (${ref.source}:${ref.provider}:${ref.id}).`,
        secretRefConfigured: true,
      });
      expect(resolved.unresolvedRefReason).not.toContain(fallbackCredential);
    },
  );

  it("keeps generic Windows ACL failures byte-compatible", async () => {
    await withMockedWindowsAclVerificationUnavailable(
      path.join(fixtureRoot, "missing-windows-system-root"),
      async () => {
        const { config } = await createWindowsAclUnavailableConfig();
        const resolved = await resolveConfiguredSecretInputWithFallback({
          config,
          env: {} as NodeJS.ProcessEnv,
          value: config.gateway?.auth?.token,
          path: "gateway.auth.token",
        });

        expect(resolved.unresolvedRefReason).toBe(
          "gateway.auth.token SecretRef is unresolved (file:filemain:value).",
        );
      },
    );
  });

  it("adds only the sanitized Windows ACL diagnostic in detailed mode", async () => {
    await withMockedWindowsAclVerificationUnavailable(
      path.join(fixtureRoot, "missing-windows-system-root"),
      async () => {
        const { config, filePath } = await createWindowsAclUnavailableConfig();
        const resolved = await resolveConfiguredSecretInputWithFallback({
          config,
          env: {} as NodeJS.ProcessEnv,
          value: config.gateway?.auth?.token,
          path: "gateway.auth.token",
          unresolvedReasonStyle: "detailed",
        });

        expect(resolved.unresolvedRefReason).toBe(
          "gateway.auth.token SecretRef is unresolved (file:filemain:value). Windows path security could not be verified. Restore Windows path security verification, or use an existing secret file whose owner and ACLs OpenClaw can verify.",
        );
        expect(resolved.unresolvedRefReason).not.toContain(filePath);
      },
    );
  });

  it("keeps unrelated detailed provider failures unchanged", async () => {
    const resolved = await resolveConfiguredSecretInputWithFallback({
      config: createConfig("${MISSING_GATEWAY_TOKEN}"),
      env: {} as NodeJS.ProcessEnv,
      value: "${MISSING_GATEWAY_TOKEN}",
      path: "gateway.auth.token",
      unresolvedReasonStyle: "detailed",
    });

    expect(resolved.unresolvedRefReason).toBe(
      "gateway.auth.token SecretRef is unresolved (env:default:MISSING_GATEWAY_TOKEN).",
    );
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
