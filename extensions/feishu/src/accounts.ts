// Feishu plugin module implements accounts behavior.
import {
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig as ClawdbotConfig,
  createAccountListHelpers,
  hasConfiguredAccountValue,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-resolution";
import { coerceSecretRef } from "openclaw/plugin-sdk/provider-auth";
import { canResolveEnvSecretRefInReadOnlyPath } from "openclaw/plugin-sdk/secret-ref-readonly";
import { normalizeOptionalString as normalizeString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  FeishuConfig,
  FeishuAccountConfig,
  FeishuDefaultAccountSelectionSource,
  FeishuDomain,
  ResolvedFeishuAccount,
} from "./types.js";

const {
  listAccountIds: listFeishuAccountIds,
  resolveDefaultAccountId,
  resolveAccountConfig: resolveMergedFeishuAccountConfig,
} = createAccountListHelpers<FeishuConfig>("feishu", {
  allowUnlistedDefaultAccount: true,
  omitKeys: ["defaultAccount"],
  nestedObjectKeys: ["tools"],
  hasImplicitDefaultAccount: (cfg) => {
    const feishu = cfg.channels?.feishu;
    return hasConfiguredAccountValue(feishu?.appId) && hasConfiguredAccountValue(feishu?.appSecret);
  },
});

export { listFeishuAccountIds };

type FeishuCredentialResolutionMode = "inspect" | "strict";
type FeishuResolvedSecretRef = NonNullable<ReturnType<typeof coerceSecretRef>>;

function formatSecretRefLabel(ref: FeishuResolvedSecretRef): string {
  return `${ref.source}:${ref.provider}:${ref.id}`;
}

export class FeishuSecretRefUnavailableError extends Error {
  path: string;

  constructor(path: string, ref: FeishuResolvedSecretRef) {
    super(
      `${path}: unresolved SecretRef "${formatSecretRefLabel(ref)}". ` +
        "Resolve this command against an active gateway runtime snapshot before reading it.",
    );
    this.name = "FeishuSecretRefUnavailableError";
    this.path = path;
  }
}

function resolveFeishuSecretLike(params: {
  cfg?: ClawdbotConfig;
  value: unknown;
  path: string;
  mode: FeishuCredentialResolutionMode;
}): string | undefined {
  const asString = normalizeString(params.value);
  if (asString) {
    return asString;
  }

  const ref = coerceSecretRef(params.value, params.cfg?.secrets?.defaults);
  if (!ref) {
    return undefined;
  }

  if (params.mode === "inspect") {
    if (
      ref.source === "env" &&
      canResolveEnvSecretRefInReadOnlyPath({
        cfg: params.cfg,
        provider: ref.provider,
        id: ref.id,
      })
    ) {
      return normalizeString(process.env[ref.id]);
    }
    return undefined;
  }

  throw new FeishuSecretRefUnavailableError(params.path, ref);
}

function resolveFeishuBaseCredentials(
  cfg: FeishuConfig | undefined,
  mode: FeishuCredentialResolutionMode,
  rootConfig?: ClawdbotConfig,
): {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
} | null {
  const appId = resolveFeishuSecretLike({
    cfg: rootConfig,
    value: cfg?.appId,
    path: "channels.feishu.appId",
    mode,
  });
  const appSecret = resolveFeishuSecretLike({
    cfg: rootConfig,
    value: cfg?.appSecret,
    path: "channels.feishu.appSecret",
    mode,
  });

  if (!appId || !appSecret) {
    return null;
  }

  return {
    appId,
    appSecret,
    domain: cfg?.domain ?? "feishu",
  };
}

function resolveFeishuEventSecrets(
  cfg: FeishuConfig | undefined,
  mode: FeishuCredentialResolutionMode,
  rootConfig?: ClawdbotConfig,
): {
  encryptKey?: string;
  verificationToken?: string;
} {
  return {
    encryptKey:
      (cfg?.connectionMode ?? "websocket") === "webhook"
        ? resolveFeishuSecretLike({
            cfg: rootConfig,
            value: cfg?.encryptKey,
            path: "channels.feishu.encryptKey",
            mode,
          })
        : normalizeString(cfg?.encryptKey),
    verificationToken: resolveFeishuSecretLike({
      cfg: rootConfig,
      value: cfg?.verificationToken,
      path: "channels.feishu.verificationToken",
      mode,
    }),
  };
}

/**
 * Resolve the default account selection and its source.
 */
export function resolveDefaultFeishuAccountSelection(cfg: ClawdbotConfig): {
  accountId: string;
  source: FeishuDefaultAccountSelectionSource;
} {
  const preferred = normalizeOptionalAccountId(
    (cfg.channels?.feishu as FeishuConfig | undefined)?.defaultAccount,
  );
  if (preferred) {
    return {
      accountId: preferred,
      source: "explicit-default",
    };
  }
  const ids = listFeishuAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return {
      accountId: DEFAULT_ACCOUNT_ID,
      source: "mapped-default",
    };
  }
  return {
    accountId: ids[0] ?? DEFAULT_ACCOUNT_ID,
    source: "fallback",
  };
}

