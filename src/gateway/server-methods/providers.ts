import type { ClawdbotConfig } from "../../config/config.js";
import {
  loadConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../../config/config.js";
import {
  listDiscordAccountIds,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
} from "../../discord/accounts.js";
import { type DiscordProbe, probeDiscord } from "../../discord/probe.js";
import {
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
} from "../../imessage/accounts.js";
import { type IMessageProbe, probeIMessage } from "../../imessage/probe.js";
import {
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "../../signal/accounts.js";
import { probeSignal, type SignalProbe } from "../../signal/probe.js";
import {
  listSlackAccountIds,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
} from "../../slack/accounts.js";
import { probeSlack, type SlackProbe } from "../../slack/probe.js";
import {
  listTelegramAccountIds,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
} from "../../telegram/accounts.js";
import { probeTelegram, type TelegramProbe } from "../../telegram/probe.js";
import {
  listEnabledWhatsAppAccounts,
  resolveDefaultWhatsAppAccountId,
} from "../../web/accounts.js";
import {
  getWebAuthAgeMs,
  readWebSelfId,
  webAuthExists,
} from "../../web/session.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateProvidersStatusParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

export const providersHandlers: GatewayRequestHandlers = {
  "providers.status": async ({ params, respond, context }) => {
    if (!validateProvidersStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid providers.status params: ${formatValidationErrors(validateProvidersStatusParams.errors)}`,
        ),
      );
      return;
    }
    const probe = (params as { probe?: boolean }).probe === true;
    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs =
      typeof timeoutMsRaw === "number" ? Math.max(1000, timeoutMsRaw) : 10_000;
    const cfg = loadConfig();
    const runtime = context.getRuntimeSnapshot();

    const defaultTelegramAccountId = resolveDefaultTelegramAccountId(cfg);
    const defaultDiscordAccountId = resolveDefaultDiscordAccountId(cfg);
    const defaultSlackAccountId = resolveDefaultSlackAccountId(cfg);
    const defaultSignalAccountId = resolveDefaultSignalAccountId(cfg);
    const defaultIMessageAccountId = resolveDefaultIMessageAccountId(cfg);

    const telegramAccounts = await Promise.all(
      listTelegramAccountIds(cfg).map(async (accountId) => {
        const account = resolveTelegramAccount({ cfg, accountId });
        const rt =
          runtime.telegramAccounts?.[account.accountId] ??
          (account.accountId === defaultTelegramAccountId
            ? runtime.telegram
            : undefined);
        const configured = Boolean(account.token);
        let telegramProbe: TelegramProbe | undefined;
        let lastProbeAt: number | null = null;
        if (probe && configured && account.enabled) {
          telegramProbe = await probeTelegram(
            account.token,
            timeoutMs,
            account.config.proxy,
          );
          lastProbeAt = Date.now();
        }
        return {
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured,
          tokenSource: account.tokenSource,
          running: rt?.running ?? false,
          mode: rt?.mode ?? (account.config.webhookUrl ? "webhook" : "polling"),
          lastStartAt: rt?.lastStartAt ?? null,
          lastStopAt: rt?.lastStopAt ?? null,
          lastError: rt?.lastError ?? null,
          probe: telegramProbe,
          lastProbeAt,
        };
      }),
    );
    const defaultTelegramAccount =
      telegramAccounts.find(
        (account) => account.accountId === defaultTelegramAccountId,
      ) ?? telegramAccounts[0];

    const discordAccounts = await Promise.all(
      listDiscordAccountIds(cfg).map(async (accountId) => {
        const account = resolveDiscordAccount({ cfg, accountId });
        const rt =
          runtime.discordAccounts?.[account.accountId] ??
          (account.accountId === defaultDiscordAccountId
            ? runtime.discord
            : undefined);
        const configured = Boolean(account.token);
        let discordProbe: DiscordProbe | undefined;
        let lastProbeAt: number | null = null;
        if (probe && configured && account.enabled) {
          discordProbe = await probeDiscord(account.token, timeoutMs);
          lastProbeAt = Date.now();
        }
        return {
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured,
          tokenSource: account.tokenSource,
          running: rt?.running ?? false,
          lastStartAt: rt?.lastStartAt ?? null,
          lastStopAt: rt?.lastStopAt ?? null,
          lastError: rt?.lastError ?? null,
          probe: discordProbe,
          lastProbeAt,
        };
      }),
    );
    const defaultDiscordAccount =
      discordAccounts.find(
        (account) => account.accountId === defaultDiscordAccountId,
      ) ?? discordAccounts[0];

    const slackAccounts = await Promise.all(
      listSlackAccountIds(cfg).map(async (accountId) => {
        const account = resolveSlackAccount({ cfg, accountId });
        const rt =
          runtime.slackAccounts?.[account.accountId] ??
          (account.accountId === defaultSlackAccountId
            ? runtime.slack
            : undefined);
        const configured = Boolean(account.botToken && account.appToken);
        let slackProbe: SlackProbe | undefined;
        let lastProbeAt: number | null = null;
        if (probe && configured && account.enabled && account.botToken) {
          slackProbe = await probeSlack(account.botToken, timeoutMs);
          lastProbeAt = Date.now();
        }
        return {
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured,
          botTokenSource: account.botTokenSource,
          appTokenSource: account.appTokenSource,
          running: rt?.running ?? false,
          lastStartAt: rt?.lastStartAt ?? null,
          lastStopAt: rt?.lastStopAt ?? null,
          lastError: rt?.lastError ?? null,
          probe: slackProbe,
          lastProbeAt,
        };
      }),
    );
    const defaultSlackAccount =
      slackAccounts.find(
        (account) => account.accountId === defaultSlackAccountId,
      ) ?? slackAccounts[0];

    const signalAccounts = await Promise.all(
      listSignalAccountIds(cfg).map(async (accountId) => {
        const account = resolveSignalAccount({ cfg, accountId });
        const rt =
          runtime.signalAccounts?.[account.accountId] ??
          (account.accountId === defaultSignalAccountId
            ? runtime.signal
            : undefined);
        const configured = account.configured;
        let signalProbe: SignalProbe | undefined;
        let lastProbeAt: number | null = null;
        if (probe && configured && account.enabled) {
          signalProbe = await probeSignal(account.baseUrl, timeoutMs);
          lastProbeAt = Date.now();
        }
        return {
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured,
          baseUrl: account.baseUrl,
          running: rt?.running ?? false,
          lastStartAt: rt?.lastStartAt ?? null,
          lastStopAt: rt?.lastStopAt ?? null,
          lastError: rt?.lastError ?? null,
          probe: signalProbe,
          lastProbeAt,
        };
      }),
    );
    const defaultSignalAccount =
      signalAccounts.find(
        (account) => account.accountId === defaultSignalAccountId,
      ) ?? signalAccounts[0];

    const imessageBaseConfigured = Boolean(cfg.imessage);
    let imessageProbe: IMessageProbe | undefined;
    let imessageLastProbeAt: number | null = null;
    if (probe && imessageBaseConfigured) {
      imessageProbe = await probeIMessage(timeoutMs);
      imessageLastProbeAt = Date.now();
    }
    const imessageAccounts = listIMessageAccountIds(cfg).map((accountId) => {
      const account = resolveIMessageAccount({ cfg, accountId });
      const rt =
        runtime.imessageAccounts?.[account.accountId] ??
        (account.accountId === defaultIMessageAccountId
          ? runtime.imessage
          : undefined);
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: imessageBaseConfigured,
        running: rt?.running ?? false,
        lastStartAt: rt?.lastStartAt ?? null,
        lastStopAt: rt?.lastStopAt ?? null,
        lastError: rt?.lastError ?? null,
        cliPath: rt?.cliPath ?? account.config.cliPath ?? null,
        dbPath: rt?.dbPath ?? account.config.dbPath ?? null,
        probe: imessageProbe,
        lastProbeAt: imessageLastProbeAt,
      };
    });
    const defaultIMessageAccount =
      imessageAccounts.find(
        (account) => account.accountId === defaultIMessageAccountId,
      ) ?? imessageAccounts[0];
    const defaultWhatsAppAccountId = resolveDefaultWhatsAppAccountId(cfg);
    const enabledWhatsAppAccounts = listEnabledWhatsAppAccounts(cfg);
    const defaultWhatsAppAccount =
      enabledWhatsAppAccounts.find(
        (account) => account.accountId === defaultWhatsAppAccountId,
      ) ?? enabledWhatsAppAccounts[0];
    const linked = defaultWhatsAppAccount
      ? await webAuthExists(defaultWhatsAppAccount.authDir)
      : false;
    const authAgeMs = defaultWhatsAppAccount
      ? getWebAuthAgeMs(defaultWhatsAppAccount.authDir)
      : null;
    const self = defaultWhatsAppAccount
      ? readWebSelfId(defaultWhatsAppAccount.authDir)
      : { e164: null, jid: null };

    const defaultWhatsAppStatus = {
      running: false,
      connected: false,
      reconnectAttempts: 0,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastMessageAt: null,
      lastEventAt: null,
      lastError: null,
    } as const;
    const whatsappAccounts = await Promise.all(
      enabledWhatsAppAccounts.map(async (account) => {
        const rt =
          runtime.whatsappAccounts?.[account.accountId] ??
          defaultWhatsAppStatus;
        return {
          accountId: account.accountId,
          enabled: account.enabled,
          linked: await webAuthExists(account.authDir),
          authAgeMs: getWebAuthAgeMs(account.authDir),
          self: readWebSelfId(account.authDir),
          running: rt.running,
          connected: rt.connected,
          lastConnectedAt: rt.lastConnectedAt ?? null,
          lastDisconnect: rt.lastDisconnect ?? null,
          reconnectAttempts: rt.reconnectAttempts,
          lastMessageAt: rt.lastMessageAt ?? null,
          lastEventAt: rt.lastEventAt ?? null,
          lastError: rt.lastError ?? null,
        };
      }),
    );

    respond(
      true,
      {
        ts: Date.now(),
        whatsapp: {
          configured: linked,
          linked,
          authAgeMs,
          self,
          running: runtime.whatsapp.running,
          connected: runtime.whatsapp.connected,
          lastConnectedAt: runtime.whatsapp.lastConnectedAt ?? null,
          lastDisconnect: runtime.whatsapp.lastDisconnect ?? null,
          reconnectAttempts: runtime.whatsapp.reconnectAttempts,
          lastMessageAt: runtime.whatsapp.lastMessageAt ?? null,
          lastEventAt: runtime.whatsapp.lastEventAt ?? null,
          lastError: runtime.whatsapp.lastError ?? null,
        },
        whatsappAccounts,
        whatsappDefaultAccountId: defaultWhatsAppAccountId,
        telegram: {
          configured: defaultTelegramAccount?.configured ?? false,
          tokenSource: defaultTelegramAccount?.tokenSource ?? "none",
          running: defaultTelegramAccount?.running ?? false,
          mode: defaultTelegramAccount?.mode ?? null,
          lastStartAt: defaultTelegramAccount?.lastStartAt ?? null,
          lastStopAt: defaultTelegramAccount?.lastStopAt ?? null,
          lastError: defaultTelegramAccount?.lastError ?? null,
          probe: defaultTelegramAccount?.probe,
          lastProbeAt: defaultTelegramAccount?.lastProbeAt ?? null,
        },
        telegramAccounts,
        telegramDefaultAccountId: defaultTelegramAccountId,
        discord: {
          configured: defaultDiscordAccount?.configured ?? false,
          tokenSource: defaultDiscordAccount?.tokenSource ?? "none",
          running: defaultDiscordAccount?.running ?? false,
          lastStartAt: defaultDiscordAccount?.lastStartAt ?? null,
          lastStopAt: defaultDiscordAccount?.lastStopAt ?? null,
          lastError: defaultDiscordAccount?.lastError ?? null,
          probe: defaultDiscordAccount?.probe,
          lastProbeAt: defaultDiscordAccount?.lastProbeAt ?? null,
        },
        discordAccounts,
        discordDefaultAccountId: defaultDiscordAccountId,
        slack: {
          configured: defaultSlackAccount?.configured ?? false,
          botTokenSource: defaultSlackAccount?.botTokenSource ?? "none",
          appTokenSource: defaultSlackAccount?.appTokenSource ?? "none",
          running: defaultSlackAccount?.running ?? false,
          lastStartAt: defaultSlackAccount?.lastStartAt ?? null,
          lastStopAt: defaultSlackAccount?.lastStopAt ?? null,
          lastError: defaultSlackAccount?.lastError ?? null,
          probe: defaultSlackAccount?.probe,
          lastProbeAt: defaultSlackAccount?.lastProbeAt ?? null,
        },
        slackAccounts,
        slackDefaultAccountId: defaultSlackAccountId,
        signal: {
          configured: defaultSignalAccount?.configured ?? false,
          baseUrl: defaultSignalAccount?.baseUrl ?? null,
          running: defaultSignalAccount?.running ?? false,
          lastStartAt: defaultSignalAccount?.lastStartAt ?? null,
          lastStopAt: defaultSignalAccount?.lastStopAt ?? null,
          lastError: defaultSignalAccount?.lastError ?? null,
          probe: defaultSignalAccount?.probe,
          lastProbeAt: defaultSignalAccount?.lastProbeAt ?? null,
        },
        signalAccounts,
        signalDefaultAccountId: defaultSignalAccountId,
        imessage: {
          configured: defaultIMessageAccount?.configured ?? false,
          running: defaultIMessageAccount?.running ?? false,
          lastStartAt: defaultIMessageAccount?.lastStartAt ?? null,
          lastStopAt: defaultIMessageAccount?.lastStopAt ?? null,
          lastError: defaultIMessageAccount?.lastError ?? null,
          cliPath: defaultIMessageAccount?.cliPath ?? null,
          dbPath: defaultIMessageAccount?.dbPath ?? null,
          probe: defaultIMessageAccount?.probe,
          lastProbeAt: defaultIMessageAccount?.lastProbeAt ?? null,
        },
        imessageAccounts,
        imessageDefaultAccountId: defaultIMessageAccountId,
      },
      undefined,
    );
  },
  "telegram.logout": async ({ respond, context }) => {
    try {
      await context.stopTelegramProvider();
      const snapshot = await readConfigFileSnapshot();
      if (!snapshot.valid) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "config invalid; fix it before logging out",
          ),
        );
        return;
      }
      const cfg = snapshot.config ?? {};
      const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
      const hadToken = Boolean(cfg.telegram?.botToken);
      const nextTelegram = cfg.telegram ? { ...cfg.telegram } : undefined;
      if (nextTelegram) {
        delete nextTelegram.botToken;
      }
      const nextCfg = { ...cfg } as ClawdbotConfig;
      if (nextTelegram && Object.keys(nextTelegram).length > 0) {
        nextCfg.telegram = nextTelegram;
      } else {
        delete nextCfg.telegram;
      }
      await writeConfigFile(nextCfg);
      respond(
        true,
        { cleared: hadToken, envToken: Boolean(envToken) },
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      );
    }
  },
};
