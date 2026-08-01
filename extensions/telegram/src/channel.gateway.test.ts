// Telegram tests cover channel.gateway plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCachedTelegramBotInfo, writeCachedTelegramBotInfo } from "./bot-info-cache.js";
import type { TelegramBotInfo } from "./bot-info.js";
import { telegramPlugin } from "./channel.js";
import type { TelegramMonitorFn } from "./monitor.types.js";
import { acquireTelegramPollingLease } from "./polling-lease.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest as clearTelegramRuntime,
  resetTelegramPollingLeasesForTest as resetTelegramPollingLeasesForTests,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import { withTelegramStartupProbeSlot } from "./startup-probe-limiter.js";

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
  supports_join_request_queries: false,
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

type MemoryPluginStateEntry<T> = { key: string; value: T; createdAt: number; expiresAt?: number };

function createMemoryPluginStateStore<T>(
  maxEntries: number,
  defaultTtlMs: number | undefined,
  entries: Map<string, MemoryPluginStateEntry<unknown>>,
) {
  type Entry = { key: string; value: T; createdAt: number; expiresAt?: number };
  const typedEntries = entries as Map<string, Entry>;
  const readEntry = (key: string): Entry | undefined => {
    const entry = typedEntries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      typedEntries.delete(key);
      return undefined;
    }
    return entry;
  };
  const writeEntry = (key: string, value: T, opts?: { ttlMs?: number }): void => {
    const createdAt = Date.now();
    const entry: Entry = { key, value, createdAt };
    const ttlMs = opts?.ttlMs ?? defaultTtlMs;
    if (ttlMs !== undefined) {
      entry.expiresAt = createdAt + ttlMs;
    }
    typedEntries.set(key, entry);
    while (typedEntries.size > maxEntries) {
      const oldestKey = typedEntries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      typedEntries.delete(oldestKey);
    }
  };
  return {
    async register(key: string, value: T, opts?: { ttlMs?: number }) {
      writeEntry(key, value, opts);
    },
    async registerIfAbsent(key: string, value: T, opts?: { ttlMs?: number }) {
      if (readEntry(key)) {
        return false;
      }
      writeEntry(key, value, opts);
      return true;
    },
    async lookup(key: string) {
      return readEntry(key)?.value;
    },
    async consume(key: string) {
      const value = readEntry(key)?.value;
      typedEntries.delete(key);
      return value;
    },
    async delete(key: string) {
      return typedEntries.delete(key);
    },
    async entries() {
      return [...typedEntries.keys()]
        .map((key) => readEntry(key))
        .filter((entry): entry is Entry => Boolean(entry));
    },
    async clear() {
      typedEntries.clear();
    },
  };
}

