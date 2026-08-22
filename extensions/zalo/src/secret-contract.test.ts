import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createResolverContext } from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";

describe("Zalo secret contract", () => {
  it.each([
    { label: "only a file-backed account", inherited: false, owners: [] },
    { label: "another eligible account", inherited: true, owners: ["zalo:inherited"] },
  ])("does not assign an inherited botToken to a file-backed account with $label", (scenario) => {
    const sourceConfig = {
      channels: {
        zalo: {
          botToken: { source: "env", provider: "default", id: "ZALO_SHARED_TOKEN" },
          accounts: {
            file: { tokenFile: "/run/secrets/zalo-file-token" },
            ...(scenario.inherited ? { inherited: {} } : {}),
          },
        },
      },
    } satisfies OpenClawConfig;
    const context = createResolverContext({ sourceConfig, env: {} });

    collectRuntimeConfigAssignments({ config: structuredClone(sourceConfig), context });

    expect(context.assignments.map(({ path, ownerId }) => ({ path, ownerId }))).toEqual(
      scenario.owners.map((ownerId) => ({ path: "channels.zalo.botToken", ownerId })),
    );
  });

  it("keeps an account-owned botToken active ahead of its same-scope tokenFile", () => {
    const sourceConfig = {
      channels: {
        zalo: {
          accounts: {
            work: {
              botToken: { source: "env", provider: "default", id: "ZALO_WORK_TOKEN" },
              tokenFile: "/run/secrets/zalo-work-token",
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const context = createResolverContext({ sourceConfig, env: {} });

    collectRuntimeConfigAssignments({ config: structuredClone(sourceConfig), context });

    expect(context.assignments).toMatchObject([
      { path: "channels.zalo.accounts.work.botToken", ownerId: "zalo:work" },
    ]);
  });
});
