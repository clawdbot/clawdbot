import type { ClawdbotConfig } from "../../config/config.js";
import { loadConfig, readConfigFileSnapshot } from "../../config/config.js";
import { getProviderActivity } from "../../infra/provider-activity.js";
import { resolveProviderDefaultAccountId } from "../../providers/plugins/helpers.js";
import {
  getProviderPlugin,
  listProviderPlugins,
  normalizeProviderId,
  type ProviderId,
} from "../../providers/plugins/index.js";
import { buildProviderAccountSnapshot } from "../../providers/plugins/status.js";
import type {
  ProviderAccountSnapshot,
  ProviderPlugin,
} from "../../providers/plugins/types.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateProvidersLogoutParams,
  validateProvidersStatusParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

type ProviderLogoutPayload = {
  provider: ProviderId;
  accountId: string;
  cleared: boolean;
  [key: string]: unknown;
};

export async function logoutProviderAccount(params: {
  providerId: ProviderId;
  accountId?: string | null;
  cfg: ClawdbotConfig;
  context: GatewayRequestContext;
  plugin: ProviderPlugin;
}): Promise<ProviderLogoutPayload> {
  const resolvedAccountId =
    params.accountId?.trim() ||
    params.plugin.config.defaultAccountId?.(params.cfg) ||
    params.plugin.config.listAccountIds(params.cfg)[0] ||
    DEFAULT_ACCOUNT_ID;
  const account = params.plugin.config.resolveAccount(
    params.cfg,
    resolvedAccountId,
  );
  await params.context.stopProvider(params.providerId, resolvedAccountId);
  const result = await params.plugin.gateway?.logoutAccount?.({
    cfg: params.cfg,
    accountId: resolvedAccountId,
    account,
    runtime: defaultRuntime,
  });
  if (!result) {
    throw new Error(`Provider ${params.providerId} does not support logout`);
  }
  const cleared = Boolean(result.cleared);
  const loggedOut =
    typeof result.loggedOut === "boolean" ? result.loggedOut : cleared;
  if (loggedOut) {
    params.context.markProviderLoggedOut(
      params.providerId,
      true,
      resolvedAccountId,
    );
  }
  return {
    provider: params.providerId,
    accountId: resolvedAccountId,
    ...result,
    cleared,
  };
}

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
    const plugins = listProviderPlugins();
    const pluginMap = new Map<ProviderId, ProviderPlugin>(
      plugins.map((plugin) => [plugin.id, plugin]),
    );

    const resolveRuntimeSnapshot = (
      providerId: ProviderId,
      accountId: string,
      defaultAccountId: string,
    ): ProviderAccountSnapshot | undefined => {
      const accounts = runtime.providerAccounts[providerId];
      const defaultRuntime = runtime.providers[providerId];
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
      const defaultAccountId = resolveProviderDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
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

    const payload: Record<string, unknown> = {
      ts: Date.now(),
      providerOrder: plugins.map((plugin) => plugin.id),
      providerLabels: Object.fromEntries(
        plugins.map((plugin) => [plugin.id, plugin.meta.label]),
      ),
      providers: {} as Record<string, unknown>,
      providerAccounts: {} as Record<string, unknown>,
      providerDefaultAccountId: {} as Record<string, unknown>,
    };
    const providersMap = payload.providers as Record<string, unknown>;
    const accountsMap = payload.providerAccounts as Record<string, unknown>;
    const defaultAccountIdMap = payload.providerDefaultAccountId as Record<
      string,
      unknown
    >;
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
      providersMap[plugin.id] = summary;
      accountsMap[plugin.id] = accounts;
      defaultAccountIdMap[plugin.id] = defaultAccountId;
    }

    respond(true, payload, undefined);
  },
  "providers.logout": async ({ params, respond, context }) => {
    if (!validateProvidersLogoutParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid providers.logout params: ${formatValidationErrors(validateProvidersLogoutParams.errors)}`,
        ),
      );
      return;
    }
    const rawProvider = (params as { provider?: unknown }).provider;
    const providerId =
      typeof rawProvider === "string" ? normalizeProviderId(rawProvider) : null;
    if (!providerId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid providers.logout provider",
        ),
      );
      return;
    }
    const plugin = getProviderPlugin(providerId);
    if (!plugin?.gateway?.logoutAccount) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `provider ${providerId} does not support logout`,
        ),
      );
      return;
    }
    const accountIdRaw = (params as { accountId?: unknown }).accountId;
    const accountId =
      typeof accountIdRaw === "string" ? accountIdRaw.trim() : undefined;
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
    try {
      const payload = await logoutProviderAccount({
        providerId,
        accountId,
        cfg: snapshot.config ?? {},
        context,
        plugin,
      });
      respond(true, payload, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      );
    }
  },
};
