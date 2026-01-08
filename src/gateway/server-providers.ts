import type { ClawdbotConfig } from "../config/config.js";
import {
  listDiscordAccountIds,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
} from "../discord/accounts.js";
import { monitorDiscordProvider } from "../discord/index.js";
import { probeDiscord } from "../discord/probe.js";
import { shouldLogVerbose } from "../globals.js";
import {
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
} from "../imessage/accounts.js";
import { monitorIMessageProvider } from "../imessage/index.js";
import type { createSubsystemLogger } from "../logging.js";
import { monitorWebProvider, webAuthExists } from "../providers/web/index.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "../signal/accounts.js";
import { monitorSignalProvider } from "../signal/index.js";
import {
  listSlackAccountIds,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
} from "../slack/accounts.js";
import { monitorSlackProvider } from "../slack/index.js";
import {
  listTelegramAccountIds,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
} from "../telegram/accounts.js";
import { monitorTelegramProvider } from "../telegram/monitor.js";
import { probeTelegram } from "../telegram/probe.js";
import {
  listEnabledWhatsAppAccounts,
  resolveDefaultWhatsAppAccountId,
} from "../web/accounts.js";
import type { WebProviderStatus } from "../web/auto-reply.js";
import { readWebSelfId } from "../web/session.js";
import { formatError } from "./server-utils.js";

export type TelegramRuntimeStatus = {
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  mode?: "webhook" | "polling" | null;
};

export type DiscordRuntimeStatus = {
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
};

export type SlackRuntimeStatus = {
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
};

export type SignalRuntimeStatus = {
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  baseUrl?: string | null;
};

export type IMessageRuntimeStatus = {
  running: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  cliPath?: string | null;
  dbPath?: string | null;
};

export type ProviderRuntimeSnapshot = {
  whatsapp: WebProviderStatus;
  whatsappAccounts?: Record<string, WebProviderStatus>;
  telegram: TelegramRuntimeStatus;
  telegramAccounts?: Record<string, TelegramRuntimeStatus>;
  discord: DiscordRuntimeStatus;
  discordAccounts?: Record<string, DiscordRuntimeStatus>;
  slack: SlackRuntimeStatus;
  slackAccounts?: Record<string, SlackRuntimeStatus>;
  signal: SignalRuntimeStatus;
  signalAccounts?: Record<string, SignalRuntimeStatus>;
  imessage: IMessageRuntimeStatus;
  imessageAccounts?: Record<string, IMessageRuntimeStatus>;
};

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

type ProviderManagerOptions = {
  loadConfig: () => ClawdbotConfig;
  logWhatsApp: SubsystemLogger;
  logTelegram: SubsystemLogger;
  logDiscord: SubsystemLogger;
  logSlack: SubsystemLogger;
  logSignal: SubsystemLogger;
  logIMessage: SubsystemLogger;
  whatsappRuntimeEnv: RuntimeEnv;
  telegramRuntimeEnv: RuntimeEnv;
  discordRuntimeEnv: RuntimeEnv;
  slackRuntimeEnv: RuntimeEnv;
  signalRuntimeEnv: RuntimeEnv;
  imessageRuntimeEnv: RuntimeEnv;
};

