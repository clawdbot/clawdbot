// Nostr tests cover secret contract plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { nostrPlugin } from "./channel.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { listNostrAccountIds, resolveNostrAccount } from "./types.js";

const PRIVATE_KEY_HEX = "0000000000000000000000000000000000000000000000000000000000000001";

async function resolveNostrSecretAssignments(
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

describe("nostr secret contract", () => {
  it("publishes the Nostr private key target", () => {
    expect(secretTargetRegistryEntries.map((entry) => entry.id)).toEqual([
      "channels.nostr.privateKey",
    ]);
    expect(nostrPlugin.secrets).toMatchObject({
      collectRuntimeConfigAssignments,
      secretTargetRegistryEntries,
    });
  });

  it("materializes a SecretRef privateKey so the channel resolves as configured", async () => {
    const resolved = await resolveNostrSecretAssignments(
      {
        channels: {
          nostr: {
            enabled: true,
            privateKey: { source: "env", provider: "default", id: "NOSTR_PRIVATE_KEY" },
          },
        },
      } as OpenClawConfig,
      { NOSTR_PRIVATE_KEY: PRIVATE_KEY_HEX },
    );

    expect(resolved.config.channels?.nostr?.privateKey).toBe(PRIVATE_KEY_HEX);
    expect(resolved.warnings).toStrictEqual([]);

    const account = resolveNostrAccount({ cfg: resolved.config });
    expect(account.configured).toBe(true);
    expect(account.privateKey).toBe(PRIVATE_KEY_HEX);
    expect(account.publicKey.length).toBeGreaterThan(0);
    expect(listNostrAccountIds(resolved.config)).toEqual([account.accountId]);
  });

  it("keeps a plaintext privateKey configured", async () => {
    const resolved = await resolveNostrSecretAssignments(
      {
        channels: {
          nostr: {
            enabled: true,
            privateKey: PRIVATE_KEY_HEX,
          },
        },
      } as OpenClawConfig,
      {},
    );

    expect(resolved.config.channels?.nostr?.privateKey).toBe(PRIVATE_KEY_HEX);
    expect(resolveNostrAccount({ cfg: resolved.config }).configured).toBe(true);
    expect(listNostrAccountIds(resolved.config)).toEqual(["default"]);
  });
});
