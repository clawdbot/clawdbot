import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, ResolvedLineAccount } from "../api.js";
import { lineGatewayAdapter } from "./gateway.js";
import { setLineRuntime } from "./runtime.js";

const DEFAULT_ACCOUNT_ID = "default";

type LineRuntimeMocks = {
  replaceConfigFile: ReturnType<typeof vi.fn>;
  resolveLineAccount: ReturnType<typeof vi.fn>;
};

function createRuntime(): { runtime: PluginRuntime; mocks: LineRuntimeMocks } {
  const replaceConfigFile = vi.fn(async () => {});
  const resolveLineAccount = vi.fn(
    ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) => {
      const lineConfig = (cfg.channels?.line ?? {}) as {
        tokenFile?: string;
        secretFile?: string;
        channelAccessToken?: string;
        channelSecret?: string;
        accounts?: Record<string, Record<string, unknown>>;
      };
      const entry =
        accountId && accountId !== DEFAULT_ACCOUNT_ID
          ? (lineConfig.accounts?.[accountId] ?? {})
          : lineConfig;
      const hasToken =
        Boolean((entry as any).channelAccessToken) || Boolean((entry as any).tokenFile);
      const hasSecret = Boolean((entry as any).channelSecret) || Boolean((entry as any).secretFile);
      return { tokenSource: hasToken && hasSecret ? "config" : "none" };
    },
  );

  const runtime = {
    config: { replaceConfigFile },
  } as unknown as PluginRuntime;

  return { runtime, mocks: { replaceConfigFile, resolveLineAccount } };
}

function resolveAccount(
  resolveLineAccount: LineRuntimeMocks["resolveLineAccount"],
  cfg: OpenClawConfig,
  accountId: string,
): ResolvedLineAccount {
  const resolver = resolveLineAccount as unknown as (params: {
    cfg: OpenClawConfig;
    accountId?: string;
  }) => ResolvedLineAccount;
  return resolver({ cfg, accountId });
}

async function runLogoutScenario(params: { cfg: OpenClawConfig; accountId: string }): Promise<{
  result: Awaited<ReturnType<NonNullable<typeof lineGatewayAdapter.logoutAccount>>>;
  mocks: LineRuntimeMocks;
}> {
  const { runtime, mocks } = createRuntime();
  setLineRuntime(runtime);
  const account = resolveAccount(mocks.resolveLineAccount, params.cfg, params.accountId);
  const result = await lineGatewayAdapter.logoutAccount!({
    accountId: params.accountId,
    cfg: params.cfg,
    account,
    runtime: createRuntimeEnv(),
  });
  return { result, mocks };
}

describe("linePlugin gateway.logoutAccount", () => {
  beforeEach(() => {
    setLineRuntime(createRuntime().runtime);
  });

  it("clears tokenFile/secretFile on default account logout", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        line: {
          tokenFile: "/tmp/token",
          secretFile: "/tmp/secret",
        },
      },
    };
    const { result, mocks } = await runLogoutScenario({
      cfg,
      accountId: DEFAULT_ACCOUNT_ID,
    });

    expect(result.cleared).toBe(true);
    expect(result.loggedOut).toBe(true);
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {},
      afterWrite: { mode: "auto" },
    });
  });

  it("clears tokenFile/secretFile on account logout", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        line: {
          accounts: {
            primary: {
              tokenFile: "/tmp/token",
              secretFile: "/tmp/secret",
            },
          },
        },
      },
    };
    const { result, mocks } = await runLogoutScenario({
      cfg,
      accountId: "primary",
    });

    expect(result.cleared).toBe(true);
    expect(result.loggedOut).toBe(true);
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {},
      afterWrite: { mode: "auto" },
    });
  });

  it("does not write config when account has no token/secret fields", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        line: {
          accounts: {
            primary: {
              name: "Primary",
            },
          },
        },
      },
    };
    const { result, mocks } = await runLogoutScenario({
      cfg,
      accountId: "primary",
    });

    expect(result.cleared).toBe(false);
    expect(result.loggedOut).toBe(true);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });
});