/**
 * Resolve the default account ID.
 */
export function resolveDefaultFeishuAccountId(cfg: ClawdbotConfig): string {
  return resolveDefaultAccountId(cfg);
}

/**
 * Merge top-level config with account-specific config.
 * Account-specific fields override top-level fields.
 */
function mergeFeishuAccountConfig(cfg: ClawdbotConfig, accountId: string): FeishuConfig {
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  const merged = resolveMergedFeishuAccountConfig(cfg, accountId);
  const topTools = feishuCfg?.tools;
  if (merged.tools === undefined && topTools !== undefined) {
    return { ...merged, tools: topTools };
  }
  if (topTools?.bitable === false) {
    return {
      ...merged,
      tools: {
        ...merged.tools,
        bitable: false,
      },
    };
  }
  return merged;
}

/**
 * Resolve Feishu credentials from a config.
 */
export function resolveFeishuCredentials(
  cfg?: FeishuConfig,
  options?: { mode?: FeishuCredentialResolutionMode; rootConfig?: ClawdbotConfig },
): {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
} | null {
  const mode = options?.mode ?? "strict";
  const base = resolveFeishuBaseCredentials(cfg, mode, options?.rootConfig);
  if (!base) {
    return null;
  }
  const eventSecrets = resolveFeishuEventSecrets(cfg, mode, options?.rootConfig);

  return {
    ...base,
    ...eventSecrets,
  };
}

export function inspectFeishuCredentials(cfg?: FeishuConfig, rootConfig?: ClawdbotConfig) {
  return resolveFeishuCredentials(cfg, { mode: "inspect", rootConfig });
}

function buildResolvedFeishuAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
  baseMode: FeishuCredentialResolutionMode;
  eventSecretMode: FeishuCredentialResolutionMode;
}): ResolvedFeishuAccount {
  const hasExplicitAccountId =
    typeof params.accountId === "string" && params.accountId.trim() !== "";
  const defaultSelection = hasExplicitAccountId
    ? null
    : resolveDefaultFeishuAccountSelection(params.cfg);
  const accountId = hasExplicitAccountId
    ? normalizeAccountId(params.accountId)
    : (defaultSelection?.accountId ?? DEFAULT_ACCOUNT_ID);
  const selectionSource = hasExplicitAccountId
    ? "explicit"
    : (defaultSelection?.source ?? "fallback");
  const feishuCfg = params.cfg.channels?.feishu as FeishuConfig | undefined;

  const baseEnabled = feishuCfg?.enabled !== false;
  const merged = mergeFeishuAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const baseCreds = resolveFeishuBaseCredentials(merged, params.baseMode, params.cfg);
  const eventSecrets = resolveFeishuEventSecrets(merged, params.eventSecretMode, params.cfg);
  const accountName = (merged as FeishuAccountConfig).name;

  return {
    accountId,
    selectionSource,
    enabled,
    configured: Boolean(baseCreds),
    name: typeof accountName === "string" ? accountName.trim() || undefined : undefined,
    appId: baseCreds?.appId,
    appSecret: baseCreds?.appSecret,
    encryptKey: eventSecrets.encryptKey,
    verificationToken: eventSecrets.verificationToken,
    domain: baseCreds?.domain ?? "feishu",
    config: merged,
  };
}

/**
 * Resolve a read-only Feishu account snapshot for CLI/config surfaces.
 * Unresolved SecretRefs are treated as unavailable instead of throwing.
 */
export function resolveFeishuAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedFeishuAccount {
  return buildResolvedFeishuAccount({
    ...params,
    baseMode: "inspect",
    eventSecretMode: "inspect",
  });
}

/**
 * Resolve a runtime Feishu account.
 * Required app credentials stay strict; event-only secrets can be required by callers.
 */
export function resolveFeishuRuntimeAccount(
  params: {
    cfg: ClawdbotConfig;
    accountId?: string | null;
  },
  options?: { requireEventSecrets?: boolean },
): ResolvedFeishuAccount {
  return buildResolvedFeishuAccount({
    ...params,
    baseMode: "strict",
    eventSecretMode: options?.requireEventSecrets ? "strict" : "inspect",
  });
}

/**
 * List all enabled and configured accounts.
 */
export function listEnabledFeishuAccounts(cfg: ClawdbotConfig): ResolvedFeishuAccount[] {
  return listFeishuAccountIds(cfg)
    .map((accountId) => resolveFeishuAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
}
