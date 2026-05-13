import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "./channel.js";
import type { TelegramMonitorFn } from "./monitor.types.js";
import { clearTelegramRuntime, setTelegramRuntime } from "./runtime.js";
import type { TelegramProbeFn } from "./runtime.types.js";
import type { TelegramRuntime } from "./runtime.types.js";

const probeTelegram = vi.fn();
const monitorTelegramProvider = vi.fn();
const sendMessageTelegram = vi.fn();

function installTelegramRuntime() {
  const runtime = createPluginRuntimeMock();
  setTelegramRuntime({
    ...runtime,
    channel: {
      ...runtime.channel,
      telegram: {
        probeTelegram: probeTelegram as TelegramProbeFn,
        monitorTelegramProvider: monitorTelegramProvider as TelegramMonitorFn,
        sendMessageTelegram,
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
  if (!startAccount) {
    throw new Error("expected Telegram startAccount gateway handler");
  }
  const ctx = createStartAccountContext({
    account,
    cfg,
  });
  return {
    ctx,
    task: startAccount(ctx),
  };
}

function latestMonitorOptions(): {
  token?: string;
  accountId?: string;
  useWebhook?: boolean;
  botInfo?: unknown;
} {
  const calls = monitorTelegramProvider.mock.calls;
  const options = calls[calls.length - 1]?.[0];
  if (!options || typeof options !== "object") {
    throw new Error("expected monitor Telegram options");
  }
  return options;
}

function sendMessageOptionsAt(index: number): Record<string, unknown> {
  const options = sendMessageTelegram.mock.calls[index]?.[2];
  if (!options || typeof options !== "object") {
    throw new Error(`expected sendMessageTelegram options ${index}`);
  }
  return options;
}

afterEach(() => {
  clearTelegramRuntime();
  probeTelegram.mockReset();
  monitorTelegramProvider.mockReset();
  sendMessageTelegram.mockReset();
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
      '[ops] Telegram bot token unauthorized for account "ops" (getMe returned 401 from Telegram; source: config token). Update channels.telegram.accounts.ops.botToken/tokenFile with the current BotFather token.',
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
    const monitorOptions = latestMonitorOptions();
    expect(monitorOptions.token).toBe("123456:bad-token");
    expect(monitorOptions.accountId).toBe("default");
    expect(monitorOptions.useWebhook).toBe(false);
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
    expect(probeTelegram).toHaveBeenCalledWith("123456:bad-token", 15_000, {
      accountId: "default",
      proxyUrl: undefined,
      network: undefined,
      apiRoot: undefined,
      includeWebhookInfo: false,
    });
  });

  it("passes successful startup probe botInfo into the polling monitor", async () => {
    installTelegramRuntime();
    const botInfo = {
      id: 123456,
      is_bot: true,
      first_name: "OpenClaw",
      username: "openclaw_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      can_manage_bots: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
    } as const;
    probeTelegram.mockResolvedValue({
      ok: true,
      status: null,
      error: null,
      elapsedMs: 12,
      bot: {
        id: botInfo.id,
        username: botInfo.username,
      },
      botInfo,
    });
    monitorTelegramProvider.mockResolvedValue(undefined);

    const { task } = startTelegramAccount();

    await expect(task).resolves.toBeUndefined();
    expect(latestMonitorOptions().botInfo).toBe(botInfo);
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
    expect(probeTelegram).toHaveBeenCalledWith("123456:bad-token", 60_000, {
      accountId: "ops",
      proxyUrl: undefined,
      network: undefined,
      apiRoot: undefined,
      includeWebhookInfo: false,
    });
  });
});

describe("telegramPlugin outbound attachments", () => {
  it("preserves default markdown rendering unless a parse mode is explicit", async () => {
    installTelegramRuntime();
    sendMessageTelegram.mockResolvedValue({ messageId: "tg-1", chatId: "12345" });
    const sendText = telegramPlugin.outbound?.sendText;
    if (!sendText) {
      throw new Error("Expected Telegram outbound sendText");
    }

    await sendText({
      cfg: createTelegramConfig(),
      to: "12345",
      text: "hi **boss**",
    });
    expect(sendMessageOptionsAt(0)).not.toHaveProperty("textMode");

    await sendText({
      cfg: createTelegramConfig(),
      to: "12345",
      text: "<b>hi boss</b>",
      formatting: { parseMode: "HTML" },
    });
    expect(sendMessageOptionsAt(1).textMode).toBe("html");
  });

  it("preserves explicit HTML parse mode for payload media captions", async () => {
    installTelegramRuntime();
    sendMessageTelegram.mockResolvedValue({ messageId: "tg-payload", chatId: "12345" });
    const sendPayload = telegramPlugin.outbound?.sendPayload;
    if (!sendPayload) {
      throw new Error("Expected Telegram outbound sendPayload");
    }

    await sendPayload({
      cfg: createTelegramConfig(),
      to: "12345",
      text: "",
      payload: {
        text: "<b>report</b>",
        mediaUrl: "https://example.com/report.png",
      },
      formatting: { parseMode: "HTML" },
    });

    expect(sendMessageOptionsAt(0).textMode).toBe("html");
  });
});
