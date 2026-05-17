import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCachedTelegramBotInfo, writeCachedTelegramBotInfo } from "./bot-info-cache.js";
import type { TelegramBotInfo } from "./bot-info.js";
import { telegramPlugin } from "./channel.js";
import type { TelegramMonitorFn } from "./monitor.types.js";
import {
  acquireTelegramPollingLease,
  resetTelegramPollingLeasesForTests,
} from "./polling-lease.js";
import { clearTelegramRuntime, setTelegramRuntime } from "./runtime.js";
import type { TelegramProbeFn } from "./runtime.types.js";
import type { TelegramRuntime } from "./runtime.types.js";
import { resetTelegramStartupProbeLimiterForTests } from "./startup-probe-limiter.js";

const probeTelegram = vi.fn();
const monitorTelegramProvider = vi.fn();
const sendMessageTelegram = vi.fn();
const tempRoots: string[] = [];

const startupBotInfo: TelegramBotInfo = {
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
};

async function useTempStateDir(): Promise<string> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tg-channel-"));
  tempRoots.push(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return stateDir;
}

function installTelegramRuntime() {
  const runtime = createPluginRuntimeMock();
  const telegramRuntime = {
    ...runtime,
    channel: {
      ...runtime.channel,
      telegram: {
        probeTelegram: probeTelegram as TelegramProbeFn,
        monitorTelegramProvider: monitorTelegramProvider as TelegramMonitorFn,
        sendMessageTelegram,
      },
    },
  } as unknown as TelegramRuntime;
  setTelegramRuntime(telegramRuntime);
  return telegramRuntime;
}

function createRuntimeEnvMock() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
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
  abortSignal?: AbortSignal,
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
    ...(abortSignal ? { abortSignal } : {}),
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

