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
    const pluginMap = new Map<ProviderId, ProviderPlugin>(
      plugins.map((plugin) => [plugin.id, plugin]),
    );

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

    const isAccountEnabled = (plugin: ProviderPlugin, account: unknown) =>
      plugin.config.isEnabled
        ? plugin.config.isEnabled(account, cfg)
        : !account ||
          typeof account !== "object" ||
          (account as { enabled?: boolean }).enabled !== false;

    const buildProviderAccounts = async (providerId: ProviderId) => {
      const plugin = pluginMap.get(providerId);
      if (!plugin) {
        return {
          accounts: [] as ProviderAccountSnapshot[],
          defaultAccountId: DEFAULT_ACCOUNT_ID,
          defaultAccount: undefined as ProviderAccountSnapshot | undefined,
          resolvedAccounts: {} as Record<string, unknown>,
        };
      }
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId =
        plugin.config.defaultAccountId?.(cfg) ??
        accountIds[0] ??
        DEFAULT_ACCOUNT_ID;
      const accounts: ProviderAccountSnapshot[] = [];
      const resolvedAccounts: Record<string, unknown> = {};
      for (const accountId of accountIds) {
        const account = plugin.config.resolveAccount(cfg, accountId);
        const enabled = isAccountEnabled(plugin, account);
        resolvedAccounts[accountId] = account;
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
      return { accounts, defaultAccountId, defaultAccount, resolvedAccounts };
    };

    const payload: Record<string, unknown> = { ts: Date.now() };
    for (const plugin of plugins) {
      const { accounts, defaultAccountId, defaultAccount, resolvedAccounts } =
        await buildProviderAccounts(plugin.id);
      const fallbackAccount =
        resolvedAccounts[defaultAccountId] ??
        plugin.config.resolveAccount(cfg, defaultAccountId);
      const summary = plugin.status?.buildProviderSummary
        ? await plugin.status.buildProviderSummary({
            account: fallbackAccount,
            cfg,
            defaultAccountId,
            snapshot:
              defaultAccount ??
              ({
                accountId: defaultAccountId,
              } as ProviderAccountSnapshot),
          })
        : {
            configured: defaultAccount?.configured ?? false,
          };
      payload[plugin.id] = summary;
      payload[`${plugin.id}Accounts`] = accounts;
      payload[`${plugin.id}DefaultAccountId`] = defaultAccountId;
    }

    respond(true, payload, undefined);
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
