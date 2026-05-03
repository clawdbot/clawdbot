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

function createTelegramConfig(
  accountId = "default",
  telegramOverrides: Record<string, unknown> = {},
): OpenClawConfig {
  if (accountId === "default") {
    return {
      channels: {
        telegram: {
          botToken: "123456:bad-token",
          ...telegramOverrides,
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
            ...telegramOverrides,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function startTelegramAccount(
  accountId = "default",
  telegramOverrides: Record<string, unknown> = {},
) {
  const cfg = createTelegramConfig(accountId, telegramOverrides);
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
  it("routes message actions through the gateway", () => {
    expect(telegramPlugin.actions?.resolveExecutionMode?.({ action: "send" as never })).toBe(
      "gateway",
    );
    expect(telegramPlugin.actions?.resolveExecutionMode?.({ action: "read" as never })).toBe(
      "gateway",
    );
  });

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

  it("uses the getMe request guard for startup probe timeout", async () => {
    installTelegramRuntime();
    probeTelegram.mockResolvedValue({
      ok: true,
      status: null,
      error: null,
      elapsedMs: 12,
    });
    monitorTelegramProvider.mockResolvedValue(undefined);

    const { task } = startTelegramAccount();

    await expect(task).resolves.toBeUndefined();
    expect(probeTelegram).toHaveBeenCalledWith(
      "123456:bad-token",
      15_000,
      expect.objectContaining({
        accountId: "default",
        includeWebhookInfo: false,
      }),
    );
  });

  it("honors higher per-account timeoutSeconds for startup probe", async () => {
    installTelegramRuntime();
    probeTelegram.mockResolvedValue({
      ok: true,
      status: null,
      error: null,
      elapsedMs: 12,
    });
    monitorTelegramProvider.mockResolvedValue(undefined);

    const { task } = startTelegramAccount("ops", { timeoutSeconds: 60 });

    await expect(task).resolves.toBeUndefined();
    expect(probeTelegram).toHaveBeenCalledWith(
      "123456:bad-token",
      60_000,
      expect.objectContaining({
        accountId: "ops",
        includeWebhookInfo: false,
      }),
    );
  });
});
