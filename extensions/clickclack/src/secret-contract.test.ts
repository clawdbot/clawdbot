// ClickClack tests cover token secret contract behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createResolverContext } from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";

describe("ClickClack secret contract", () => {
  it("publishes ClickClack token targets", () => {
    expect(secretTargetRegistryEntries.map((entry) => entry.id)).toEqual([
      "channels.clickclack.accounts.*.token",
      "channels.clickclack.token",
    ]);
  });

  it("collects an account file SecretRef even when the default uses tokenFile", () => {
    const sourceConfig = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://clickclack.example",
          workspace: "default",
          tokenFile: "/run/secrets/default-clickclack-token",
          accounts: {
            work: {
              token: { source: "file", provider: "vault", id: "/clickclack/work" },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const context = createResolverContext({ sourceConfig, env: {} });

    collectRuntimeConfigAssignments({
      config: structuredClone(sourceConfig),
      defaults: undefined,
      context,
    });

    expect(context.assignments).toHaveLength(1);
    expect(context.assignments[0]).toMatchObject({
      path: "channels.clickclack.accounts.work.token",
      ref: { source: "file", provider: "vault", id: "/clickclack/work" },
    });
    expect(context.warnings).toStrictEqual([]);
  });
});
