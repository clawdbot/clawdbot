// Googlechat plugin module implements accounts behavior.
import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type OpenClawConfig,
  resolveAccountEntry,
} from "openclaw/plugin-sdk/account-resolution";
import { safeParseJsonWithSchema, safeParseWithSchema } from "openclaw/plugin-sdk/extension-shared";
import { mergePairLoopGuardConfig } from "openclaw/plugin-sdk/pair-loop-guard-runtime";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import {
  coerceSecretRef,
  isSecretRef,
  resolveSecretInputString,
  type SecretInputStringResolutionMode,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";
import { z } from "zod";
import { MAX_GOOGLE_CHAT_SERVICE_ACCOUNT_FILE_BYTES } from "./google-auth-limits.js";
import type { GoogleChatAccountConfig } from "./types.config.js";

type CredentialUnavailableDiagnostic = Extract<
  ReturnType<typeof tryReadSecretFileSync>,
  { status: "configured_unavailable" }
>["diagnostic"];

type GoogleChatCredentialSource = "file" | "inline" | "env" | "none";

export type ResolvedGoogleChatAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: GoogleChatAccountConfig;
  credentialSource: GoogleChatCredentialSource;
  credentials?: Record<string, unknown>;
  credentialsFile?: string;
  tokenStatus?: "available" | "configured_unavailable" | "missing";
  credentialDiagnostics?: CredentialUnavailableDiagnostic[];
};

export type GoogleChatConfigAccessorAccount = {
  config: GoogleChatAccountConfig;
};

const ENV_SERVICE_ACCOUNT = "GOOGLE_CHAT_SERVICE_ACCOUNT";
const ENV_SERVICE_ACCOUNT_FILE = "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE";
const JsonRecordSchema = z.record(z.string(), z.unknown());

const {
  listAccountIds: listGoogleChatAccountIds,
  resolveDefaultAccountId: resolveDefaultGoogleChatAccountId,
  resolveAccountConfig: resolveMergedGoogleChatAccountConfig,
} = createAccountListHelpers<GoogleChatAccountConfig>("googlechat", {
  implicitDefaultAccount: {
    channelKeys: ["serviceAccount", "serviceAccountFile"],
    envVars: [ENV_SERVICE_ACCOUNT, ENV_SERVICE_ACCOUNT_FILE],
  },
  omitKeys: ["defaultAccount"],
  nestedObjectKeys: ["botLoopProtection"],
});
export { listGoogleChatAccountIds, resolveDefaultGoogleChatAccountId };

function mergeGoogleChatAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): GoogleChatAccountConfig {
  const raw = cfg.channels?.["googlechat"] ?? {};
  const base = resolveMergedGoogleChatAccountConfig(cfg, accountId);
  const defaultAccountConfig = resolveAccountEntry(raw.accounts, DEFAULT_ACCOUNT_ID) ?? {};
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return base;
  }
  const {
    enabled: _ignoredEnabled,
    dangerouslyAllowNameMatching: _ignoredDangerouslyAllowNameMatching,
    serviceAccount: _ignoredServiceAccount,
    serviceAccountFile: _ignoredServiceAccountFile,
    ...defaultAccountShared
  } = defaultAccountConfig;
  // In multi-account setups, allow accounts.default to provide shared defaults
  // (for example webhook/audience fields) while preserving top-level and account overrides.
  const botLoopProtection = mergePairLoopGuardConfig(
    defaultAccountShared.botLoopProtection,
    base.botLoopProtection,
  );
  return {
    ...defaultAccountShared,
    ...base,
    ...(botLoopProtection ? { botLoopProtection } : {}),
  } as GoogleChatAccountConfig;
}

export function resolveGoogleChatConfigAccessorAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): GoogleChatConfigAccessorAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? params.cfg.channels?.googlechat?.defaultAccount,
  );
  return { config: mergeGoogleChatAccountConfig(params.cfg, accountId) };
}

function parseServiceAccount(value: unknown): Record<string, unknown> | null {
  if (isSecretRef(value)) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return safeParseJsonWithSchema(JsonRecordSchema, trimmed);
  }

  return safeParseWithSchema(JsonRecordSchema, value);
}

function resolveCredentialsFromConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  account: GoogleChatAccountConfig;
  mode: SecretInputStringResolutionMode;
}): {
  credentials?: Record<string, unknown>;
  credentialsFile?: string;
  source: GoogleChatCredentialSource;
  status: "available" | "configured_unavailable" | "missing";
  diagnostic?: CredentialUnavailableDiagnostic;
} {
  const { account, accountId } = params;
  const inline = parseServiceAccount(account.serviceAccount);
  if (inline) {
    return { credentials: inline, source: "inline", status: "available" };
  }

  const serviceAccountRef = coerceSecretRef(account.serviceAccount, params.cfg.secrets?.defaults);
  if (serviceAccountRef) {
    const resolved = resolveSecretInputString({
      value: account.serviceAccount,
      defaults: params.cfg.secrets?.defaults,
      path: `channels.googlechat.accounts.${accountId}.serviceAccount`,
      mode: params.mode,
    });
    return resolved.status === "configured_unavailable"
      ? { source: "none", status: "configured_unavailable" }
      : { source: "none", status: "missing" };
  }

  const file = normalizeOptionalString(account.serviceAccountFile);
  if (file) {
    const resolvedFile = resolveUserPath(file);
    const result = tryReadSecretFileSync(
      resolvedFile,
      "Google Chat service account file",
      {
        maxBytes: MAX_GOOGLE_CHAT_SERVICE_ACCOUNT_FILE_BYTES,
        rejectHardlinks: false,
        rejectSymlink: false,
      },
      { configPath: `channels.googlechat.accounts.${accountId}.serviceAccountFile` },
    );
    return result.status === "available"
      ? { credentialsFile: file, source: "file", status: "available" }
      : {
          credentialsFile: file,
          source: "file",
          status: "configured_unavailable",
          diagnostic: result.diagnostic,
        };
  }

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envJson = process.env[ENV_SERVICE_ACCOUNT];
    const envInline = parseServiceAccount(envJson);
    if (envInline) {
      return { credentials: envInline, source: "env", status: "available" };
    }
    const envFile = normalizeOptionalString(process.env[ENV_SERVICE_ACCOUNT_FILE]);
    if (envFile) {
      const resolvedEnvFile = resolveUserPath(envFile);
      const result = tryReadSecretFileSync(
        resolvedEnvFile,
        "Google Chat service account file",
        {
          maxBytes: MAX_GOOGLE_CHAT_SERVICE_ACCOUNT_FILE_BYTES,
          rejectHardlinks: false,
          rejectSymlink: false,
        },
        { configPath: `env.${ENV_SERVICE_ACCOUNT_FILE}` },
      );
      return result.status === "available"
        ? { credentialsFile: envFile, source: "env", status: "available" }
        : {
            credentialsFile: envFile,
            source: "env",
            status: "configured_unavailable",
            diagnostic: result.diagnostic,
          };
    }
  }

  return { source: "none", status: "missing" };
}

function resolveGoogleChatAccountWithMode(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  mode: SecretInputStringResolutionMode;
}): ResolvedGoogleChatAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? params.cfg.channels?.["googlechat"]?.defaultAccount,
  );
  const baseEnabled = params.cfg.channels?.["googlechat"]?.enabled !== false;
  const merged = mergeGoogleChatAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const credentials = resolveCredentialsFromConfig({
    cfg: params.cfg,
    accountId,
    account: merged,
    mode: params.mode,
  });

  return {
    accountId,
    name: normalizeOptionalString(merged.name),
    enabled,
    config: merged,
    credentialSource: credentials.source,
    credentials: credentials.credentials,
    credentialsFile: credentials.credentialsFile,
    tokenStatus: credentials.status,
    ...(credentials.diagnostic ? { credentialDiagnostics: [credentials.diagnostic] } : {}),
  };
}

export function resolveGoogleChatAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedGoogleChatAccount {
  return resolveGoogleChatAccountWithMode({ ...params, mode: "strict" });
}

export function inspectGoogleChatAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  const account = resolveGoogleChatAccountWithMode({ ...params, mode: "inspect" });
  return {
    ...account,
    configured: isGoogleChatAccountConfigured(account),
    audienceType: account.config.audienceType,
    audience: account.config.audience,
    webhookPath: account.config.webhookPath,
    webhookUrl: account.config.webhookUrl,
    dmPolicy: account.config.dmPolicy ?? "pairing",
  };
}

export function isGoogleChatAccountConfigured(account: ResolvedGoogleChatAccount): boolean {
  return account.tokenStatus
    ? account.tokenStatus !== "missing"
    : account.credentialSource !== "none";
}
