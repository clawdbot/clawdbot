import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";

async function resolveQqbotSecretAssignments(
  sourceConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<OpenClawConfig> {
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

  expect(context.warnings).toStrictEqual([]);
  return resolvedConfig;
}

describe("qqbot secret contract", () => {
  it("resolves top-level clientSecret SecretRefs even when clientSecretFile is configured", async () => {
    const resolvedConfig = await resolveQqbotSecretAssignments(
      {
        channels: {
          qqbot: {
            enabled: true,
            appId: "123456",
            clientSecret: { source: "env", provider: "default", id: "QQBOT_CLIENT_SECRET" },
            clientSecretFile: "/ignored/by/runtime",
          },
        },
      } as OpenClawConfig,
      { QQBOT_CLIENT_SECRET: "resolved-top-level-secret" },
    );

    expect(resolvedConfig.channels?.qqbot?.clientSecret).toBe("resolved-top-level-secret");
  });

  it("resolves account clientSecret SecretRefs even when account clientSecretFile is configured", async () => {
    const resolvedConfig = await resolveQqbotSecretAssignments(
      {
        channels: {
          qqbot: {
            enabled: true,
            accounts: {
              bot2: {
                enabled: true,
                appId: "654321",
                clientSecret: { source: "env", provider: "default", id: "QQBOT_BOT2_SECRET" },
                clientSecretFile: "/ignored/by/runtime",
              },
            },
          },
        },
      } as OpenClawConfig,
      { QQBOT_BOT2_SECRET: "resolved-bot2-secret" },
    );

    expect(resolvedConfig.channels?.qqbot?.accounts?.bot2?.clientSecret).toBe(
      "resolved-bot2-secret",
    );
  });

  it("keeps the implicit default account top-level clientSecret active with named accounts", async () => {
    const resolvedConfig = await resolveQqbotSecretAssignments(
      {
        channels: {
          qqbot: {
            enabled: true,
            appId: "123456",
            clientSecret: { source: "env", provider: "default", id: "QQBOT_DEFAULT_SECRET" },
            accounts: {
              bot2: {
                enabled: true,
                appId: "654321",
                clientSecret: { source: "env", provider: "default", id: "QQBOT_BOT2_SECRET" },
              },
            },
          },
        },
      } as OpenClawConfig,
      {
        QQBOT_DEFAULT_SECRET: "resolved-default-secret",
        QQBOT_BOT2_SECRET: "resolved-bot2-secret",
      },
    );

    expect(resolvedConfig.channels?.qqbot?.clientSecret).toBe("resolved-default-secret");
    expect(resolvedConfig.channels?.qqbot?.accounts?.bot2?.clientSecret).toBe(
      "resolved-bot2-secret",
    );
  });
});
