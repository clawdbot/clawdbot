// Microsoft Teams gateway startup must preserve the active account identity.
import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedMSTeamsAccount } from "./channel-config.js";

const monitorMSTeamsProvider = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./index.js", () => ({ monitorMSTeamsProvider }));

import { msteamsPlugin } from "./channel.js";

function requireStartAccount() {
  const startAccount = msteamsPlugin.gateway?.startAccount;
  if (!startAccount) {
    throw new Error("expected Microsoft Teams gateway startAccount");
  }
  return startAccount;
}

function createConfig(): OpenClawConfig {
  return {
    channels: {
      msteams: {
        enabled: true,
        appId: "app-id",
        appPassword: "app-password", // pragma: allowlist secret
        tenantId: "tenant-id",
        webhook: { port: 0 },
      },
    },
  } as OpenClawConfig;
}

describe("msteamsPlugin gateway.startAccount", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(["jimmy", "david"])(
    "passes active account %s into the provider monitor",
    async (accountId) => {
      const account: ResolvedMSTeamsAccount = {
        accountId,
        enabled: true,
        configured: true,
      };
      const context = createStartAccountContext({ account, cfg: createConfig() });

      await requireStartAccount()(context);

      expect(monitorMSTeamsProvider).toHaveBeenCalledOnce();
      expect(monitorMSTeamsProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          cfg: context.cfg,
          accountId,
          runtime: context.runtime,
          abortSignal: context.abortSignal,
        }),
      );
    },
  );
});