export type ProviderManager = {
  getRuntimeSnapshot: () => ProviderRuntimeSnapshot;
  startProviders: () => Promise<void>;
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
    whatsappRuntimeEnv,
    telegramRuntimeEnv,
    discordRuntimeEnv,
    slackRuntimeEnv,
    signalRuntimeEnv,
    imessageRuntimeEnv,
  } = opts;

  const whatsappAborts = new Map<string, AbortController>();
  const telegramAborts = new Map<string, AbortController>();
  const discordAborts = new Map<string, AbortController>();
  const slackAborts = new Map<string, AbortController>();
  const signalAborts = new Map<string, AbortController>();
  const imessageAborts = new Map<string, AbortController>();
  const whatsappTasks = new Map<string, Promise<unknown>>();
  const telegramTasks = new Map<string, Promise<unknown>>();
  const discordTasks = new Map<string, Promise<unknown>>();
  const slackTasks = new Map<string, Promise<unknown>>();
  const signalTasks = new Map<string, Promise<unknown>>();
  const imessageTasks = new Map<string, Promise<unknown>>();

  const whatsappRuntimes = new Map<string, WebProviderStatus>();
  const defaultWhatsAppStatus = (): WebProviderStatus => ({
    running: false,
    connected: false,
    reconnectAttempts: 0,
    lastConnectedAt: null,
    lastDisconnect: null,
    lastMessageAt: null,
    lastEventAt: null,
    lastError: null,
  });
  const telegramRuntimes = new Map<string, TelegramRuntimeStatus>();
  const discordRuntimes = new Map<string, DiscordRuntimeStatus>();
  const slackRuntimes = new Map<string, SlackRuntimeStatus>();
  const signalRuntimes = new Map<string, SignalRuntimeStatus>();
  const imessageRuntimes = new Map<string, IMessageRuntimeStatus>();

  const defaultTelegramStatus = (): TelegramRuntimeStatus => ({
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    mode: null,
  });
  const defaultDiscordStatus = (): DiscordRuntimeStatus => ({
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  });
  const defaultSlackStatus = (): SlackRuntimeStatus => ({
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  });
  const defaultSignalStatus = (): SignalRuntimeStatus => ({
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    baseUrl: null,
  });
  const defaultIMessageStatus = (): IMessageRuntimeStatus => ({
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    cliPath: null,
    dbPath: null,
  });

  const updateWhatsAppStatus = (accountId: string, next: WebProviderStatus) => {
    whatsappRuntimes.set(accountId, next);
  };

  const startWhatsAppProvider = async (accountId?: string) => {
    const cfg = loadConfig();
    const enabledAccounts = listEnabledWhatsAppAccounts(cfg);
    const targets = accountId
      ? enabledAccounts.filter((a) => a.accountId === accountId)
      : enabledAccounts;
    if (targets.length === 0) return;

    if (cfg.web?.enabled === false) {
      for (const account of targets) {
        const current =
          whatsappRuntimes.get(account.accountId) ?? defaultWhatsAppStatus();
        whatsappRuntimes.set(account.accountId, {
          ...current,
          running: false,
          connected: false,
          lastError: "disabled",
        });
      }
      logWhatsApp.info("skipping provider start (web.enabled=false)");
      return;
    }

    await Promise.all(
      targets.map(async (account) => {
        if (whatsappTasks.has(account.accountId)) return;
        const current =
          whatsappRuntimes.get(account.accountId) ?? defaultWhatsAppStatus();
        if (!(await webAuthExists(account.authDir))) {
          whatsappRuntimes.set(account.accountId, {
            ...current,
            running: false,
            connected: false,
            lastError: "not linked",
          });
          logWhatsApp.info(
            `[${account.accountId}] skipping provider start (no linked session)`,
          );
          return;
        }

        const { e164, jid } = readWebSelfId(account.authDir);
        const identity = e164 ? e164 : jid ? `jid ${jid}` : "unknown";
        logWhatsApp.info(
          `[${account.accountId}] starting provider (${identity})`,
        );
        const abort = new AbortController();
        whatsappAborts.set(account.accountId, abort);
        whatsappRuntimes.set(account.accountId, {
          ...current,
          running: true,
          connected: false,
          lastError: null,
        });

        const task = monitorWebProvider(
          shouldLogVerbose(),
          undefined,
          true,
          undefined,
          whatsappRuntimeEnv,
          abort.signal,
          {
            statusSink: (next) => updateWhatsAppStatus(account.accountId, next),
            accountId: account.accountId,
          },
        )
          .catch((err) => {
            const latest =
              whatsappRuntimes.get(account.accountId) ??
              defaultWhatsAppStatus();
            whatsappRuntimes.set(account.accountId, {
              ...latest,
              lastError: formatError(err),
            });
            logWhatsApp.error(
              `[${account.accountId}] provider exited: ${formatError(err)}`,
            );
          })
          .finally(() => {
            whatsappAborts.delete(account.accountId);
            whatsappTasks.delete(account.accountId);
            const latest =
              whatsappRuntimes.get(account.accountId) ??
              defaultWhatsAppStatus();
            whatsappRuntimes.set(account.accountId, {
              ...latest,
              running: false,
              connected: false,
            });
          });

        whatsappTasks.set(account.accountId, task);
      }),
    );
  };

  const stopWhatsAppProvider = async (accountId?: string) => {
    const ids = accountId
      ? [accountId]
      : Array.from(
          new Set([...whatsappAborts.keys(), ...whatsappTasks.keys()]),
        );
    await Promise.all(
      ids.map(async (id) => {
        const abort = whatsappAborts.get(id);
        const task = whatsappTasks.get(id);
        if (!abort && !task) return;
        abort?.abort();
        try {
          await task;
        } catch {
          // ignore
        }
        whatsappAborts.delete(id);
        whatsappTasks.delete(id);
        const latest = whatsappRuntimes.get(id) ?? defaultWhatsAppStatus();
        whatsappRuntimes.set(id, {
          ...latest,
          running: false,
          connected: false,
        });
      }),
    );
  };

  const startTelegramProvider = async (accountId?: string) => {
    const cfg = loadConfig();
    const accountIds = accountId ? [accountId] : listTelegramAccountIds(cfg);
    if (cfg.telegram?.enabled === false) {
      for (const id of accountIds) {
        const latest = telegramRuntimes.get(id) ?? defaultTelegramStatus();
        telegramRuntimes.set(id, {
          ...latest,
          running: false,
          lastError: "disabled",
        });
      }
      if (shouldLogVerbose()) {
        logTelegram.debug(
          "telegram provider disabled (telegram.enabled=false)",
        );
      }
      return;
    }

    await Promise.all(
      accountIds.map(async (id) => {
        const account = resolveTelegramAccount({ cfg, accountId: id });
        if (!account.enabled) {
          const latest =
            telegramRuntimes.get(account.accountId) ?? defaultTelegramStatus();
          telegramRuntimes.set(account.accountId, {
            ...latest,
            running: false,
            lastError: "disabled",
          });
          return;
        }
        if (telegramTasks.has(account.accountId)) return;
        const token = account.token.trim();
        if (!token) {
          const latest =
            telegramRuntimes.get(account.accountId) ?? defaultTelegramStatus();
          telegramRuntimes.set(account.accountId, {
            ...latest,
            running: false,
            lastError: "not configured",
          });
          if (shouldLogVerbose()) {
            logTelegram.debug(
              `[${account.accountId}] telegram provider not configured (no TELEGRAM_BOT_TOKEN)`,
            );
          }
          return;
        }

        let telegramBotLabel = "";
        try {
          const probe = await probeTelegram(token, 2500, account.config.proxy);
          const username = probe.ok ? probe.bot?.username?.trim() : null;
          if (username) telegramBotLabel = ` (@${username})`;
        } catch (err) {
          if (shouldLogVerbose()) {
            logTelegram.debug(
              `[${account.accountId}] bot probe failed: ${String(err)}`,
            );
          }
        }

        logTelegram.info(
          `[${account.accountId}] starting provider${telegramBotLabel}`,
        );
        const abort = new AbortController();
        telegramAborts.set(account.accountId, abort);
        const latest =
          telegramRuntimes.get(account.accountId) ?? defaultTelegramStatus();
        telegramRuntimes.set(account.accountId, {
          ...latest,
          running: true,
          lastStartAt: Date.now(),
          lastError: null,
          mode: account.config.webhookUrl ? "webhook" : "polling",
        });
        const task = monitorTelegramProvider({
          token,
          accountId: account.accountId,
          config: cfg,
          runtime: telegramRuntimeEnv,
          abortSignal: abort.signal,
          useWebhook: Boolean(account.config.webhookUrl),
          webhookUrl: account.config.webhookUrl,
          webhookSecret: account.config.webhookSecret,
          webhookPath: account.config.webhookPath,
        })
          .catch((err) => {
            const current =
              telegramRuntimes.get(account.accountId) ??
              defaultTelegramStatus();
            telegramRuntimes.set(account.accountId, {
              ...current,
              lastError: formatError(err),
            });
            logTelegram.error(
              `[${account.accountId}] provider exited: ${formatError(err)}`,
            );
          })
          .finally(() => {
            telegramAborts.delete(account.accountId);
            telegramTasks.delete(account.accountId);
            const current =
              telegramRuntimes.get(account.accountId) ??
              defaultTelegramStatus();
            telegramRuntimes.set(account.accountId, {
              ...current,
              running: false,
              lastStopAt: Date.now(),
            });
          });
        telegramTasks.set(account.accountId, task);
      }),
    );
  };

  const stopTelegramProvider = async (accountId?: string) => {
    const ids = accountId
      ? [accountId]
      : Array.from(
          new Set([...telegramAborts.keys(), ...telegramTasks.keys()]),
        );
    await Promise.all(
      ids.map(async (id) => {
        const abort = telegramAborts.get(id);
        const task = telegramTasks.get(id);
        if (!abort && !task) return;
        abort?.abort();
        try {
          await task;
        } catch {
          // ignore
        }
        telegramAborts.delete(id);
        telegramTasks.delete(id);
        const latest = telegramRuntimes.get(id) ?? defaultTelegramStatus();
        telegramRuntimes.set(id, {
          ...latest,
          running: false,
          lastStopAt: Date.now(),
        });
      }),
    );
  };

  const startDiscordProvider = async (accountId?: string) => {
    const cfg = loadConfig();
    const accountIds = accountId ? [accountId] : listDiscordAccountIds(cfg);
    if (cfg.discord?.enabled === false) {
      for (const id of accountIds) {
        const latest = discordRuntimes.get(id) ?? defaultDiscordStatus();
        discordRuntimes.set(id, {
          ...latest,
          running: false,
          lastError: "disabled",
        });
      }
      if (shouldLogVerbose()) {
        logDiscord.debug("discord provider disabled (discord.enabled=false)");
      }
      return;
    }

    await Promise.all(
      accountIds.map(async (id) => {
        const account = resolveDiscordAccount({ cfg, accountId: id });
        if (!account.enabled) {
          const latest =
            discordRuntimes.get(account.accountId) ?? defaultDiscordStatus();
          discordRuntimes.set(account.accountId, {
            ...latest,
            running: false,
            lastError: "disabled",
          });
          return;
        }
        if (discordTasks.has(account.accountId)) return;
        const token = account.token.trim();
        if (!token) {
          const latest =
            discordRuntimes.get(account.accountId) ?? defaultDiscordStatus();
          discordRuntimes.set(account.accountId, {
            ...latest,
            running: false,
            lastError: "not configured",
          });
          if (shouldLogVerbose()) {
            logDiscord.debug(
              `[${account.accountId}] discord provider not configured (no DISCORD_BOT_TOKEN)`,
            );
          }
          return;
        }
        let discordBotLabel = "";
        try {
          const probe = await probeDiscord(token, 2500);
          const username = probe.ok ? probe.bot?.username?.trim() : null;
          if (username) discordBotLabel = ` (@${username})`;
        } catch (err) {
          if (shouldLogVerbose()) {
            logDiscord.debug(
              `[${account.accountId}] bot probe failed: ${String(err)}`,
            );
          }
        }
        logDiscord.info(
          `[${account.accountId}] starting provider${discordBotLabel}`,
        );
        const abort = new AbortController();
        discordAborts.set(account.accountId, abort);
        const latest =
          discordRuntimes.get(account.accountId) ?? defaultDiscordStatus();
        discordRuntimes.set(account.accountId, {
          ...latest,
          running: true,
          lastStartAt: Date.now(),
          lastError: null,
        });
        const task = monitorDiscordProvider({
          token,
          accountId: account.accountId,
          config: cfg,
          runtime: discordRuntimeEnv,
          abortSignal: abort.signal,
          mediaMaxMb: account.config.mediaMaxMb,
          historyLimit: account.config.historyLimit,
        })
          .catch((err) => {
            const current =
              discordRuntimes.get(account.accountId) ?? defaultDiscordStatus();
            discordRuntimes.set(account.accountId, {
              ...current,
              lastError: formatError(err),
            });
            logDiscord.error(
              `[${account.accountId}] provider exited: ${formatError(err)}`,
            );
          })
          .finally(() => {
            discordAborts.delete(account.accountId);
            discordTasks.delete(account.accountId);
            const current =
              discordRuntimes.get(account.accountId) ?? defaultDiscordStatus();
            discordRuntimes.set(account.accountId, {
              ...current,
              running: false,
              lastStopAt: Date.now(),
            });
          });
        discordTasks.set(account.accountId, task);
      }),
    );
  };

  const stopDiscordProvider = async (accountId?: string) => {
    const ids = accountId
      ? [accountId]
      : Array.from(new Set([...discordAborts.keys(), ...discordTasks.keys()]));
    await Promise.all(
      ids.map(async (id) => {
        const abort = discordAborts.get(id);
        const task = discordTasks.get(id);
        if (!abort && !task) return;
        abort?.abort();
        try {
          await task;
        } catch {
          // ignore
        }
        discordAborts.delete(id);
        discordTasks.delete(id);
        const latest = discordRuntimes.get(id) ?? defaultDiscordStatus();
        discordRuntimes.set(id, {
          ...latest,
          running: false,
          lastStopAt: Date.now(),
        });
      }),
    );
  };

  const startSlackProvider = async (accountId?: string) => {
    const cfg = loadConfig();
    const accountIds = accountId ? [accountId] : listSlackAccountIds(cfg);
    if (cfg.slack?.enabled === false) {
      for (const id of accountIds) {
        const latest = slackRuntimes.get(id) ?? defaultSlackStatus();
        slackRuntimes.set(id, {
          ...latest,
          running: false,
          lastError: "disabled",
        });
      }
      if (shouldLogVerbose()) {
        logSlack.debug("slack provider disabled (slack.enabled=false)");
      }
      return;
    }

    await Promise.all(
      accountIds.map(async (id) => {
        const account = resolveSlackAccount({ cfg, accountId: id });
        if (!account.enabled) {
          const latest =
            slackRuntimes.get(account.accountId) ?? defaultSlackStatus();
          slackRuntimes.set(account.accountId, {
            ...latest,
            running: false,
            lastError: "disabled",
          });
          return;
        }
        if (slackTasks.has(account.accountId)) return;
        const botToken = account.botToken?.trim();
        const appToken = account.appToken?.trim();
        if (!botToken || !appToken) {
          const latest =
            slackRuntimes.get(account.accountId) ?? defaultSlackStatus();
          slackRuntimes.set(account.accountId, {
            ...latest,
            running: false,
            lastError: "not configured",
          });
          if (shouldLogVerbose()) {
            logSlack.debug(
              `[${account.accountId}] slack provider not configured (missing SLACK_BOT_TOKEN/SLACK_APP_TOKEN)`,
            );
          }
          return;
        }
        logSlack.info(`[${account.accountId}] starting provider`);
        const abort = new AbortController();
        slackAborts.set(account.accountId, abort);
        const latest =
          slackRuntimes.get(account.accountId) ?? defaultSlackStatus();
        slackRuntimes.set(account.accountId, {
          ...latest,
          running: true,
          lastStartAt: Date.now(),
          lastError: null,
        });
        const task = monitorSlackProvider({
          botToken,
          appToken,
          accountId: account.accountId,
          config: cfg,
          runtime: slackRuntimeEnv,
          abortSignal: abort.signal,
          mediaMaxMb: account.config.mediaMaxMb,
          slashCommand: account.config.slashCommand,
        })
          .catch((err) => {
            const current =
              slackRuntimes.get(account.accountId) ?? defaultSlackStatus();
            slackRuntimes.set(account.accountId, {
              ...current,
              lastError: formatError(err),
            });
            logSlack.error(
              `[${account.accountId}] provider exited: ${formatError(err)}`,
            );
          })
          .finally(() => {
            slackAborts.delete(account.accountId);
            slackTasks.delete(account.accountId);
            const current =
              slackRuntimes.get(account.accountId) ?? defaultSlackStatus();
            slackRuntimes.set(account.accountId, {
              ...current,
              running: false,
              lastStopAt: Date.now(),
            });
          });
        slackTasks.set(account.accountId, task);
      }),
    );
  };

  const stopSlackProvider = async (accountId?: string) => {
    const ids = accountId
      ? [accountId]
      : Array.from(new Set([...slackAborts.keys(), ...slackTasks.keys()]));
    await Promise.all(
      ids.map(async (id) => {
        const abort = slackAborts.get(id);
        const task = slackTasks.get(id);
        if (!abort && !task) return;
        abort?.abort();
        try {
          await task;
        } catch {
          // ignore
        }
        slackAborts.delete(id);
        slackTasks.delete(id);
        const latest = slackRuntimes.get(id) ?? defaultSlackStatus();
        slackRuntimes.set(id, {
          ...latest,
          running: false,
          lastStopAt: Date.now(),
        });
      }),
    );
  };

  const startSignalProvider = async (accountId?: string) => {
    const cfg = loadConfig();
    const accountIds = accountId ? [accountId] : listSignalAccountIds(cfg);
    if (!cfg.signal) {
      for (const id of accountIds) {
        const latest = signalRuntimes.get(id) ?? defaultSignalStatus();
        signalRuntimes.set(id, {
          ...latest,
          running: false,
          lastError: "not configured",
        });
      }
      if (shouldLogVerbose()) {
        logSignal.debug("signal provider not configured (no signal config)");
      }
      return;
    }

    await Promise.all(
      accountIds.map(async (id) => {
        const account = resolveSignalAccount({ cfg, accountId: id });
        if (!account.enabled) {
          const latest =
            signalRuntimes.get(account.accountId) ?? defaultSignalStatus();
          signalRuntimes.set(account.accountId, {
            ...latest,
            running: false,
            lastError: "disabled",
            baseUrl: account.baseUrl,
          });
          return;
        }
        if (!account.configured) {
          const latest =
            signalRuntimes.get(account.accountId) ?? defaultSignalStatus();
          signalRuntimes.set(account.accountId, {
            ...latest,
            running: false,
            lastError: "not configured",
            baseUrl: account.baseUrl,
          });
          if (shouldLogVerbose()) {
            logSignal.debug(
              `[${account.accountId}] signal provider not configured (missing signal config)`,
            );
          }
          return;
        }
        if (signalTasks.has(account.accountId)) return;
        logSignal.info(
          `[${account.accountId}] starting provider (${account.baseUrl})`,
        );
        const abort = new AbortController();
        signalAborts.set(account.accountId, abort);
        const latest =
          signalRuntimes.get(account.accountId) ?? defaultSignalStatus();
        signalRuntimes.set(account.accountId, {
          ...latest,
          running: true,
          lastStartAt: Date.now(),
          lastError: null,
          baseUrl: account.baseUrl,
        });
        const task = monitorSignalProvider({
          accountId: account.accountId,
          config: cfg,
          runtime: signalRuntimeEnv,
          abortSignal: abort.signal,
          mediaMaxMb: account.config.mediaMaxMb,
        })
          .catch((err) => {
            const current =
              signalRuntimes.get(account.accountId) ?? defaultSignalStatus();
            signalRuntimes.set(account.accountId, {
              ...current,
              lastError: formatError(err),
            });
            logSignal.error(
              `[${account.accountId}] provider exited: ${formatError(err)}`,
            );
          })
          .finally(() => {
            signalAborts.delete(account.accountId);
            signalTasks.delete(account.accountId);
            const current =
              signalRuntimes.get(account.accountId) ?? defaultSignalStatus();
            signalRuntimes.set(account.accountId, {
              ...current,
              running: false,
              lastStopAt: Date.now(),
            });
          });
        signalTasks.set(account.accountId, task);
      }),
    );
  };

  const stopSignalProvider = async (accountId?: string) => {
    const ids = accountId
      ? [accountId]
      : Array.from(new Set([...signalAborts.keys(), ...signalTasks.keys()]));
    await Promise.all(
      ids.map(async (id) => {
        const abort = signalAborts.get(id);
        const task = signalTasks.get(id);
        if (!abort && !task) return;
        abort?.abort();
        try {
          await task;
        } catch {
          // ignore
        }
        signalAborts.delete(id);
        signalTasks.delete(id);
        const latest = signalRuntimes.get(id) ?? defaultSignalStatus();
        signalRuntimes.set(id, {
          ...latest,
          running: false,
          lastStopAt: Date.now(),
        });
      }),
    );
  };

  const startIMessageProvider = async (accountId?: string) => {
    const cfg = loadConfig();
    const accountIds = accountId ? [accountId] : listIMessageAccountIds(cfg);
    if (!cfg.imessage) {
      for (const id of accountIds) {
        const latest = imessageRuntimes.get(id) ?? defaultIMessageStatus();
        imessageRuntimes.set(id, {
          ...latest,
          running: false,
          lastError: "not configured",
        });
      }
      // keep quiet by default; this is a normal state
      if (shouldLogVerbose()) {
        logIMessage.debug(
          "imessage provider not configured (no imessage config)",
        );
      }
      return;
    }

    await Promise.all(
      accountIds.map(async (id) => {
        const account = resolveIMessageAccount({ cfg, accountId: id });
        if (!account.enabled) {
          const latest =
            imessageRuntimes.get(account.accountId) ?? defaultIMessageStatus();
          imessageRuntimes.set(account.accountId, {
            ...latest,
            running: false,
            lastError: "disabled",
          });
          if (shouldLogVerbose()) {
            logIMessage.debug(
              `[${account.accountId}] imessage provider disabled (imessage.enabled=false)`,
            );
          }
          return;
        }
        if (imessageTasks.has(account.accountId)) return;
        const cliPath = account.config.cliPath?.trim() || "imsg";
        const dbPath = account.config.dbPath?.trim();
        logIMessage.info(
          `[${account.accountId}] starting provider (${cliPath}${dbPath ? ` db=${dbPath}` : ""})`,
        );
        const abort = new AbortController();
        imessageAborts.set(account.accountId, abort);
        const latest =
          imessageRuntimes.get(account.accountId) ?? defaultIMessageStatus();
        imessageRuntimes.set(account.accountId, {
          ...latest,
          running: true,
          lastStartAt: Date.now(),
          lastError: null,
          cliPath,
          dbPath: dbPath ?? null,
        });
        const task = monitorIMessageProvider({
          accountId: account.accountId,
          config: cfg,
          runtime: imessageRuntimeEnv,
          abortSignal: abort.signal,
        })
          .catch((err) => {
            const current =
              imessageRuntimes.get(account.accountId) ??
              defaultIMessageStatus();
            imessageRuntimes.set(account.accountId, {
              ...current,
              lastError: formatError(err),
            });
            logIMessage.error(
              `[${account.accountId}] provider exited: ${formatError(err)}`,
            );
          })
          .finally(() => {
            imessageAborts.delete(account.accountId);
            imessageTasks.delete(account.accountId);
            const current =
              imessageRuntimes.get(account.accountId) ??
              defaultIMessageStatus();
            imessageRuntimes.set(account.accountId, {
              ...current,
              running: false,
              lastStopAt: Date.now(),
            });
          });
        imessageTasks.set(account.accountId, task);
      }),
    );
  };

  const stopIMessageProvider = async (accountId?: string) => {
    const ids = accountId
      ? [accountId]
      : Array.from(
          new Set([...imessageAborts.keys(), ...imessageTasks.keys()]),
        );
    await Promise.all(
      ids.map(async (id) => {
        const abort = imessageAborts.get(id);
        const task = imessageTasks.get(id);
        if (!abort && !task) return;
        abort?.abort();
        try {
          await task;
        } catch {
          // ignore
        }
        imessageAborts.delete(id);
        imessageTasks.delete(id);
        const latest = imessageRuntimes.get(id) ?? defaultIMessageStatus();
        imessageRuntimes.set(id, {
          ...latest,
          running: false,
          lastStopAt: Date.now(),
        });
      }),
    );
  };

  const startProviders = async () => {
    await startWhatsAppProvider();
    await startDiscordProvider();
    await startSlackProvider();
    await startTelegramProvider();
    await startSignalProvider();
    await startIMessageProvider();
  };

  const markWhatsAppLoggedOut = (cleared: boolean, accountId?: string) => {
    const cfg = loadConfig();
    const resolvedId = accountId ?? resolveDefaultWhatsAppAccountId(cfg);
    const current = whatsappRuntimes.get(resolvedId) ?? defaultWhatsAppStatus();
    whatsappRuntimes.set(resolvedId, {
      ...current,
      running: false,
      connected: false,
      lastError: cleared ? "logged out" : current.lastError,
    });
  };

  const getRuntimeSnapshot = (): ProviderRuntimeSnapshot => {
    const cfg = loadConfig();
    const defaultWhatsAppId = resolveDefaultWhatsAppAccountId(cfg);
    const whatsapp =
      whatsappRuntimes.get(defaultWhatsAppId) ?? defaultWhatsAppStatus();
    const whatsappAccounts = Object.fromEntries(
      Array.from(whatsappRuntimes.entries()).map(([id, status]) => [
        id,
        { ...status },
      ]),
    );

    const telegramAccounts = Object.fromEntries(
      listTelegramAccountIds(cfg).map((id) => {
        const account = resolveTelegramAccount({ cfg, accountId: id });
        const current =
          telegramRuntimes.get(account.accountId) ?? defaultTelegramStatus();
        const status: TelegramRuntimeStatus = {
          ...current,
          mode:
            current.mode ?? (account.config.webhookUrl ? "webhook" : "polling"),
        };
        if (!status.running) {
          if (!account.enabled) {
            status.lastError ??= "disabled";
          } else if (!account.token) {
            status.lastError ??= "not configured";
          }
        }
        return [account.accountId, status];
      }),
    );
    const telegramDefaultId = resolveDefaultTelegramAccountId(cfg);
    const telegram =
      telegramAccounts[telegramDefaultId] ?? defaultTelegramStatus();

    const discordAccounts = Object.fromEntries(
      listDiscordAccountIds(cfg).map((id) => {
        const account = resolveDiscordAccount({ cfg, accountId: id });
        const current =
          discordRuntimes.get(account.accountId) ?? defaultDiscordStatus();
        const status: DiscordRuntimeStatus = { ...current };
        if (!status.running) {
          if (!account.enabled) {
            status.lastError ??= "disabled";
          } else if (!account.token) {
            status.lastError ??= "not configured";
          }
        }
        return [account.accountId, status];
      }),
    );
    const discordDefaultId = resolveDefaultDiscordAccountId(cfg);
    const discord = discordAccounts[discordDefaultId] ?? defaultDiscordStatus();

    const slackAccounts = Object.fromEntries(
      listSlackAccountIds(cfg).map((id) => {
        const account = resolveSlackAccount({ cfg, accountId: id });
        const current =
          slackRuntimes.get(account.accountId) ?? defaultSlackStatus();
        const status: SlackRuntimeStatus = { ...current };
        if (!status.running) {
          if (!account.enabled) {
            status.lastError ??= "disabled";
          } else if (!account.botToken || !account.appToken) {
            status.lastError ??= "not configured";
          }
        }
        return [account.accountId, status];
      }),
    );
    const slackDefaultId = resolveDefaultSlackAccountId(cfg);
    const slack = slackAccounts[slackDefaultId] ?? defaultSlackStatus();

    const signalAccounts = Object.fromEntries(
      listSignalAccountIds(cfg).map((id) => {
        const account = resolveSignalAccount({ cfg, accountId: id });
        const current =
          signalRuntimes.get(account.accountId) ?? defaultSignalStatus();
        const status: SignalRuntimeStatus = {
          ...current,
          baseUrl: current.baseUrl ?? account.baseUrl,
        };
        if (!status.running) {
          if (!account.enabled) {
            status.lastError ??= "disabled";
          } else if (!account.configured) {
            status.lastError ??= "not configured";
          }
        }
        return [account.accountId, status];
      }),
    );
    const signalDefaultId = resolveDefaultSignalAccountId(cfg);
    const signal = signalAccounts[signalDefaultId] ?? defaultSignalStatus();

    const imessageAccounts = Object.fromEntries(
      listIMessageAccountIds(cfg).map((id) => {
        const account = resolveIMessageAccount({ cfg, accountId: id });
        const current =
          imessageRuntimes.get(account.accountId) ?? defaultIMessageStatus();
        const cliPath = account.config.cliPath?.trim() || "imsg";
        const dbPath = account.config.dbPath?.trim() || null;
        const status: IMessageRuntimeStatus = {
          ...current,
          cliPath: current.cliPath ?? cliPath,
          dbPath: current.dbPath ?? dbPath,
        };
        if (!status.running && !account.enabled) {
          status.lastError ??= "disabled";
        }
        if (!status.running && !cfg.imessage) {
          status.lastError ??= "not configured";
        }
        return [account.accountId, status];
      }),
    );
    const imessageDefaultId = resolveDefaultIMessageAccountId(cfg);
    const imessage =
      imessageAccounts[imessageDefaultId] ?? defaultIMessageStatus();
    return {
      whatsapp: { ...whatsapp },
      whatsappAccounts,
      telegram,
      telegramAccounts,
      discord,
      discordAccounts,
      slack,
      slackAccounts,
      signal,
      signalAccounts,
      imessage,
      imessageAccounts,
    };
  };

  return {
    getRuntimeSnapshot,
    startProviders,
    startWhatsAppProvider,
    stopWhatsAppProvider,
    startTelegramProvider,
    stopTelegramProvider,
    startDiscordProvider,
    stopDiscordProvider,
    startSlackProvider,
    stopSlackProvider,
    startSignalProvider,
    stopSignalProvider,
    startIMessageProvider,
    stopIMessageProvider,
    markWhatsAppLoggedOut,
  };
}
