import type { ClawdbotConfig } from "../../config/config.js";
import {
  loadConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../../config/config.js";
import { getProviderActivity } from "../../infra/provider-activity.js";
import {
  listProviderPlugins,
  type ProviderId,
} from "../../providers/plugins/index.js";
import { buildProviderAccountSnapshot } from "../../providers/plugins/status.js";
import type {
  ProviderAccountSnapshot,
  ProviderPlugin,
} from "../../providers/plugins/types.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
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

    const runtimeAny = runtime as Record<string, unknown>;
    const plugins = listProviderPlugins();
    const pluginMap = new Map<ProviderId, ProviderPlugin>();
    for (const plugin of plugins) {
      pluginMap.set(plugin.id, plugin);
    }

    const resolveRuntimeSnapshot = (
      providerId: ProviderId,
      accountId: string,
      defaultAccountId: string,
    ): ProviderAccountSnapshot | undefined => {
      const accountsKey = `${providerId}Accounts`;
      const accounts = runtimeAny[accountsKey] as
        | Record<string, ProviderAccountSnapshot>
        | undefined;
      const defaultRuntime = runtimeAny[providerId] as
        | ProviderAccountSnapshot
        | undefined;
      const raw =
        accounts?.[accountId] ??
        (accountId === defaultAccountId ? defaultRuntime : undefined);
      if (!raw) return undefined;
      return raw;
    };

    const buildProviderAccounts = async (providerId: ProviderId) => {
      const plugin = pluginMap.get(providerId);
      if (!plugin) {
        return {
          accounts: [] as ProviderAccountSnapshot[],
          defaultAccountId: DEFAULT_ACCOUNT_ID,
          defaultAccount: undefined as ProviderAccountSnapshot | undefined,
        };
      }
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId =
        plugin.config.defaultAccountId?.(cfg) ??
        accountIds[0] ??
        DEFAULT_ACCOUNT_ID;
      const accounts: ProviderAccountSnapshot[] = [];
      for (const accountId of accountIds) {
        const account = plugin.config.resolveAccount(cfg, accountId);
        const enabled =
          !account ||
          typeof account !== "object" ||
          (account as { enabled?: boolean }).enabled !== false;
        let probeResult: unknown;
        let lastProbeAt: number | null = null;
        if (probe && enabled && plugin.status?.probeAccount) {
          let configured = true;
          if (plugin.config.isConfigured) {
            configured = await plugin.config.isConfigured(account, cfg);
          }
          if (configured) {
            probeResult = await plugin.status.probeAccount({
              account,
              timeoutMs,
              cfg,
            });
            lastProbeAt = Date.now();
          }
        }
        let auditResult: unknown;
        if (probe && enabled && plugin.status?.auditAccount) {
          let configured = true;
          if (plugin.config.isConfigured) {
            configured = await plugin.config.isConfigured(account, cfg);
          }
          if (configured) {
            auditResult = await plugin.status.auditAccount({
              account,
              timeoutMs,
              cfg,
              probe: probeResult,
            });
          }
        }
        const runtimeSnapshot = resolveRuntimeSnapshot(
          providerId,
          accountId,
          defaultAccountId,
        );
        const snapshot = await buildProviderAccountSnapshot({
          plugin,
          cfg,
          accountId,
          runtime: runtimeSnapshot,
          probe: probeResult,
          audit: auditResult,
        });
        if (lastProbeAt) snapshot.lastProbeAt = lastProbeAt;
        const activity = getProviderActivity({
          provider: providerId as never,
          accountId,
        });
        if (snapshot.lastInboundAt == null) {
          snapshot.lastInboundAt = activity.inboundAt;
        }
        if (snapshot.lastOutboundAt == null) {
          snapshot.lastOutboundAt = activity.outboundAt;
        }
        accounts.push(snapshot);
      }
      const defaultAccount =
        accounts.find((entry) => entry.accountId === defaultAccountId) ??
        accounts[0];
      return { accounts, defaultAccountId, defaultAccount };
    };

    const {
      accounts: whatsappAccounts,
      defaultAccountId: defaultWhatsAppAccountId,
      defaultAccount: defaultWhatsAppAccount,
    } = await buildProviderAccounts("whatsapp");
    const {
      accounts: telegramAccounts,
      defaultAccountId: defaultTelegramAccountId,
      defaultAccount: defaultTelegramAccount,
    } = await buildProviderAccounts("telegram");
    const {
      accounts: discordAccounts,
      defaultAccountId: defaultDiscordAccountId,
      defaultAccount: defaultDiscordAccount,
    } = await buildProviderAccounts("discord");
    const {
      accounts: slackAccounts,
      defaultAccountId: defaultSlackAccountId,
      defaultAccount: defaultSlackAccount,
    } = await buildProviderAccounts("slack");
    const {
      accounts: signalAccounts,
      defaultAccountId: defaultSignalAccountId,
      defaultAccount: defaultSignalAccount,
    } = await buildProviderAccounts("signal");
    const {
      accounts: imessageAccounts,
      defaultAccountId: defaultIMessageAccountId,
      defaultAccount: defaultIMessageAccount,
    } = await buildProviderAccounts("imessage");
    const {
      accounts: msteamsAccounts,
      defaultAccountId: defaultMSTeamsAccountId,
      defaultAccount: defaultMSTeamsAccount,
    } = await buildProviderAccounts("msteams");

    const whatsappPlugin = pluginMap.get("whatsapp");
    const defaultWhatsAppConfig = whatsappPlugin
      ? (whatsappPlugin.config.resolveAccount(
          cfg,
          defaultWhatsAppAccountId,
        ) as { authDir?: string })
      : undefined;
    const authDir = defaultWhatsAppConfig?.authDir;
    const linked =
      typeof defaultWhatsAppAccount?.linked === "boolean"
        ? defaultWhatsAppAccount.linked
        : authDir
          ? await webAuthExists(authDir)
          : false;
    const authAgeMs = linked && authDir ? getWebAuthAgeMs(authDir) : null;
    const self =
      linked && authDir ? readWebSelfId(authDir) : { e164: null, jid: null };
    const whatsappRuntime = defaultWhatsAppAccount;

    respond(
      true,
      {
        ts: Date.now(),
        whatsapp: {
          configured: linked,
          linked,
          authAgeMs,
          self,
          running: whatsappRuntime?.running ?? false,
          connected: whatsappRuntime?.connected ?? false,
          lastConnectedAt: whatsappRuntime?.lastConnectedAt ?? null,
          lastDisconnect: whatsappRuntime?.lastDisconnect ?? null,
          reconnectAttempts: whatsappRuntime?.reconnectAttempts,
          lastMessageAt: whatsappRuntime?.lastMessageAt ?? null,
          lastEventAt: whatsappRuntime?.lastEventAt ?? null,
          lastError: whatsappRuntime?.lastError ?? null,
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
        msteams: {
          configured: defaultMSTeamsAccount?.configured ?? false,
          running: defaultMSTeamsAccount?.running ?? false,
          lastStartAt: defaultMSTeamsAccount?.lastStartAt ?? null,
          lastStopAt: defaultMSTeamsAccount?.lastStopAt ?? null,
          lastError: defaultMSTeamsAccount?.lastError ?? null,
          port: defaultMSTeamsAccount?.port ?? null,
          probe: defaultMSTeamsAccount?.probe,
          lastProbeAt: defaultMSTeamsAccount?.lastProbeAt ?? null,
        },
        msteamsAccounts,
        msteamsDefaultAccountId: defaultMSTeamsAccountId,
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
