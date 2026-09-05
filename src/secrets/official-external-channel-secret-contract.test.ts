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
            "Named.Team": {
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

    expect(context.assignments).toEqual([
      expect.objectContaining({
        path: "channels.qqbot.clientSecret",
        ownerKind: "account",
        ownerId: "qqbot:default",
        requiredForGateway: false,
        disposition: "isolate",
        ownerContractDigest: expect.any(String),
      }),
      expect.objectContaining({
        path: "channels.qqbot.accounts.Named.Team.clientSecret",
        ownerKind: "account",
        ownerId: "qqbot:named-team",
        requiredForGateway: false,
        disposition: "isolate",
        ownerContractDigest: expect.any(String),
      }),
    ]);
    context.assignments[0]?.apply("resolved-root-secret");
    context.assignments[1]?.apply("resolved-named-secret");
    expect(config.channels.qqbot.clientSecret).toBe("resolved-root-secret");
    expect(config.channels.qqbot.accounts["Named.Team"].clientSecret).toBe("resolved-named-secret");
  });

  it("keeps each account owner contract independent of unrelated sibling credentials", () => {
    const createConfig = () => ({
      channels: {
        qqbot: {
          enabled: true,
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
            sibling: {
              appId: "sibling-app",
              clientSecret: {
                source: "env" as const,
                provider: "default",
                id: "QQBOT_SIBLING_SECRET",
              },
            },
          },
        },
      },
    });
    const collectDigests = (config: ReturnType<typeof createConfig>) => {
      const context = createResolverContext({ sourceConfig: config, env: {} });
      loadOfficialExternalChannelSecretContractApi("qqbot")?.collectRuntimeConfigAssignments({
        config,
        defaults: undefined,
        context,
      });
      return new Map(
        context.assignments.map(({ ownerId, ownerContractDigest }) => [
          ownerId,
          ownerContractDigest,
        ]),
      );
    };

    const baseline = collectDigests(createConfig());
    const changedSibling = createConfig();
    changedSibling.channels.qqbot.accounts.sibling.appId = "different-sibling-app";
    const siblingDigests = collectDigests(changedSibling);
    expect(siblingDigests.get("qqbot:default")).toBe(baseline.get("qqbot:default"));
    expect(siblingDigests.get("qqbot:named")).toBe(baseline.get("qqbot:named"));
    expect(siblingDigests.get("qqbot:sibling")).not.toBe(baseline.get("qqbot:sibling"));

    const changedRootCredential = createConfig();
    changedRootCredential.channels.qqbot.clientSecret.id = "QQBOT_DIFFERENT_ROOT_SECRET";
    const rootDigests = collectDigests(changedRootCredential);
    expect(rootDigests.get("qqbot:default")).not.toBe(baseline.get("qqbot:default"));
    expect(rootDigests.get("qqbot:named")).toBe(baseline.get("qqbot:named"));
    expect(rootDigests.get("qqbot:sibling")).toBe(baseline.get("qqbot:sibling"));
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
