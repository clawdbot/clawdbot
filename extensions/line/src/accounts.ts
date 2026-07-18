// Line plugin module implements accounts behavior.
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId as normalizeSharedAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { resolveAccountEntry } from "openclaw/plugin-sdk/account-resolution";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import type {
  LineAccountConfig,
  LineConfig,
  LineCredentialUnavailableDiagnostic,
  LineCredentialStatus,
  LineTokenSource,
  ResolvedLineAccount,
} from "./types.js";

function readCredentialFile(filePath: string, configPath: string) {
  return tryReadSecretFileSync(
    filePath,
    "LINE credential file",
    { rejectSymlink: true },
    { configPath },
  );
}

type ResolvedCredential = {
  value: string;
  source: LineTokenSource;
  status: LineCredentialStatus;
  diagnostic?: LineCredentialUnavailableDiagnostic;
};

function resolveToken(params: {
  accountId: string;
  baseConfig?: LineConfig;
  accountConfig?: LineAccountConfig;
}): ResolvedCredential {
  const { accountId, baseConfig, accountConfig } = params;

  if (accountConfig?.channelAccessToken?.trim()) {
    return {
      value: accountConfig.channelAccessToken.trim(),
      source: "config",
      status: "available",
    };
  }

  if (accountConfig?.tokenFile?.trim()) {
    const result = readCredentialFile(
      accountConfig.tokenFile,
      `channels.line.accounts.${accountId}.tokenFile`,
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

  if (accountId === DEFAULT_ACCOUNT_ID) {
    if (baseConfig?.channelAccessToken?.trim()) {
      return { value: baseConfig.channelAccessToken.trim(), source: "config", status: "available" };
    }

    if (baseConfig?.tokenFile?.trim()) {
      const result = readCredentialFile(baseConfig.tokenFile, "channels.line.tokenFile");
      return result.status === "available"
        ? { value: result.value, source: "file", status: "available" }
        : {
            value: "",
            source: "file",
            status: "configured_unavailable",
            diagnostic: result.diagnostic,
          };
    }

    const envToken = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
    if (envToken) {
      return { value: envToken, source: "env", status: "available" };
    }
  }

  return { value: "", source: "none", status: "missing" };
}

function resolveSecret(params: {
  accountId: string;
  baseConfig?: LineConfig;
  accountConfig?: LineAccountConfig;
}): ResolvedCredential {
  const { accountId, baseConfig, accountConfig } = params;

  if (accountConfig?.channelSecret?.trim()) {
    return { value: accountConfig.channelSecret.trim(), source: "config", status: "available" };
  }

  if (accountConfig?.secretFile?.trim()) {
    const result = readCredentialFile(
      accountConfig.secretFile,
      `channels.line.accounts.${accountId}.secretFile`,
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

  if (accountId === DEFAULT_ACCOUNT_ID) {
    if (baseConfig?.channelSecret?.trim()) {
      return { value: baseConfig.channelSecret.trim(), source: "config", status: "available" };
    }

    if (baseConfig?.secretFile?.trim()) {
      const result = readCredentialFile(baseConfig.secretFile, "channels.line.secretFile");
      return result.status === "available"
        ? { value: result.value, source: "file", status: "available" }
        : {
            value: "",
            source: "file",
            status: "configured_unavailable",
            diagnostic: result.diagnostic,
          };
    }

    const envSecret = process.env.LINE_CHANNEL_SECRET?.trim();
    if (envSecret) {
      return { value: envSecret, source: "env", status: "available" };
    }
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

  const token = resolveToken({
    accountId,
    baseConfig: lineConfig,
    accountConfig,
  });

  const secret = resolveSecret({
    accountId,
    baseConfig: lineConfig,
    accountConfig,
  });

  const {
    accounts: _ignoredAccounts,
    defaultAccount: _ignoredDefaultAccount,
    ...lineBase
  } = (lineConfig ?? {}) as LineConfig & {
    accounts?: unknown;
    defaultAccount?: unknown;
  };
  const mergedConfig: LineConfig & LineAccountConfig = {
    ...lineBase,
    ...accountConfig,
  };

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

export function listLineAccountIds(cfg: OpenClawConfig): string[] {
  const lineConfig = cfg.channels?.line as LineConfig | undefined;
  const accounts = lineConfig?.accounts;
  const ids = new Set<string>();

  if (
    lineConfig?.channelAccessToken?.trim() ||
    lineConfig?.tokenFile ||
    process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim()
  ) {
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
  const preferred = normalizeOptionalAccountId(
    (cfg.channels?.line as LineConfig | undefined)?.defaultAccount,
  );
  if (
    preferred &&
    listLineAccountIds(cfg).some((accountId) => normalizeSharedAccountId(accountId) === preferred)
  ) {
    return preferred;
  }
  const ids = listLineAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function normalizeAccountId(accountId: string | undefined): string {
  return normalizeSharedAccountId(accountId);
}