async function waitForCondition(check: () => boolean, message: string, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

afterEach(async () => {
  clearTelegramRuntime();
  resetTelegramPollingLeasesForTests();
  resetTelegramStartupProbeLimiterForTests();
  probeTelegram.mockReset();
  monitorTelegramProvider.mockReset();
  sendMessageTelegram.mockReset();
  vi.unstubAllEnvs();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
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
    probeTelegram.mockResolvedValue({
      ok: true,
      status: null,
      error: null,
      elapsedMs: 12,
      bot: {
        id: startupBotInfo.id,
        username: startupBotInfo.username,
      },
      botInfo: startupBotInfo,
    });
    monitorTelegramProvider.mockResolvedValue(undefined);

    const { task } = startTelegramAccount();

    await expect(task).resolves.toBeUndefined();
    expect(latestMonitorOptions().botInfo).toBe(startupBotInfo);
  });

  it("caches successful startup probe botInfo for later restarts", async () => {
    await useTempStateDir();
    installTelegramRuntime();
    probeTelegram.mockResolvedValue({
      ok: true,
      status: null,
      error: null,
      elapsedMs: 12,
      bot: {
        id: startupBotInfo.id,
        username: startupBotInfo.username,
      },
      botInfo: startupBotInfo,
    });
    monitorTelegramProvider.mockResolvedValue(undefined);

    const { task } = startTelegramAccount("ops");

    await expect(task).resolves.toBeUndefined();
    await expect(
      readCachedTelegramBotInfo({
        accountId: "ops",
        botToken: "123456:bad-token",
      }),
    ).resolves.toMatchObject({ botInfo: startupBotInfo });
  });

  it("uses cached startup botInfo without calling getMe", async () => {
    await useTempStateDir();
    installTelegramRuntime();
    await writeCachedTelegramBotInfo({
      accountId: "ops",
      botToken: "123456:bad-token",
      botInfo: startupBotInfo,
    });
    monitorTelegramProvider.mockResolvedValue(undefined);

    const { task } = startTelegramAccount("ops");

    await expect(task).resolves.toBeUndefined();
    expect(probeTelegram).not.toHaveBeenCalled();
    expect(latestMonitorOptions().botInfo).toEqual(startupBotInfo);
  });

  it("deletes cached startup botInfo when the account token changes", async () => {
    await useTempStateDir();
    installTelegramRuntime();
    await writeCachedTelegramBotInfo({
      accountId: "ops",
      botToken: "123456:bad-token",
      botInfo: startupBotInfo,
    });

    await telegramPlugin.lifecycle?.onAccountConfigChanged?.({
      accountId: "ops",
      prevCfg: createTelegramConfig("ops"),
      nextCfg: createTelegramConfig("ops", { botToken: "123456:new-token" }),
      runtime: createRuntimeEnvMock(),
    });

    await expect(
      readCachedTelegramBotInfo({
        accountId: "ops",
        botToken: "123456:bad-token",
      }),
    ).resolves.toBeNull();
  });

  it("keeps cached startup botInfo when unrelated Telegram config changes", async () => {
    await useTempStateDir();
    installTelegramRuntime();
    await writeCachedTelegramBotInfo({
      accountId: "ops",
      botToken: "123456:bad-token",
      botInfo: startupBotInfo,
    });

    await telegramPlugin.lifecycle?.onAccountConfigChanged?.({
      accountId: "ops",
      prevCfg: createTelegramConfig("ops"),
      nextCfg: createTelegramConfig("ops", { timeoutSeconds: 60 }),
      runtime: createRuntimeEnvMock(),
    });

    await expect(
      readCachedTelegramBotInfo({
        accountId: "ops",
        botToken: "123456:bad-token",
      }),
    ).resolves.toMatchObject({ botInfo: startupBotInfo });
  });

  it("deletes cached startup botInfo when the account is removed", async () => {
    await useTempStateDir();
    installTelegramRuntime();
    await writeCachedTelegramBotInfo({
      accountId: "ops",
      botToken: "123456:bad-token",
      botInfo: startupBotInfo,
    });

    await telegramPlugin.lifecycle?.onAccountRemoved?.({
      accountId: "ops",
      prevCfg: createTelegramConfig("ops"),
      runtime: createRuntimeEnvMock(),
    });

    await expect(
      readCachedTelegramBotInfo({
        accountId: "ops",
        botToken: "123456:bad-token",
      }),
    ).resolves.toBeNull();
  });

  it("deletes cached startup botInfo when logout clears the account token", async () => {
    await useTempStateDir();
    installTelegramRuntime();
    const cfg = createTelegramConfig("ops");
    const account = telegramPlugin.config.resolveAccount(cfg, "ops");
    await writeCachedTelegramBotInfo({
      accountId: "ops",
      botToken: "123456:bad-token",
      botInfo: startupBotInfo,
    });

    await telegramPlugin.gateway?.logoutAccount?.({
      accountId: "ops",
      account,
      cfg,
      runtime: createRuntimeEnvMock(),
    });

    await expect(
      readCachedTelegramBotInfo({
        accountId: "ops",
        botToken: "123456:bad-token",
      }),
    ).resolves.toBeNull();
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

  it("limits concurrent startup probes across Telegram accounts", async () => {
    installTelegramRuntime();
    const releaseProbe: Array<() => void> = [];
    let activeProbes = 0;
    let maxActiveProbes = 0;
    probeTelegram.mockImplementation(async () => {
      activeProbes += 1;
      maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
      await new Promise<void>((resolve) => {
        releaseProbe.push(resolve);
      });
      activeProbes -= 1;
      return {
        ok: true,
        status: null,
        error: null,
        elapsedMs: 12,
      };
    });
    monitorTelegramProvider.mockResolvedValue(undefined);

    const first = startTelegramAccount("alpha");
    const second = startTelegramAccount("bravo");
    const third = startTelegramAccount("charlie");

    await waitForCondition(
      () => probeTelegram.mock.calls.length === 2,
      "expected two startup probes to begin",
    );
    expect(maxActiveProbes).toBe(2);
    expect(releaseProbe).toHaveLength(2);

    releaseProbe.shift()?.();
    await waitForCondition(
      () => probeTelegram.mock.calls.length === 3,
      "expected queued startup probe to begin after a slot opens",
    );
    expect(maxActiveProbes).toBe(2);

    for (const release of releaseProbe.splice(0)) {
      release();
    }
    await Promise.all([first.task, second.task, third.task]);
    expect(monitorTelegramProvider).toHaveBeenCalledTimes(3);
  });

  it("abandons a queued startup probe when the account aborts", async () => {
    installTelegramRuntime();
    const releaseProbe: Array<() => void> = [];
    probeTelegram.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          releaseProbe.push(() =>
            resolve({
              ok: true,
              status: null,
              error: null,
              elapsedMs: 12,
            }),
          );
        }),
    );
    monitorTelegramProvider.mockResolvedValue(undefined);

    const first = startTelegramAccount("alpha");
    const second = startTelegramAccount("bravo");
    const abortQueued = new AbortController();
    const queued = startTelegramAccount("charlie", {}, abortQueued.signal);

    await waitForCondition(
      () => probeTelegram.mock.calls.length === 2,
      "expected startup probe slots to fill",
    );
    abortQueued.abort();
    await expect(queued.task).resolves.toBeUndefined();

    for (const release of releaseProbe.splice(0)) {
      release();
    }
    await Promise.all([first.task, second.task]);
    expect(probeTelegram).toHaveBeenCalledTimes(2);
    expect(monitorTelegramProvider).toHaveBeenCalledTimes(2);
  });

  it("releases a stopped stale polling lease for the account token", async () => {
    vi.useFakeTimers();
    try {
      const cfg = createTelegramConfig();
      const account = telegramPlugin.config.resolveAccount(cfg, "default");
      const stopAccount = telegramPlugin.gateway?.stopAccount;
      if (!stopAccount) {
        throw new Error("expected Telegram stopAccount gateway handler");
      }

      const abort = new AbortController();
      await acquireTelegramPollingLease({
        token: "123456:bad-token",
        accountId: "default",
        abortSignal: abort.signal,
      });
      abort.abort();

      const stop = stopAccount(
        createStartAccountContext({
          account,
          abortSignal: abort.signal,
          cfg,
        }),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await stop;

      const next = await acquireTelegramPollingLease({
        token: "123456:bad-token",
        accountId: "default",
      });
      next.release();
    } finally {
      vi.useRealTimers();
    }
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
