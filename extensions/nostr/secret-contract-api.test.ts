import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createResolverContext } from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import {
  channelSecrets,
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./secret-contract-api.js";

describe("Nostr public secret contract", () => {
  it("publishes the private-key target for plan, configure, apply, and audit", () => {
    expect(channelSecrets.secretTargetRegistryEntries).toBe(secretTargetRegistryEntries);
    expect(channelSecrets.collectRuntimeConfigAssignments).toBe(collectRuntimeConfigAssignments);
    expect(secretTargetRegistryEntries).toEqual([
      expect.objectContaining({
        id: "channels.nostr.privateKey",
        pathPattern: "channels.nostr.privateKey",
        includeInPlan: true,
        includeInConfigure: true,
        includeInAudit: true,
      }),
    ]);
  });

  it.each([
    { defaultAccount: undefined, ownerId: "nostr:default" },
    { defaultAccount: "Team.A", ownerId: "nostr:team-a" },
  ])(
    "assigns the configured private key to exact owner $ownerId",
    ({ defaultAccount, ownerId }) => {
      const sourceConfig = {
        channels: {
          nostr: {
            ...(defaultAccount ? { defaultAccount } : {}),
            relays: ["wss://relay.example"],
            privateKey: { source: "env", provider: "default", id: "NOSTR_TEST_PRIVATE_KEY" },
          },
        },
      } as OpenClawConfig;
      const config = structuredClone(sourceConfig);
      const context = createResolverContext({ sourceConfig, env: {} });

      collectRuntimeConfigAssignments({ config, context });

      expect(context.assignments).toEqual([
        expect.objectContaining({
          path: "channels.nostr.privateKey",
          ownerKind: "account",
          ownerId,
          requiredForGateway: false,
          disposition: "isolate",
          ownerContractDigest: expect.any(String),
        }),
      ]);
      context.assignments[0]?.apply("materialized-private-key");
      expect(config.channels?.nostr?.privateKey).toBe("materialized-private-key");
    },
  );

  it.each(["file", "exec", "store"] as const)(
    "does not collect an active $0 provider assignment while Nostr is disabled",
    (source) => {
      const sourceConfig = {
        channels: {
          nostr: {
            enabled: false,
            privateKey: { source, provider: "vault", id: "NOSTR_TEST_PRIVATE_KEY" },
          },
        },
      } as OpenClawConfig;
      const context = createResolverContext({ sourceConfig, env: {} });

      collectRuntimeConfigAssignments({ config: structuredClone(sourceConfig), context });

      expect(context.assignments).toEqual([]);
      expect(context.warnings).toEqual([
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "channels.nostr.privateKey",
        }),
      ]);
    },
  );
});
