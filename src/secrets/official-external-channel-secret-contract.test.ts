import { describe, expect, it } from "vitest";
import { loadOfficialExternalChannelSecretContractApi } from "./official-external-channel-secret-contract.js";
import { createResolverContext } from "./runtime-shared.js";

describe("official external channel secret contracts", () => {
  it("collects active QQBot root and account SecretRefs for Tencent 2.0.1", () => {
    const config = {
      channels: {
        qqbot: {
          appId: "root-app",
          clientSecret: { source: "env" as const, provider: "default", id: "QQBOT_ROOT_SECRET" },
          accounts: {
            named: {
              appId: "named-app",
              clientSecret: {
                source: "env" as const,
                provider: "default",
                id: "QQBOT_NAMED_SECRET",
              },
            },
          },
        },
      },
    };
    const context = createResolverContext({ sourceConfig: config, env: {} });
    const api = loadOfficialExternalChannelSecretContractApi("qqbot");

    api?.collectRuntimeConfigAssignments({ config, defaults: undefined, context });

    expect(context.assignments.map((assignment) => assignment.path)).toEqual([
      "channels.qqbot.clientSecret",
      "channels.qqbot.accounts.named.clientSecret",
    ]);
    context.assignments[0]?.apply("resolved-root-secret");
    context.assignments[1]?.apply("resolved-named-secret");
    expect(config.channels.qqbot.clientSecret).toBe("resolved-root-secret");
    expect(config.channels.qqbot.accounts.named.clientSecret).toBe("resolved-named-secret");
  });

  it("uses QQBOT_APP_ID only for the default account and skips inactive credentials", () => {
    const config = {
      channels: {
        qqbot: {
          clientSecret: { source: "env" as const, provider: "default", id: "QQBOT_ROOT_SECRET" },
          accounts: {
            disabled: {
              enabled: false,
              appId: "disabled-app",
              clientSecret: {
                source: "env" as const,
                provider: "default",
                id: "QQBOT_DISABLED_SECRET",
              },
            },
            missingAppId: {
              clientSecret: {
                source: "env" as const,
                provider: "default",
                id: "QQBOT_MISSING_APP_SECRET",
              },
            },
          },
        },
      },
    };
    const context = createResolverContext({
      sourceConfig: config,
      env: { QQBOT_APP_ID: "env-app" },
    });
    const api = loadOfficialExternalChannelSecretContractApi("qqbot");

    api?.collectRuntimeConfigAssignments({ config, defaults: undefined, context });

    expect(context.assignments.map((assignment) => assignment.path)).toEqual([
      "channels.qqbot.clientSecret",
    ]);
    expect(config.channels.qqbot).toHaveProperty("appId", "env-app");
    expect(context.warnings.map((warning) => warning.path)).toEqual([
      "channels.qqbot.accounts.disabled.clientSecret",
      "channels.qqbot.accounts.missingAppId.clientSecret",
    ]);
  });
});
