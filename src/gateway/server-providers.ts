import type { ClawdbotConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { createSubsystemLogger } from "../logging.js";
import {
  getProviderPlugin,
  listProviderPlugins,
  type ProviderId,
} from "../providers/plugins/index.js";
import type { ProviderAccountSnapshot } from "../providers/plugins/types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveDefaultWhatsAppAccountId } from "../web/accounts.js";

export type ProviderRuntimeSnapshot = {
  [K in ProviderId]?: ProviderAccountSnapshot;
} & {
  [K in `${ProviderId}Accounts`]?: Record<string, ProviderAccountSnapshot>;
};

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

type ProviderRuntimeStore = {
  aborts: Map<string, AbortController>;
  tasks: Map<string, Promise<unknown>>;
  runtimes: Map<string, ProviderAccountSnapshot>;
};

const DEFAULT_RUNTIME: Record<ProviderId, ProviderAccountSnapshot> = {
  whatsapp: {
    accountId: DEFAULT_ACCOUNT_ID,
    running: false,
    connected: false,
    reconnectAttempts: 0,
    lastConnectedAt: null,
    lastDisconnect: null,
    lastMessageAt: null,
    lastEventAt: null,
    lastError: null,
  },
  telegram: {
    accountId: DEFAULT_ACCOUNT_ID,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  },
  discord: {
    accountId: DEFAULT_ACCOUNT_ID,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  },
  slack: {
    accountId: DEFAULT_ACCOUNT_ID,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  },
  signal: {
    accountId: DEFAULT_ACCOUNT_ID,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  },
  imessage: {
    accountId: DEFAULT_ACCOUNT_ID,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    cliPath: null,
    dbPath: null,
  },
  msteams: {
    accountId: DEFAULT_ACCOUNT_ID,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    port: null,
  },
};

function createRuntimeStore(): ProviderRuntimeStore {
  return {
    aborts: new Map(),
    tasks: new Map(),
    runtimes: new Map(),
  };
}

function isAccountEnabled(account: unknown): boolean {
  if (!account || typeof account !== "object") return true;
  const enabled = (account as { enabled?: boolean }).enabled;
  return enabled !== false;
}

function cloneDefaultRuntime(
  providerId: ProviderId,
  accountId: string,
): ProviderAccountSnapshot {
  return { ...DEFAULT_RUNTIME[providerId], accountId };
}

type ProviderManagerOptions = {
  loadConfig: () => ClawdbotConfig;
  logWhatsApp: SubsystemLogger;
  logTelegram: SubsystemLogger;
  logDiscord: SubsystemLogger;
  logSlack: SubsystemLogger;
  logSignal: SubsystemLogger;
  logIMessage: SubsystemLogger;
  logMSTeams: SubsystemLogger;
  whatsappRuntimeEnv: RuntimeEnv;
  telegramRuntimeEnv: RuntimeEnv;
  discordRuntimeEnv: RuntimeEnv;
  slackRuntimeEnv: RuntimeEnv;
  signalRuntimeEnv: RuntimeEnv;
  imessageRuntimeEnv: RuntimeEnv;
  msteamsRuntimeEnv: RuntimeEnv;
};

export type ProviderManager = {
  getRuntimeSnapshot: () => ProviderRuntimeSnapshot;
  startProviders: () => Promise<void>;
  startProvider: (provider: ProviderId, accountId?: string) => Promise<void>;
  stopProvider: (provider: ProviderId, accountId?: string) => Promise<void>;
  startWhatsAppProvider: (accountId?: string) => Promise<void>;
  stopWhatsAppProvider: (accountId?: string) => Promise<void>;
  startTelegramProvider: (accountId?: string) => Promise<void>;
  stopTelegramProvider: (accountId?: string) => Promise<void>;
  startDiscordProvider: (accountId?: string) => Promise<void>;
  stopDiscordProvider: (accountId?: string) => Promise<void>;
  startSlackProvider: (accountId?: string) => Promise<void>;
  stopSlackProvider: (accountId?: string) => Promise<void>;
  startSignalProvider: (accountId?: string) => Promise<void>;
  stopSignalProvider: (accountId?: string) => Promise<void>;
  startIMessageProvider: (accountId?: string) => Promise<void>;
  stopIMessageProvider: (accountId?: string) => Promise<void>;
  startMSTeamsProvider: () => Promise<void>;
  stopMSTeamsProvider: () => Promise<void>;
  markWhatsAppLoggedOut: (cleared: boolean, accountId?: string) => void;
};

export function createProviderManager(
  opts: ProviderManagerOptions,
): ProviderManager {
  const {
    loadConfig,
    logWhatsApp,
    logTelegram,
    logDiscord,
    logSlack,
    logSignal,
    logIMessage,
    logMSTeams,
    whatsappRuntimeEnv,
    telegramRuntimeEnv,
    discordRuntimeEnv,
    slackRuntimeEnv,
    signalRuntimeEnv,
    imessageRuntimeEnv,
    msteamsRuntimeEnv,
  } = opts;

  const providerStores = new Map<ProviderId, ProviderRuntimeStore>();
  const providerLogs: Record<ProviderId, SubsystemLogger> = {
    whatsapp: logWhatsApp,
    telegram: logTelegram,
    discord: logDiscord,
    slack: logSlack,
    signal: logSignal,
    imessage: logIMessage,
    msteams: logMSTeams,
  };
  const providerRuntimeEnvs: Record<ProviderId, RuntimeEnv> = {
    whatsapp: whatsappRuntimeEnv,
    telegram: telegramRuntimeEnv,
    discord: discordRuntimeEnv,
    slack: slackRuntimeEnv,
    signal: signalRuntimeEnv,
    imessage: imessageRuntimeEnv,
    msteams: msteamsRuntimeEnv,
  };

  const getStore = (providerId: ProviderId): ProviderRuntimeStore => {
    const existing = providerStores.get(providerId);
    if (existing) return existing;
    const next = createRuntimeStore();
    providerStores.set(providerId, next);
    return next;
  };

  const getRuntime = (
    providerId: ProviderId,
    accountId: string,
  ): ProviderAccountSnapshot => {
    const store = getStore(providerId);
    return (
      store.runtimes.get(accountId) ??
      cloneDefaultRuntime(providerId, accountId)
    );
  };

  const setRuntime = (
    providerId: ProviderId,
    accountId: string,
    patch: ProviderAccountSnapshot,
  ): ProviderAccountSnapshot => {
    const store = getStore(providerId);
    const current = getRuntime(providerId, accountId);
    const next = { ...current, ...patch, accountId };
    store.runtimes.set(accountId, next);
    return next;
  };

  const startProvider = async (providerId: ProviderId, accountId?: string) => {
    const plugin = getProviderPlugin(providerId);
    const startAccount = plugin?.gateway?.startAccount;
    if (!startAccount) return;
    const cfg = loadConfig();
    const store = getStore(providerId);
    const accountIds = accountId
      ? [accountId]
      : plugin.config.listAccountIds(cfg);
    if (accountIds.length === 0) return;

    await Promise.all(
      accountIds.map(async (id) => {
        if (store.tasks.has(id)) return;
        const account = plugin.config.resolveAccount(cfg, id);
        const enabled =
          isAccountEnabled(account) &&
          !(providerId === "whatsapp" && cfg.web?.enabled === false);
        if (!enabled) {
          setRuntime(providerId, id, {
            accountId: id,
            running: false,
            lastError: "disabled",
          });
          return;
        }

        let configured = true;
        if (plugin.config.isConfigured) {
          configured = await plugin.config.isConfigured(account, cfg);
        }
        if (!configured) {
          setRuntime(providerId, id, {
            accountId: id,
            running: false,
            lastError:
              providerId === "whatsapp" ? "not linked" : "not configured",
          });
          return;
        }

        const abort = new AbortController();
        store.aborts.set(id, abort);
        setRuntime(providerId, id, {
          accountId: id,
          running: true,
          lastStartAt: Date.now(),
          lastError: null,
        });

        const log = providerLogs[providerId];
        const task = startAccount({
          cfg,
          accountId: id,
          account,
          runtime: providerRuntimeEnvs[providerId],
          abortSignal: abort.signal,
          log,
          getStatus: () => getRuntime(providerId, id),
          setStatus: (next) => setRuntime(providerId, id, next),
        });
        const tracked = Promise.resolve(task)
          .catch((err) => {
            const message = formatErrorMessage(err);
            setRuntime(providerId, id, { accountId: id, lastError: message });
            log.error?.(`[${id}] provider exited: ${message}`);
          })
          .finally(() => {
            store.aborts.delete(id);
            store.tasks.delete(id);
            setRuntime(providerId, id, {
              accountId: id,
              running: false,
              lastStopAt: Date.now(),
            });
          });
        store.tasks.set(id, tracked);
      }),
    );
  };

  const stopProvider = async (providerId: ProviderId, accountId?: string) => {
    const plugin = getProviderPlugin(providerId);
    const cfg = loadConfig();
    const store = getStore(providerId);
    const knownIds = new Set<string>([
      ...store.aborts.keys(),
      ...store.tasks.keys(),
      ...(plugin ? plugin.config.listAccountIds(cfg) : []),
    ]);
    if (accountId) {
      knownIds.clear();
      knownIds.add(accountId);
    }

    await Promise.all(
      Array.from(knownIds.values()).map(async (id) => {
        const abort = store.aborts.get(id);
        const task = store.tasks.get(id);
        if (!abort && !task && !plugin?.gateway?.stopAccount) return;
        abort?.abort();
        if (plugin?.gateway?.stopAccount) {
          const account = plugin.config.resolveAccount(cfg, id);
          await plugin.gateway.stopAccount({
            cfg,
            accountId: id,
            account,
            runtime: providerRuntimeEnvs[providerId],
            abortSignal: abort?.signal ?? new AbortController().signal,
            log: providerLogs[providerId],
            getStatus: () => getRuntime(providerId, id),
            setStatus: (next) => setRuntime(providerId, id, next),
          });
        }
        try {
          await task;
        } catch {
          // ignore
        }
        store.aborts.delete(id);
        store.tasks.delete(id);
        setRuntime(providerId, id, {
          accountId: id,
          running: false,
          lastStopAt: Date.now(),
        });
      }),
    );
  };

  const startProviders = async () => {
    for (const plugin of listProviderPlugins()) {
      await startProvider(plugin.id);
    }
  };

  const markWhatsAppLoggedOut = (cleared: boolean, accountId?: string) => {
    const cfg = loadConfig();
    const resolvedId = accountId ?? resolveDefaultWhatsAppAccountId(cfg);
    const current = getRuntime("whatsapp", resolvedId);
    setRuntime("whatsapp", resolvedId, {
      accountId: resolvedId,
      running: false,
      connected: false,
      lastError: cleared ? "logged out" : current.lastError,
    });
  };

  const getRuntimeSnapshot = (): ProviderRuntimeSnapshot => {
    const cfg = loadConfig();
    const snapshot: ProviderRuntimeSnapshot = {};
    for (const plugin of listProviderPlugins()) {
      const store = getStore(plugin.id);
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId =
        plugin.config.defaultAccountId?.(cfg) ??
        accountIds[0] ??
        DEFAULT_ACCOUNT_ID;
      const accounts: Record<string, ProviderAccountSnapshot> = {};
      for (const id of accountIds) {
        const account = plugin.config.resolveAccount(cfg, id);
        const enabled =
          isAccountEnabled(account) &&
          !(plugin.id === "whatsapp" && cfg.web?.enabled === false);
        const described = plugin.config.describeAccount?.(account, cfg);
        const configured = described?.configured;
        const current =
          store.runtimes.get(id) ?? cloneDefaultRuntime(plugin.id, id);
        const next = { ...current, accountId: id };
        if (!next.running) {
          if (!enabled) next.lastError ??= "disabled";
          else if (configured === false) next.lastError ??= "not configured";
        }
        accounts[id] = next;
      }
      const defaultAccount =
        accounts[defaultAccountId] ??
        cloneDefaultRuntime(plugin.id, defaultAccountId);
      (snapshot as Record<string, unknown>)[plugin.id] = defaultAccount;
      (snapshot as Record<string, unknown>)[`${plugin.id}Accounts`] = accounts;
    }
    return snapshot;
  };

  return {
    getRuntimeSnapshot,
    startProviders,
    startProvider,
    stopProvider,
    startWhatsAppProvider: (accountId?: string) =>
      startProvider("whatsapp", accountId),
    stopWhatsAppProvider: (accountId?: string) =>
      stopProvider("whatsapp", accountId),
    startTelegramProvider: (accountId?: string) =>
      startProvider("telegram", accountId),
    stopTelegramProvider: (accountId?: string) =>
      stopProvider("telegram", accountId),
    startDiscordProvider: (accountId?: string) =>
      startProvider("discord", accountId),
    stopDiscordProvider: (accountId?: string) =>
      stopProvider("discord", accountId),
    startSlackProvider: (accountId?: string) =>
      startProvider("slack", accountId),
    stopSlackProvider: (accountId?: string) => stopProvider("slack", accountId),
    startSignalProvider: (accountId?: string) =>
      startProvider("signal", accountId),
    stopSignalProvider: (accountId?: string) =>
      stopProvider("signal", accountId),
    startIMessageProvider: (accountId?: string) =>
      startProvider("imessage", accountId),
    stopIMessageProvider: (accountId?: string) =>
      stopProvider("imessage", accountId),
    startMSTeamsProvider: () => startProvider("msteams"),
    stopMSTeamsProvider: () => stopProvider("msteams"),
    markWhatsAppLoggedOut,
  };
}
