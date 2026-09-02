// Telegram tests cover channel.gateway plugin behavior.
import path from "node:path";
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
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
let testState: OpenClawTestState;

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

function installTelegramRuntime() {
  const runtime = createPluginRuntimeMock({
    state: {
      openKeyedStore: <T>(options: Parameters<TelegramRuntime["state"]["openKeyedStore"]>[0]) =>
        createPluginStateKeyedStoreForTests<T>("telegram", { ...options, env: testState.env }),
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
  ownerAgentId?: string;
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

beforeEach(async () => {
  vi.useRealTimers();
  resetPluginStateStoreForTests();
  testState = await createOpenClawTestState({ label: "telegram-channel" });
});

afterEach(async () => {
  vi.useRealTimers();
  clearTelegramRuntime();
  resetTelegramPollingLeasesForTests();
  probeTelegram.mockReset();
  monitorTelegramProvider.mockReset();
  sendMessageTelegram.mockReset();
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
  await testState.cleanup();
});

describe("telegramPlugin gateway startup", () => {
  it.each([401, 404] as const)(
    "stops before monitor startup when getMe rejects the token with %s",
    async (status) => {
      installTelegramRuntime();
      probeTelegram.mockResolvedValue({
        ok: false,
        status,
        error: "Unauthorized",
        elapsedMs: 12,
      });

      const { ctx, task } = startTelegramAccount("ops");

      await expect(task).rejects.toThrow(
        `Telegram bot token unauthorized for account "ops" (getMe returned ${status}`,
      );
      await expect(task).rejects.toThrow("channels.telegram.accounts.ops.botToken/tokenFile");
      expect(monitorTelegramProvider).not.toHaveBeenCalled();
      expect(ctx.log?.error).toHaveBeenCalledWith(
        `[ops] Telegram bot token unauthorized for account "ops" (getMe returned ${status} from Telegram; source: config token). Update channels.telegram.accounts.ops.botToken/tokenFile with the current BotFather token.`,
      );
      expect(ctx.getStatus()).toMatchObject({
        lifecycle: "blocked",
        terminalDisconnect: true,
        lastError: expect.stringContaining(`getMe returned ${status}`),
      });
    },
  );

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

  it("starts a multi-agent account with its routed owner", async () => {
    installTelegramRuntime();
    probeTelegram.mockResolvedValue({
      ok: false,
      status: 500,
      error: "Bad Gateway",
      elapsedMs: 12,
    });
    monitorTelegramProvider.mockResolvedValue(undefined);
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, ops: {}, research: {} },
      },
      channels: { telegram: { botToken: "123456:bad-token" } },
      bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "*" } }],
    } as OpenClawConfig;
    const account = telegramPlugin.config.resolveAccount(cfg, "default");
    const startAccount = telegramPlugin.gateway?.startAccount;
    if (!startAccount) {
      throw new Error("expected Telegram startAccount gateway handler");
    }

    await startAccount(createStartAccountContext({ account, cfg }));

    expect(latestMonitorOptions()).toMatchObject({
      accountId: "default",
      ownerAgentId: "main",
    });
  });

  it("rejects genuinely ambiguous multi-agent account ownership before startup", async () => {
    installTelegramRuntime();
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, ops: {}, research: {} },
      },
      channels: { telegram: { botToken: "123456:bad-token" } },
    } as OpenClawConfig;
    const account = telegramPlugin.config.resolveAccount(cfg, "default");
    const startAccount = telegramPlugin.gateway?.startAccount;
    if (!startAccount) {
      throw new Error("expected Telegram startAccount gateway handler");
    }

    await expect(startAccount(createStartAccountContext({ account, cfg }))).rejects.toMatchObject({
      name: "AgentSelectionRequiredError",
      code: "AGENT_SELECTION_REQUIRED",
    });
    expect(probeTelegram).not.toHaveBeenCalled();
    expect(monitorTelegramProvider).not.toHaveBeenCalled();
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
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const runtime = installTelegramRuntime();
    const cfg = createTelegramConfig("ops");
    const original = structuredClone(cfg);
    const account = telegramPlugin.config.resolveAccount(cfg, "ops");
    await writeCachedTelegramBotInfo({
      accountId: "ops",
      botToken: "123456:bad-token",
      botInfo: startupBotInfo,
    });

    const result = await telegramPlugin.gateway?.logoutAccount?.({
      accountId: "ops",
      account,
      cfg,
      runtime: createRuntimeEnvMock(),
    });

    expect(result).toEqual({ cleared: true, envToken: false, loggedOut: true });
    expect(runtime.config.replaceConfigFile).toHaveBeenCalledExactlyOnceWith({
      nextConfig: {},
      afterWrite: { mode: "auto" },
    });
    expect(cfg).toEqual(original);
    await expect(
      readCachedTelegramBotInfo({
        accountId: "ops",
        botToken: "123456:bad-token",
      }),
    ).resolves.toBeNull();
  });

  it("preserves token files and sibling config when logout clears an inline token", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const stateDir = testState.stateDir;
    const runtime = installTelegramRuntime();
    const remaining = { tokenFile: path.join(stateDir, "missing-token"), name: "Ops" };
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          botToken: "root-token",
          accounts: { ops: { ...remaining, botToken: "remove" }, other: { botToken: "keep" } },
        },
        line: { enabled: false },
      },
    };
    const original = structuredClone(cfg);
    const result = await telegramPlugin.gateway?.logoutAccount?.({
      accountId: "ops",
      account: telegramPlugin.config.resolveAccount(cfg, "ops"),
      cfg,
      runtime: createRuntimeEnvMock(),
    });

    expect(result).toEqual({ cleared: true, envToken: false, loggedOut: false });
    expect(runtime.config.replaceConfigFile).toHaveBeenCalledExactlyOnceWith({
      nextConfig: {
        channels: {
          telegram: {
            botToken: "root-token",
            accounts: { ops: remaining, other: { botToken: "keep" } },
          },
          line: { enabled: false },
        },
      },
      afterWrite: { mode: "auto" },
    });
    expect(cfg).toEqual(original);
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
