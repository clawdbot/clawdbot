import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "./channel.js";
import type { TelegramMonitorFn } from "./monitor.types.js";
import { clearTelegramRuntime, setTelegramRuntime } from "./runtime.js";
import type { TelegramProbeFn } from "./runtime.types.js";
import type { TelegramRuntime } from "./runtime.types.js";

const probeTelegram = vi.fn();
const monitorTelegramProvider = vi.fn();

function installTelegramRuntime() {
  const runtime = createPluginRuntimeMock();
  setTelegramRuntime({
    ...runtime,
    channel: {
      ...runtime.channel,
      telegram: {
        probeTelegram: probeTelegram as TelegramProbeFn,
        monitorTelegramProvider: monitorTelegramProvider as TelegramMonitorFn,
      },
    },
  } as unknown as TelegramRuntime);
}

function createTelegramConfig(accountId = "default"): OpenClawConfig {
  if (accountId === "default") {
    return {
      channels: {
        telegram: {
          botToken: "123456:bad-token",
        },
      },
    } as OpenClawConfig;
  }

  return {
    channels: {
      telegram: {
        accounts: {
          [accountId]: {
            botToken: "123456:bad-token",
          },
        },
      },
    },
  } as OpenClawConfig;
}

function startTelegramAccount(accountId = "default") {
  const cfg = createTelegramConfig(accountId);
  const account = telegramPlugin.config.resolveAccount(cfg, accountId);
  const startAccount = telegramPlugin.gateway?.startAccount;
  expect(startAccount).toBeDefined();
  const ctx = createStartAccountContext({
    account,
    cfg,
  });
  return {
    ctx,
    task: startAccount!(ctx),
  };
}

afterEach(() => {
  clearTelegramRuntime();
  probeTelegram.mockReset();
  monitorTelegramProvider.mockReset();
});

describe("telegramPlugin gateway startup", () => {
  it("stops before monitor startup when getMe rejects the token", async () => {
    installTelegramRuntime();
    probeTelegram.mockResolvedValue({
      ok: false,
      status: 401,
      error: "Unauthorized",
      elapsedMs: 12,
    });

    const { ctx, task } = startTelegramAccount("ops");

    await expect(task).rejects.toThrow(
      'Telegram bot token unauthorized for account "ops" (getMe returned 401',
    );
    await expect(task).rejects.toThrow("channels.telegram.accounts.ops.botToken/tokenFile");
    expect(monitorTelegramProvider).not.toHaveBeenCalled();
    expect(ctx.log?.error).toHaveBeenCalledWith(
      expect.stringContaining('Telegram bot token unauthorized for account "ops"'),
    );
  });

  it("keeps existing fallback startup for non-auth probe failures", async () => {
    installTelegramRuntime();
    probeTelegram.mockResolvedValue({
      ok: false,
      status: 500,
      error: "Bad Gateway",
      elapsedMs: 12,
    });
    monitorTelegramProvider.mockResolvedValue(undefined);

    const { task } = startTelegramAccount();

    await expect(task).resolves.toBeUndefined();
    expect(monitorTelegramProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "123456:bad-token",
        accountId: "default",
        useWebhook: false,
      }),
    );
  });
});
