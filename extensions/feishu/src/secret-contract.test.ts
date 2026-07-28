// Feishu tests cover secret contract plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createResolverContext } from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";

describe("feishu secret contract", () => {
  it("assigns an enabled accountless appSecret to the default owner without a configured appId", () => {
    const sourceConfig = {
      channels: {
        feishu: {
          enabled: true,
          appSecret: {
            source: "env",
            provider: "default",
            id: "FEISHU_APP_SECRET",
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

    expect(context.assignments).toMatchObject([
      {
        path: "channels.feishu.appSecret",
        ownerKind: "account",
        ownerId: "feishu:default",
      },
    ]);
    expect(context.warnings).toStrictEqual([]);
  });

  it("does not synthesize a second default owner for normalized account aliases", () => {
    const sourceConfig = {
      channels: {
        feishu: {
          enabled: true,
          appId: "top-app-id",
          appSecret: {
            source: "env",
            provider: "default",
            id: "FEISHU_UNUSED_VALUE",
          },
          accounts: {
            " default ": {
              enabled: true,
              appId: "account-app-id",
              appSecret: "fixture",
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

    expect(context.assignments).toStrictEqual([]);
    expect(context.warnings).toMatchObject([{ path: "channels.feishu.appSecret" }]);
  });
});
