import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";

async function resolveSmsSecretAssignments(
  sourceConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<{
  config: OpenClawConfig;
  warnings: ReturnType<typeof createResolverContext>["warnings"];
}> {
  const resolvedConfig: OpenClawConfig = structuredClone(sourceConfig);
  const context = createResolverContext({ sourceConfig, env });

  collectRuntimeConfigAssignments({
    config: resolvedConfig,
    defaults: sourceConfig.secrets?.defaults,
    context,
  });

  const resolved = await resolveSecretRefValues(
    context.assignments.map((assignment) => assignment.ref),
    {
      config: sourceConfig,
      env: context.env,
      cache: context.cache,
    },
  );
  applyResolvedAssignments({ assignments: context.assignments, resolved });

  return { config: resolvedConfig, warnings: context.warnings };
}

describe("sms secret contract", () => {
  it("publishes SMS auth token targets", () => {
    expect(secretTargetRegistryEntries.map((entry) => entry.id)).toEqual([
      "channels.sms.accounts.*.authToken",
      "channels.sms.authToken",
    ]);
  });

  it("resolves top-level authToken SecretRefs for SMS accounts", async () => {
    const resolved = await resolveSmsSecretAssignments(
      {
        channels: {
          sms: {
            enabled: true,
            accountSid: "AC123",
            authToken: { source: "env", provider: "default", id: "TWILIO_AUTH_TOKEN" },
            fromNumber: "+15557654321",
          },
        },
      } as OpenClawConfig,
      { TWILIO_AUTH_TOKEN: "resolved-token" },
    );

    expect(resolved.config.channels?.sms?.authToken).toBe("resolved-token");
    expect(resolved.warnings).toStrictEqual([]);
  });

  it("keeps top-level authToken active for an implicit default sender plus named accounts", async () => {
    const resolved = await resolveSmsSecretAssignments(
      {
        channels: {
          sms: {
            enabled: true,
            accountSid: "AC123",
            authToken: { source: "env", provider: "default", id: "TWILIO_DEFAULT_TOKEN" },
            fromNumber: "+15557654321",
            accounts: {
              support: {
                enabled: true,
                accountSid: "AC456",
                authToken: { source: "env", provider: "default", id: "TWILIO_SUPPORT_TOKEN" },
                fromNumber: "+15558675309",
              },
            },
          },
        },
      } as OpenClawConfig,
      {
        TWILIO_DEFAULT_TOKEN: "resolved-default-token",
        TWILIO_SUPPORT_TOKEN: "resolved-support-token",
      },
    );

    expect(resolved.config.channels?.sms?.authToken).toBe("resolved-default-token");
    expect(resolved.config.channels?.sms?.accounts?.support?.authToken).toBe(
      "resolved-support-token",
    );
    expect(resolved.warnings).toStrictEqual([]);
  });

  it("keeps top-level authToken active for env-backed default senders plus named accounts", async () => {
    const resolved = await resolveSmsSecretAssignments(
      {
        channels: {
          sms: {
            enabled: true,
            authToken: { source: "env", provider: "default", id: "TWILIO_DEFAULT_TOKEN" },
            accounts: {
              support: {
                enabled: true,
                accountSid: "AC456",
                authToken: { source: "env", provider: "default", id: "TWILIO_SUPPORT_TOKEN" },
                fromNumber: "+15558675309",
              },
            },
          },
        },
      } as OpenClawConfig,
      {
        TWILIO_ACCOUNT_SID: "AC-env",
        TWILIO_PHONE_NUMBER: "+15550001111",
        TWILIO_DEFAULT_TOKEN: "resolved-default-token",
        TWILIO_SUPPORT_TOKEN: "resolved-support-token",
      },
    );

    expect(resolved.config.channels?.sms?.authToken).toBe("resolved-default-token");
    expect(resolved.config.channels?.sms?.accounts?.support?.authToken).toBe(
      "resolved-support-token",
    );
    expect(resolved.warnings).toStrictEqual([]);
  });

  it("treats top-level authToken refs as inactive when all enabled accounts override them", async () => {
    const resolved = await resolveSmsSecretAssignments(
      {
        channels: {
          sms: {
            authToken: { source: "env", provider: "default", id: "UNUSED_TWILIO_TOKEN" },
            accounts: {
              support: {
                enabled: true,
                accountSid: "AC456",
                authToken: { source: "env", provider: "default", id: "TWILIO_SUPPORT_TOKEN" },
                fromNumber: "+15558675309",
              },
            },
          },
        },
      } as OpenClawConfig,
      { TWILIO_SUPPORT_TOKEN: "resolved-support-token" },
    );

    expect(resolved.config.channels?.sms?.authToken).toEqual({
      source: "env",
      provider: "default",
      id: "UNUSED_TWILIO_TOKEN",
    });
    expect(resolved.config.channels?.sms?.accounts?.support?.authToken).toBe(
      "resolved-support-token",
    );
    expect(resolved.warnings.map((warning) => warning.path)).toContain("channels.sms.authToken");
  });
});
