/**
 * Resolves ClickClack account configuration from root channel config, named
 * account overrides, and secret-provider references.
 */
import {
  createAccountListHelpers,
  hasConfiguredAccountValue,
} from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveNormalizedAccountEntry } from "openclaw/plugin-sdk/account-resolution-runtime";
import { resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { mergePairLoopGuardConfig } from "openclaw/plugin-sdk/pair-loop-guard-runtime";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import {
  normalizeSecretInputString,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { canResolveEnvSecretRefInReadOnlyPath } from "openclaw/plugin-sdk/secret-ref-readonly";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  ClickClackAccountConfig,
  ClickClackGroupConfig,
  CoreConfig,
  ResolvedClickClackAccount,
} from "./types.js";

const DEFAULT_RECONNECT_MS = 1_500;
const MIN_RECONNECT_MS = 100;
const MAX_RECONNECT_MS = 60_000;
const DEFAULT_DISCUSSIONS_SECTION = "Sessions";

const {
  listAccountIds: listClickClackAccountIds,
  resolveDefaultAccountId: resolveDefaultClickClackAccountId,
  resolveAccountConfig: resolveMergedClickClackAccountConfig,
} = createAccountListHelpers<ClickClackAccountConfig>("clickclack", {
  normalizeAccountId,
  omitKeys: ["defaultAccount"],
  nestedObjectKeys: ["botLoopProtection", "discussions"],
  hasImplicitDefaultAccount: (cfg) => {
    const channel = cfg.channels?.clickclack;
    return Boolean(
      channel?.baseUrl?.trim() &&
      (hasConfiguredAccountValue(channel.token) ||
        Boolean(channel.tokenFile?.trim()) ||
        Boolean(process.env.CLICKCLACK_BOT_TOKEN?.trim())) &&
      channel.workspace?.trim(),
    );
  },
});

export { DEFAULT_ACCOUNT_ID, listClickClackAccountIds, resolveDefaultClickClackAccountId };

function mergeClickClackGroups(
  ...sources: Array<Record<string, ClickClackGroupConfig> | undefined>
): Record<string, ClickClackGroupConfig> {
  const merged = new Map<string, ClickClackGroupConfig>();
  for (const source of sources) {
    for (const [rawKey, value] of Object.entries(source ?? {})) {
      const key = rawKey.trim();
      if (!key) {
        continue;
      }
      const mergedBotLoopProtection = mergePairLoopGuardConfig(
        merged.get(key)?.botLoopProtection,
        value.botLoopProtection,
      );
      merged.set(key, {
        ...merged.get(key),
        ...(value.requireMention !== undefined ? { requireMention: value.requireMention } : {}),
        ...(value.mentionPatterns !== undefined ? { mentionPatterns: value.mentionPatterns } : {}),
        ...(value.allowBots !== undefined ? { allowBots: value.allowBots } : {}),
        ...(mergedBotLoopProtection ? { botLoopProtection: mergedBotLoopProtection } : {}),
      });
    }
  }
  return Object.fromEntries(merged);
}

export function resolveClickClackAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): ClickClackAccountConfig {
  const channel = cfg.channels?.clickclack;
  const merged = resolveMergedClickClackAccountConfig(cfg, accountId);
  const account = resolveNormalizedAccountEntry(channel?.accounts, accountId, normalizeAccountId);
  const mergedWithGroups =
    channel?.groups || account?.groups
      ? {
          ...merged,
          groups: mergeClickClackGroups(channel?.groups, account?.groups),
        }
      : merged;
  const accountTokenFile = account?.tokenFile?.trim();
  if (accountTokenFile) {
    return {
      ...mergedWithGroups,
      token: account?.token,
      tokenFile: accountTokenFile,
    };
  }
  if (hasConfiguredAccountValue(account?.token)) {
    return {
      ...mergedWithGroups,
      token: account?.token,
      tokenFile: undefined,
    };
  }
  return mergedWithGroups;
}

