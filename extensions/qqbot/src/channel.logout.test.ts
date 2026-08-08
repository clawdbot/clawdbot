// QQBot logout tests cover gateway-level credential cleanup behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setQQBotRuntime } from "./bridge/runtime.js";
import { qqbotPlugin } from "./channel.js";
import type { QQBotAccountConfig, ResolvedQQBotAccount } from "./types.js";

type QQBotRuntimeMocks = {
  replaceConfigFile: ReturnType<typeof vi.fn>;
};

type QQBotLogoutAccount = NonNullable<NonNullable<typeof qqbotPlugin.gateway>["logoutAccount"]>;

function createRuntime(): { runtime: PluginRuntime; mocks: QQBotRuntimeMocks } {
  const replaceConfigFile = vi.fn(async () => {});
  const runtime = {
    version: "test",
    config: { replaceConfigFile },
  } as unknown as PluginRuntime;
  return { runtime, mocks: { replaceConfigFile } };
}

async function runLogoutScenario(params: { cfg: OpenClawConfig; accountId: string }): Promise<{
  result: Awaited<ReturnType<QQBotLogoutAccount>>;
  account: ResolvedQQBotAccount;
  mocks: QQBotRuntimeMocks;
}> {
  const { runtime, mocks } = createRuntime();
  setQQBotRuntime(runtime);
  const logoutAccount = qqbotPlugin.gateway?.logoutAccount;
  if (!logoutAccount) {
    throw new Error("QQBot gateway logoutAccount missing");
  }
  const account = qqbotPlugin.config.resolveAccount(params.cfg, params.accountId);
  const result = await logoutAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    account,
    runtime: createRuntimeEnv(),
  });
  return { result, account, mocks };
}

describe("qqbotPlugin gateway.logoutAccount", () => {
  afterEach(() => {
    setQQBotRuntime({ version: "test" } as PluginRuntime);
  });

  it("ignores inherited named accounts during logout cleanup", async () => {
    const inheritedAccount = {
      appId: "app-id",
      clientSecret: "secret",
      clientSecretFile: "/tmp/secret",
    };
    const accounts = Object.create({ bot2: inheritedAccount }) as Record<
      string,
      Record<string, unknown>
    >;
    const cfg = {
      channels: {
        qqbot: {
          accounts,
        },
      },
    } satisfies OpenClawConfig;

    const { result, account, mocks } = await runLogoutScenario({ cfg, accountId: "bot2" });

    expect(account.secretSource).toBe("none");
    expect(result).toStrictEqual({
      ok: true,
      cleared: false,
      envToken: false,
      loggedOut: true,
    });
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(Object.hasOwn(accounts, "bot2")).toBe(false);
    expect(inheritedAccount).toEqual({
      appId: "app-id",
      clientSecret: "secret",
      clientSecretFile: "/tmp/secret",
    });
  });

  it("ignores an inherited accounts container during logout", async () => {
    const inheritedAccounts = {
      bot2: {
        appId: "app-id",
        clientSecret: "secret",
        clientSecretFile: "/tmp/secret",
      },
    };
    const qqbot = Object.create({ accounts: inheritedAccounts }) as Record<string, unknown>;
    const cfg = { channels: { qqbot } } as unknown as OpenClawConfig;

    const { result, account, mocks } = await runLogoutScenario({ cfg, accountId: "bot2" });

    expect(account.appId).toBe("");
    expect(account.secretSource).toBe("none");
    expect(result).toStrictEqual({
      ok: true,
      cleared: false,
      envToken: false,
      loggedOut: true,
    });
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(Object.hasOwn(qqbot, "accounts")).toBe(false);
    expect(inheritedAccounts.bot2).toEqual({
      appId: "app-id",
      clientSecret: "secret",
      clientSecretFile: "/tmp/secret",
    });
  });

  it("ignores inherited credentials on an own named account during logout", async () => {
    const ownAccount = Object.assign(
      Object.create({
        clientSecret: "secret",
        clientSecretFile: "/tmp/secret",
      }) as QQBotAccountConfig,
      { appId: "app-id" },
    );
    const cfg = {
      channels: {
        qqbot: {
          accounts: { bot2: ownAccount },
        },
      },
    } satisfies OpenClawConfig;

    const { result, account, mocks } = await runLogoutScenario({ cfg, accountId: "bot2" });

    expect(account.secretSource).toBe("none");
    expect(result).toStrictEqual({
      ok: true,
      cleared: false,
      envToken: false,
      loggedOut: true,
    });
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(Object.hasOwn(ownAccount, "clientSecret")).toBe(false);
    expect(Object.hasOwn(ownAccount, "clientSecretFile")).toBe(false);
  });

  it("clears own named account credentials through the gateway logout entry point", async () => {
    const cfg = {
      channels: {
        qqbot: {
          accounts: {
            bot2: {
              appId: "app-id",
              clientSecret: "secret",
              clientSecretFile: "/tmp/secret",
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const { result, account, mocks } = await runLogoutScenario({ cfg, accountId: "bot2" });

    expect(account.secretSource).toBe("config");
    expect(result).toStrictEqual({
      ok: true,
      cleared: true,
      envToken: false,
      loggedOut: true,
    });
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(1);
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {
        channels: {
          qqbot: {
            accounts: {
              bot2: {
                appId: "app-id",
              },
            },
          },
        },
      },
      afterWrite: { mode: "auto" },
    });
  });
});
