import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
// Line plugin module implements accounts behavior.
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId as normalizeSharedAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";
import {
  resolveAccountEntry,
  resolveListedDefaultAccountId,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import {
  hasConfiguredSecretInput,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  LineAccountConfig,
  LineConfig,
  LineCredentialUnavailableDiagnostic,
  LineCredentialStatus,
  LineTokenSource,
  ResolvedLineAccount,
} from "./types.js";

const { resolveAccountConfig: resolveMergedLineAccountConfig } = createAccountListHelpers<
  Record<string, unknown> & LineConfig
>("line", {
  omitKeys: ["defaultAccount"],
});

type ResolvedCredential = {
  value: string;
  source: LineTokenSource;
  status: LineCredentialStatus;
  diagnostic?: LineCredentialUnavailableDiagnostic;
};

function resolveLineCredential(params: {
  accountId: string;
  baseConfig?: LineConfig;
  accountConfig?: LineAccountConfig;
  credentialKey: "channelAccessToken" | "channelSecret";
  fileKey: "tokenFile" | "secretFile";
  envKey: "LINE_CHANNEL_ACCESS_TOKEN" | "LINE_CHANNEL_SECRET";
}): ResolvedCredential {
  const { accountId, baseConfig, accountConfig, credentialKey, fileKey, envKey } = params;
  const candidates =
    accountId === DEFAULT_ACCOUNT_ID ? [accountConfig, baseConfig] : [accountConfig];

  for (const [index, config] of candidates.entries()) {
    const scope = index === 0 ? `accounts.${accountId}.` : "";
    const credential = resolveSecretInputString({
      value: config?.[credentialKey],
      path: `channels.line.${scope}${credentialKey}`,
      mode: "inspect",
    });
    if (credential.status === "available") {
      return { value: credential.value, source: "config", status: "available" };
    }
    // A configured reference owns this credential even while the runtime has not resolved it:
    // falling through would authenticate with a different credential than the operator named.
    if (credential.status === "configured_unavailable") {
      return { value: "", source: "config", status: "configured_unavailable" };
    }
    const file = config?.[fileKey];
    if (file?.trim()) {
      const result = tryReadSecretFileSync(
        file,
        "LINE credential file",
        { rejectSymlink: true },
        { configPath: `channels.line.${scope}${fileKey}` },
      );
      return result.status === "available"
        ? { value: result.value, source: "file", status: "available" }
        : {
            value: "",
            source: "file",
            status: "configured_unavailable",
            diagnostic: result.diagnostic,
          };
    }
  }

  const envCredential = accountId === DEFAULT_ACCOUNT_ID ? process.env[envKey]?.trim() : undefined;
  if (envCredential) {
    return { value: envCredential, source: "env", status: "available" };
  }
  return { value: "", source: "none", status: "missing" };
}

export function resolveLineAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedLineAccount {
  const cfg = params.cfg;
  const accountId = normalizeSharedAccountId(params.accountId ?? resolveDefaultLineAccountId(cfg));
  const lineConfig = cfg.channels?.line as LineConfig | undefined;
  const accounts = lineConfig?.accounts;
  const accountConfig = resolveAccountEntry(accounts, accountId);

  const token = resolveLineCredential({
    accountId,
    baseConfig: lineConfig,
    accountConfig,
    credentialKey: "channelAccessToken",
    fileKey: "tokenFile",
    envKey: "LINE_CHANNEL_ACCESS_TOKEN",
  });

  const secret = resolveLineCredential({
    accountId,
    baseConfig: lineConfig,
    accountConfig,
    credentialKey: "channelSecret",
    fileKey: "secretFile",
    envKey: "LINE_CHANNEL_SECRET",
  });

  const mergedConfig: LineConfig & LineAccountConfig = resolveMergedLineAccountConfig(
    cfg,
    accountId,
  );

  const baseEnabled = lineConfig?.enabled !== false;
  const accountEnabled = accountConfig?.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const name =
    accountConfig?.name ?? (accountId === DEFAULT_ACCOUNT_ID ? lineConfig?.name : undefined);

  return {
    accountId,
    name,
    enabled,
    channelAccessToken: token.value,
    channelSecret: secret.value,
    tokenSource: token.source,
    signingSecretSource: secret.source,
    tokenStatus: token.status,
    signingSecretStatus: secret.status,
    ...([token.diagnostic, secret.diagnostic].some(Boolean)
      ? {
          credentialDiagnostics: [token.diagnostic, secret.diagnostic].filter(
            (diagnostic): diagnostic is LineCredentialUnavailableDiagnostic => Boolean(diagnostic),
          ),
        }
      : {}),
    config: mergedConfig,
  };
}

/**
 * Whether the channel root admits a default account. Only the access token does that; a
 * root-level signing secret alone never adds one, so it would have no account to serve.
 */
export function channelRootAdmitsDefaultLineAccount(params: {
  config: { channelAccessToken?: unknown; tokenFile?: unknown } | undefined;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = params.env ?? process.env;
  return (
    hasConfiguredSecretInput(params.config?.channelAccessToken) ||
    Boolean(normalizeOptionalString(params.config?.tokenFile)) ||
    Boolean(normalizeOptionalString(env.LINE_CHANNEL_ACCESS_TOKEN))
  );
}

export function listLineAccountIds(cfg: OpenClawConfig): string[] {
  const lineConfig = cfg.channels?.line as LineConfig | undefined;
  const accounts = lineConfig?.accounts;
  const ids = new Set<string>();

  if (channelRootAdmitsDefaultLineAccount({ config: lineConfig })) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  if (accounts) {
    for (const id of Object.keys(accounts)) {
      ids.add(id);
    }
  }

  return Array.from(ids);
}

export function resolveDefaultLineAccountId(cfg: OpenClawConfig): string {
  return resolveListedDefaultAccountId({
    accountIds: listLineAccountIds(cfg),
    configuredDefaultAccountId: normalizeOptionalAccountId(
      (cfg.channels?.line as LineConfig | undefined)?.defaultAccount,
    ),
    normalizeListedAccountId: normalizeSharedAccountId,
  });
}

export function normalizeAccountId(accountId: string | undefined): string {
  return normalizeSharedAccountId(accountId);
}