function installTelegramRuntime() {
  const keyedStores = new Map<string, Map<string, MemoryPluginStateEntry<unknown>>>();
  const runtime = createPluginRuntimeMock({
    state: {
      openKeyedStore: ((options) => {
        let entries = keyedStores.get(options.namespace);
        if (!entries) {
          entries = new Map();
          keyedStores.set(options.namespace, entries);
        }
        return createMemoryPluginStateStore(options.maxEntries, options.defaultTtlMs, entries);
      }) as TelegramRuntime["state"]["openKeyedStore"],
    },
  });
  const telegramRuntime = {
    ...runtime,
    channel: {
      ...runtime.channel,
      telegram: {
        probeTelegram: probeTelegram as NonNullable<
          NonNullable<TelegramRuntime["channel"]["telegram"]>["probeTelegram"]
        >,
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
async function waitForMicrotaskCondition(check: () => boolean, message: string, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(message);
}

async function releaseStartupProbeControls(releaseProbe: Array<() => void>) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const releases = releaseProbe.splice(0);
    for (const release of releases) {
      release();
    }
    await Promise.resolve();
    if (releaseProbe.length === 0) {
      return;
    }
  }
  for (const release of releaseProbe.splice(0)) {
    release();
  }
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  clearTelegramRuntime();
  resetTelegramPollingLeasesForTests();
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

    const { ctx, task } = startTelegramAccount();

    await expect(task).resolves.toBeUndefined();
    expect(probeTelegram).toHaveBeenCalledWith("123456:bad-token", 15_000, {
      abortSignal: ctx.abortSignal,
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

  it("refreshes cached startup botInfo before monitor startup", async () => {
    await useTempStateDir();
    installTelegramRuntime();
    const refreshedBotInfo = {
      ...startupBotInfo,
      username: "fresh_openclaw_bot",
      has_topics_enabled: true,
    };
    await writeCachedTelegramBotInfo({
      accountId: "ops",
      botToken: "123456:bad-token",
      botInfo: startupBotInfo,
    });
    probeTelegram.mockResolvedValue({
      ok: true,
      status: null,
      error: null,
      elapsedMs: 12,
      bot: {
        id: refreshedBotInfo.id,
        username: refreshedBotInfo.username,
      },
      botInfo: refreshedBotInfo,
    });
    monitorTelegramProvider.mockResolvedValue(undefined);

    const { task } = startTelegramAccount("ops");

    await expect(task).resolves.toBeUndefined();
    expect(probeTelegram).toHaveBeenCalledOnce();
    expect(latestMonitorOptions().botInfo).toEqual(refreshedBotInfo);
    await expect(
      readCachedTelegramBotInfo({
        accountId: "ops",
        botToken: "123456:bad-token",
      }),
    ).resolves.toMatchObject({ botInfo: refreshedBotInfo });
  });

  it("falls back to cached startup botInfo when refresh fails without auth failure", async () => {
    await useTempStateDir();
    installTelegramRuntime();
    await writeCachedTelegramBotInfo({
      accountId: "ops",
      botToken: "123456:bad-token",
      botInfo: startupBotInfo,
    });
    probeTelegram.mockResolvedValue({
      ok: false,
      status: 500,
      error: "Bad Gateway",
      elapsedMs: 12,
    });
    monitorTelegramProvider.mockResolvedValue(undefined);

    const { task } = startTelegramAccount("ops");

    await expect(task).resolves.toBeUndefined();
    expect(probeTelegram).toHaveBeenCalledOnce();
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

  it("uses the built-in startup probe timeout", async () => {
    installTelegramRuntime();
    probeTelegram.mockResolvedValue({
      ok: true,
      status: null,
      error: null,
      elapsedMs: 12,
    });
    monitorTelegramProvider.mockResolvedValue(undefined);

    const { ctx, task } = startTelegramAccount("ops", { timeoutSeconds: 60 });

    await expect(task).resolves.toBeUndefined();
    expect(probeTelegram).toHaveBeenCalledWith("123456:bad-token", 15_000, {
      abortSignal: ctx.abortSignal,
      accountId: "ops",
      proxyUrl: undefined,
      network: undefined,
      apiRoot: undefined,
      includeWebhookInfo: false,
    });
  });

  it("limits concurrent startup probes across Telegram accounts", async () => {
    const releaseProbe: Array<() => void> = [];
    let activeProbes = 0;
    let maxActiveProbes = 0;
    const runProbe = async () =>
      await withTelegramStartupProbeSlot(undefined, async () => {
        activeProbes += 1;
        maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
        await new Promise<void>((resolve) => {
          releaseProbe.push(resolve);
        });
        activeProbes -= 1;
      });

    const first = runProbe();
    const second = runProbe();
    const third = runProbe();
    const tasks = [first, second, third];
    try {
      await waitForMicrotaskCondition(
        () => releaseProbe.length === 2,
        "expected two startup probes to begin",
      );
      expect(maxActiveProbes).toBe(2);

      releaseProbe.shift()?.();
      await waitForMicrotaskCondition(
        () => releaseProbe.length === 2,
        "expected queued startup probe to begin after a slot opens",
      );
      expect(maxActiveProbes).toBe(2);
    } finally {
      await releaseStartupProbeControls(releaseProbe);
    }
    await Promise.all(tasks);
  });

  it("abandons a queued startup probe when the account aborts", async () => {
    const releaseProbe: Array<() => void> = [];
    let startedProbes = 0;
    const runProbe = async (abortSignal?: AbortSignal) =>
      await withTelegramStartupProbeSlot(abortSignal, async () => {
        startedProbes += 1;
        if (startedProbes <= 2) {
          await new Promise<void>((resolve) => {
            releaseProbe.push(resolve);
          });
        }
      });

    const first = runProbe();
    const second = runProbe();
    const abortQueued = new AbortController();
    const queued = runProbe(abortQueued.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await waitForMicrotaskCondition(
        () => releaseProbe.length === 2,
        "expected startup probe slots to fill",
      );
      abortQueued.abort();
    } finally {
      abortQueued.abort();
      await releaseStartupProbeControls(releaseProbe);
    }
    await Promise.all([first, second]);
    await expect(queued).resolves.toMatchObject({
      message: "telegram startup probe wait aborted",
    });
    expect(startedProbes).toBe(2);
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