function resolveClickClackToken(params: {
  cfg: CoreConfig;
  value: unknown;
  tokenFile?: string;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): Required<Pick<ResolvedClickClackAccount, "token" | "tokenSource" | "tokenStatus">> &
  Pick<ResolvedClickClackAccount, "credentialDiagnostics"> {
  const tokenFile = params.tokenFile?.trim();
  if (tokenFile) {
    const accountTokenFile = resolveNormalizedAccountEntry(
      params.cfg.channels?.clickclack?.accounts,
      params.accountId,
      normalizeAccountId,
    )?.tokenFile?.trim();
    const result = tryReadSecretFileSync(
      tokenFile,
      "ClickClack bot token",
      { rejectSymlink: true },
      {
        configPath: accountTokenFile
          ? `channels.clickclack.accounts.${params.accountId}.tokenFile`
          : "channels.clickclack.tokenFile",
      },
    );
    return result.status === "available"
      ? { token: result.value, tokenSource: "tokenFile", tokenStatus: "available" }
      : {
          token: "",
          tokenSource: "tokenFile",
          tokenStatus: "configured_unavailable",
          credentialDiagnostics: [result.diagnostic],
        };
  }
  const resolved = resolveSecretInputString({
    value: params.value,
    path:
      params.accountId === DEFAULT_ACCOUNT_ID
        ? "channels.clickclack.token"
        : `channels.clickclack.accounts.${params.accountId}.token`,
    defaults: params.cfg.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status !== "available") {
    if (resolved.status === "missing" && params.accountId === DEFAULT_ACCOUNT_ID) {
      const token = normalizeSecretInputString((params.env ?? process.env).CLICKCLACK_BOT_TOKEN);
      return token
        ? { token, tokenSource: "env", tokenStatus: "available" }
        : { token: "", tokenSource: "none", tokenStatus: "missing" };
    }
    if (resolved.status === "configured_unavailable" && resolved.ref.source === "env") {
      if (!canResolveEnvSecretRefInReadOnlyPath({ cfg: params.cfg, ...resolved.ref })) {
        const providerConfig = params.cfg.secrets?.providers?.[resolved.ref.provider];
        if (!providerConfig) {
          throw new Error(
            `Secret provider "${resolved.ref.provider}" is not configured (ref: env:${resolved.ref.provider}:${resolved.ref.id}).`,
          );
        }
        if (providerConfig.source !== "env") {
          throw new Error(
            `Secret provider "${resolved.ref.provider}" has source "${providerConfig.source}" but ref requests "env".`,
          );
        }
        throw new Error(
          `Environment variable "${resolved.ref.id}" is not allowlisted in secrets.providers.${resolved.ref.provider}.allowlist.`,
        );
      }
      const token = normalizeSecretInputString((params.env ?? process.env)[resolved.ref.id]);
      return {
        token: token ?? "",
        tokenSource: "config",
        tokenStatus: token ? "available" : "configured_unavailable",
      };
    }
    return {
      token: "",
      tokenSource: resolved.status === "missing" ? "none" : "config",
      tokenStatus: resolved.status,
    };
  }
  return { token: resolved.value, tokenSource: "config", tokenStatus: "available" };
}

/**
 * Builds the normalized account snapshot used by gateway, outbound delivery,
 * status reporting, and channel routing.
 */
export function resolveClickClackAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): ResolvedClickClackAccount {
  const accountId = normalizeAccountId(params.accountId);
  const merged = resolveClickClackAccountConfig(params.cfg, accountId);
  const baseEnabled = params.cfg.channels?.clickclack?.enabled !== false;
  const enabled = baseEnabled && merged.enabled !== false;
  const baseUrl = merged.baseUrl?.trim().replace(/\/$/, "") ?? "";
  const token = resolveClickClackToken({
    cfg: params.cfg,
    value: merged.token,
    tokenFile: merged.tokenFile,
    accountId,
    env: params.env,
  });
  const workspace = merged.workspace?.trim() ?? "";
  const discussionsWorkspace = merged.discussions?.workspace?.trim() || workspace;
  const controlUrlBase = merged.discussions?.controlUrlBase?.trim();
  const apiEndpoint = merged.apiBaseUrl?.trim().replace(/\/$/, "") || baseUrl;
  return {
    accountId,
    enabled,
    configured: Boolean(baseUrl && token.tokenStatus !== "missing" && workspace),
    name: normalizeOptionalString(merged.name),
    baseUrl,
    ...token,
    workspace,
    botUserId: normalizeOptionalString(merged.botUserId),
    agentId: normalizeOptionalString(merged.agentId),
    replyMode: merged.replyMode === "model" ? "model" : "agent",
    model: normalizeOptionalString(merged.model),
    systemPrompt: normalizeOptionalString(merged.systemPrompt),
    toolsAllow: merged.toolsAllow,
    defaultTo: merged.defaultTo?.trim() || "channel:general",
    allowFrom: merged.allowFrom ?? ["*"],
    reconnectMs: resolveIntegerOption(merged.reconnectMs, DEFAULT_RECONNECT_MS, {
      min: MIN_RECONNECT_MS,
      max: MAX_RECONNECT_MS,
    }),
    // Durable activity rows require an agent_activity:write bot token scope on
    // the ClickClack side, so this stays a per-account opt-in (default off),
    // matching the streaming-progress commentary opt-in precedent.
    agentActivity: merged.agentActivity === true,
    // Native progress is a compatibility-sensitive endpoint opt-in.
    nativeProgress: merged.nativeProgress === true,
    // Command-menu sync is best effort and current bot:write tokens include
    // commands:write, so resolved accounts default on unless explicitly disabled.
    commandMenu: merged.commandMenu !== false,
    discussions: {
      enabled: merged.discussions?.enabled === true,
      workspace: discussionsWorkspace,
      ...(controlUrlBase ? { controlUrlBase } : {}),
      section: merged.discussions?.section?.trim() || DEFAULT_DISCUSSIONS_SECTION,
    },
    requireMention: merged.requireMention === true,
    mentionPatterns: merged.mentionPatterns ?? [],
    allowBots: merged.allowBots ?? false,
    botLoopProtection: merged.botLoopProtection,
    groups: mergeClickClackGroups(merged.groups),
    config: {
      ...merged,
      allowFrom: merged.allowFrom ?? ["*"],
    },
    apiEndpoint,
  };
}

/**
 * Returns all enabled accounts, including the implicit default account when
 * legacy top-level ClickClack config is present.
 */
export function listEnabledClickClackAccounts(cfg: CoreConfig): ResolvedClickClackAccount[] {
  return listClickClackAccountIds(cfg)
    .map((accountId) => resolveClickClackAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
