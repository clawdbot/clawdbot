import {
  createAccountListHelpers,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveAccountWithDefaultFallback,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-core";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
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
  config: NextcloudTalkAccountConfig;
};

const {
  listAccountIds: listNextcloudTalkAccountIdsInternal,
  resolveDefaultAccountId: resolveDefaultNextcloudTalkAccountId,
} = createAccountListHelpers("nextcloud-talk", {
  normalizeAccountId,
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
): { secret: string; source: ResolvedNextcloudTalkAccount["secretSource"] } {
  const resolvedAccountId = opts.accountId ?? resolveDefaultNextcloudTalkAccountId(cfg);
  const merged = mergeNextcloudTalkAccountConfig(cfg, resolvedAccountId);

  const envSecret = normalizeOptionalString(process.env.NEXTCLOUD_TALK_BOT_SECRET);
  if (envSecret && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    return { secret: envSecret, source: "env" };
  }

  if (merged.botSecretFile) {
    const fileSecret = tryReadSecretFileSync(
      merged.botSecretFile,
      "Nextcloud Talk bot secret file",
      { rejectSymlink: true },
    );
    if (fileSecret) {
      return { secret: fileSecret, source: "secretFile" };
    }
  }

  const inlineSecret = normalizeResolvedSecretInputString({
    value: merged.botSecret,
    path: `channels.nextcloud-talk.accounts.${resolvedAccountId}.botSecret`,
  });
  if (inlineSecret) {
    return { secret: inlineSecret, source: "config" };
  }

  return { secret: "", source: "none" };
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
      config: merged,
    } satisfies ResolvedNextcloudTalkAccount;
  };

  return resolveAccountWithDefaultFallback({
    accountId: resolvedAccountId,
    normalizeAccountId,
    resolvePrimary: resolve,
    hasCredential: (account) => account.secretSource !== "none",
    resolveDefaultAccountId: () => resolveDefaultNextcloudTalkAccountId(params.cfg),
  });
}

export function listEnabledNextcloudTalkAccounts(cfg: CoreConfig): ResolvedNextcloudTalkAccount[] {
  return listNextcloudTalkAccountIds(cfg)
    .map((accountId) => resolveNextcloudTalkAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
