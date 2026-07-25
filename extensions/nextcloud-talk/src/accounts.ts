// Nextcloud Talk plugin module implements accounts behavior.
import {
  createAccountListHelpers,
  DEFAULT_ACCOUNT_ID,
  hasConfiguredAccountValue,
  normalizeAccountId,
  resolveAccountWithDefaultFallback,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-core";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveNextcloudTalkApiCredentialsResult,
  type NextcloudTalkCredentialUnavailableDiagnostic,
} from "./api-credentials.js";
import { normalizeResolvedSecretInputString } from "./secret-input.js";
import type { CoreConfig, NextcloudTalkAccountConfig } from "./types.js";

function isTruthyEnvValue(value?: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

const debugAccounts = (...args: unknown[]) => {
  if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_NEXTCLOUD_TALK_ACCOUNTS)) {
    console.warn("[nextcloud-talk:accounts]", ...args);
  }
};

export type ResolvedNextcloudTalkAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl: string;
  secret: string;
  secretSource: "env" | "secretFile" | "config" | "none";
  tokenStatus?: "available" | "configured_unavailable" | "missing";
  apiCredentialStatus?: "available" | "configured_unavailable" | "missing";
  credentialDiagnostics?: NextcloudTalkCredentialUnavailableDiagnostic[];
  config: NextcloudTalkAccountConfig;
};

const {
  listAccountIds: listNextcloudTalkAccountIdsInternal,
  resolveDefaultAccountId: resolveDefaultNextcloudTalkAccountId,
} = createAccountListHelpers("nextcloud-talk", {
  normalizeAccountId,
  hasImplicitDefaultAccount: (cfg) => {
    const channel = cfg.channels?.["nextcloud-talk"];
    return Boolean(
      channel?.baseUrl?.trim() &&
      (hasConfiguredAccountValue(channel.botSecret) ||
        channel.botSecretFile?.trim() ||
        process.env.NEXTCLOUD_TALK_BOT_SECRET?.trim()),
    );
  },
});
export { resolveDefaultNextcloudTalkAccountId };

export function listNextcloudTalkAccountIds(cfg: CoreConfig): string[] {
  const ids = listNextcloudTalkAccountIdsInternal(cfg);
  debugAccounts("listNextcloudTalkAccountIds", ids);
  return ids;
}

function mergeNextcloudTalkAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): NextcloudTalkAccountConfig {
  return resolveMergedAccountConfig<NextcloudTalkAccountConfig>({
    channelConfig: cfg.channels?.["nextcloud-talk"] as NextcloudTalkAccountConfig | undefined,
    accounts: cfg.channels?.["nextcloud-talk"]?.accounts as
      | Record<string, Partial<NextcloudTalkAccountConfig>>
      | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
    normalizeAccountId,
  });
}

function resolveNextcloudTalkSecret(
  cfg: CoreConfig,
  opts: { accountId?: string },
): {
  secret: string;
  source: ResolvedNextcloudTalkAccount["secretSource"];
  status: "available" | "configured_unavailable" | "missing";
  diagnostic?: NextcloudTalkCredentialUnavailableDiagnostic;
} {
  const resolvedAccountId = opts.accountId ?? resolveDefaultNextcloudTalkAccountId(cfg);
  const merged = mergeNextcloudTalkAccountConfig(cfg, resolvedAccountId);

  const envSecret = normalizeOptionalString(process.env.NEXTCLOUD_TALK_BOT_SECRET);
  if (envSecret && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    return { secret: envSecret, source: "env", status: "available" };
  }

  const botSecretFile = normalizeOptionalString(merged.botSecretFile);
  if (botSecretFile) {
    const result = tryReadSecretFileSync(
      botSecretFile,
      "Nextcloud Talk bot secret file",
      { rejectSymlink: true },
      { configPath: `channels.nextcloud-talk.accounts.${resolvedAccountId}.botSecretFile` },
    );
    return result.status === "available"
      ? { secret: result.value, source: "secretFile", status: "available" }
      : {
          secret: "",
          source: "secretFile",
          status: "configured_unavailable",
          diagnostic: result.diagnostic,
        };
  }

  const inlineSecret = normalizeResolvedSecretInputString({
    value: merged.botSecret,
    path: `channels.nextcloud-talk.accounts.${resolvedAccountId}.botSecret`,
  });
  if (inlineSecret) {
    return { secret: inlineSecret, source: "config", status: "available" };
  }

  return { secret: "", source: "none", status: "missing" };
}

export function resolveNextcloudTalkAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedNextcloudTalkAccount {
  const baseEnabled = params.cfg.channels?.["nextcloud-talk"]?.enabled !== false;
  const resolvedAccountId = params.accountId ?? resolveDefaultNextcloudTalkAccountId(params.cfg);

  const resolve = (accountId: string) => {
    const merged = mergeNextcloudTalkAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const secretResolution = resolveNextcloudTalkSecret(params.cfg, { accountId });
    const apiCredentialResolution = resolveNextcloudTalkApiCredentialsResult({
      apiUser: merged.apiUser,
      apiPassword: merged.apiPassword,
      apiPasswordFile: merged.apiPasswordFile,
      configPath: `channels.nextcloud-talk.accounts.${accountId}.apiPasswordFile`,
    });
    const diagnostics = [
      secretResolution.diagnostic,
      apiCredentialResolution.status === "configured_unavailable"
        ? apiCredentialResolution.diagnostic
        : undefined,
    ].filter((diagnostic): diagnostic is NextcloudTalkCredentialUnavailableDiagnostic =>
      Boolean(diagnostic),
    );
    const baseUrl = merged.baseUrl?.trim()?.replace(/\/$/, "") ?? "";

    debugAccounts("resolve", {
      accountId,
      enabled,
      secretSource: secretResolution.source,
      baseUrl: baseUrl ? "[set]" : "[missing]",
    });

    return {
      accountId,
      enabled,
      name: normalizeOptionalString(merged.name),
      baseUrl,
      secret: secretResolution.secret,
      secretSource: secretResolution.source,
      tokenStatus: secretResolution.status,
      apiCredentialStatus: apiCredentialResolution.status,
      ...(diagnostics.length > 0 ? { credentialDiagnostics: diagnostics } : {}),
      config: merged,
    } satisfies ResolvedNextcloudTalkAccount;
  };

  return resolveAccountWithDefaultFallback({
    accountId: resolvedAccountId,
    normalizeAccountId,
    resolvePrimary: resolve,
    hasCredential: (account) => account.tokenStatus !== "missing",
    resolveDefaultAccountId: () => resolveDefaultNextcloudTalkAccountId(params.cfg),
  });
}
