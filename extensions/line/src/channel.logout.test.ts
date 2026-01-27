import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MoltbotConfig, PluginRuntime } from "clawdbot/plugin-sdk";
import { linePlugin } from "./channel.js";
import { setLineRuntime } from "./runtime.js";

const DEFAULT_ACCOUNT_ID = "default";

type LineRuntimeMocks = {
  writeConfigFile: ReturnType<typeof vi.fn>;
  resolveLineAccount: ReturnType<typeof vi.fn>;
};

function createRuntime(): { runtime: PluginRuntime; mocks: LineRuntimeMocks } {
  const writeConfigFile = vi.fn(async () => {});
  const resolveLineAccount = vi.fn(({ cfg, accountId }: { cfg: MoltbotConfig; accountId?: string }) => {
    const lineConfig = (cfg.channels?.line ?? {}) as {
      tokenFile?: string;
      secretFile?: string;
      channelAccessToken?: string;
      channelSecret?: string;
      accounts?: Record<string, Record<string, unknown>>;
    };
    const entry =
      accountId && accountId !== DEFAULT_ACCOUNT_ID
        ? lineConfig.accounts?.[accountId] ?? {}
        : lineConfig;
    const hasToken =
      Boolean((entry as any).channelAccessToken) || Boolean((entry as any).tokenFile);
    const hasSecret =
      Boolean((entry as any).channelSecret) || Boolean((entry as any).secretFile);
    return { tokenSource: hasToken && hasSecret ? "config" : "none" };
  });

  const runtime = {
    config: { writeConfigFile },
    channel: { line: { resolveLineAccount } },
  } as unknown as PluginRuntime;

  return { runtime, mocks: { writeConfigFile, resolveLineAccount } };
}

describe("linePlugin gateway.logoutAccount", () => {
  beforeEach(() => {
    setLineRuntime(createRuntime().runtime);
  });

  it("clears tokenFile/secretFile on default account logout", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);

    const cfg: MoltbotConfig = {
      channels: {
        line: {
          tokenFile: "/tmp/token",
          secretFile: "/tmp/secret",
        },
      },
    };

    const result = await linePlugin.gateway.logoutAccount({
      accountId: DEFAULT_ACCOUNT_ID,
      cfg,
    });

    expect(result.cleared).toBe(true);
    expect(result.loggedOut).toBe(true);
    expect(mocks.writeConfigFile).toHaveBeenCalledWith({});
  });

  it("clears tokenFile/secretFile on account logout", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);

    const cfg: MoltbotConfig = {
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

    const result = await linePlugin.gateway.logoutAccount({
      accountId: "primary",
      cfg,
    });

    expect(result.cleared).toBe(true);
    expect(result.loggedOut).toBe(true);
    expect(mocks.writeConfigFile).toHaveBeenCalledWith({});
  });
});
