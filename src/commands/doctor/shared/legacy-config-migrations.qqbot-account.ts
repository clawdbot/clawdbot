// Account and credential migrations for the Tencent QQBot 2.0 cutover.
import { getRecord } from "../../../config/legacy.shared.js";
import { isBlockedObjectKey } from "../../../infra/prototype-keys.js";

export function hasOwnKey(target: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(target, key);
}

function hasEnvironmentValue(name: "QQBOT_APP_ID" | "QQBOT_CLIENT_SECRET"): boolean {
  return Boolean(process.env[name]?.trim());
}

export function shouldCreateEnvironmentOnlyQQBotConfig(raw: Record<string, unknown>): boolean {
  const channels = getRecord(raw.channels);
  return Boolean(
    (raw.channels === undefined || channels) &&
    !getRecord(channels?.qqbot) &&
    hasEnvironmentValue("QQBOT_APP_ID") &&
    hasEnvironmentValue("QQBOT_CLIENT_SECRET"),
  );
}

export function listQQBotConfigEntries(qqbot: Record<string, unknown>): Array<{
  entry: Record<string, unknown>;
  path: string;
  aliasSuffix?: string;
  inheritedEntry?: Record<string, unknown>;
}> {
  // The legacy default account merged channels.qqbot with accounts.default.
  // Snapshot the root before migration so account overrides are evaluated
  // against the policy users actually had before the root entry is rewritten.
  const rootSnapshot = structuredClone(qqbot);
  const entries: Array<{
    entry: Record<string, unknown>;
    path: string;
    aliasSuffix?: string;
    inheritedEntry?: Record<string, unknown>;
  }> = [{ entry: qqbot, path: "channels.qqbot" }];
  const accounts = getRecord(qqbot.accounts);
  if (!accounts) {
    return entries;
  }
  for (const [accountId, accountValue] of Object.entries(accounts)) {
    const account = getRecord(accountValue);
    if (account) {
      entries.push({
        entry: account,
        path: `channels.qqbot.accounts.${accountId}`,
        aliasSuffix: accountId,
        inheritedEntry: accountId === "default" ? rootSnapshot : undefined,
      });
    }
  }
  return entries;
}

export function migrateDefaultAccount(qqbot: Record<string, unknown>, changes: string[]): void {
  const accounts = getRecord(qqbot.accounts);
  const configuredDefaultAccount =
    typeof qqbot.defaultAccount === "string" ? qqbot.defaultAccount.trim() : "";
  const normalizedDefaultAccount = configuredDefaultAccount.toLowerCase();
  const defaultAccount = getRecord(accounts?.default);
  if (configuredDefaultAccount && normalizedDefaultAccount !== "default") {
    // The bundled plugin lowercased defaultAccount before lookup. Preserve that
    // exact selection rule so case-colliding account credentials cannot switch.
    const selectedAccountId = normalizedDefaultAccount;
    const selectedAccount = getRecord(accounts?.[selectedAccountId]);
    if (!selectedAccount) {
      delete qqbot.defaultAccount;
      changes.push(
        `Removed invalid channels.qqbot.defaultAccount=${configuredDefaultAccount}; the bundled plugin already fell back to its normal account selection order.`,
      );
      return;
    }
    if (qqbot.appId || hasEnvironmentValue("QQBOT_APP_ID") || defaultAccount) {
      // Tencent cannot select a named account while retaining a distinct root
      // default account. Leave the selector for the host schema to fail closed.
      return;
    }
    const reorderedAccounts: Record<string, unknown> = {
      [selectedAccountId]: selectedAccount,
    };
    for (const [accountId, account] of Object.entries(accounts ?? {})) {
      if (accountId !== selectedAccountId && !isBlockedObjectKey(accountId)) {
        reorderedAccounts[accountId] = account;
      }
    }
    // Integer-index keys enumerate before ordinary keys regardless of insertion
    // order. Keep defaultAccount so host validation fails closed instead of
    // silently switching Tencent 2.0 to a different account.
    if (Object.keys(reorderedAccounts)[0] !== selectedAccountId) {
      return;
    }
    qqbot.accounts = reorderedAccounts;
    delete qqbot.defaultAccount;
    changes.push(
      `Moved channels.qqbot.accounts.${selectedAccountId} to the first account position and removed defaultAccount so Tencent QQBot 2.0 preserves the selected named default.`,
    );
    return;
  }
  if (!accounts || !defaultAccount) {
    if (hasOwnKey(qqbot, "defaultAccount")) {
      delete qqbot.defaultAccount;
      changes.push(
        "Removed channels.qqbot.defaultAccount=default because Tencent QQBot 2.0 selects the root account directly.",
      );
    }
    return;
  }
  // The bundled plugin overlaid accounts.default on the root account. Tencent
  // 2.0 reads the default account only from the root, so flatten before runtime.
  for (const [key, value] of Object.entries(defaultAccount)) {
    if (key !== "accounts" && !isBlockedObjectKey(key)) {
      qqbot[key] = value;
    }
  }
  delete accounts.default;
  if (Object.keys(accounts).length === 0) {
    delete qqbot.accounts;
  }
  delete qqbot.defaultAccount;
  changes.push(
    "Moved channels.qqbot.accounts.default overrides to channels.qqbot for Tencent QQBot 2.0 default-account resolution.",
  );
}

function normalizeProviderAliasSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "account";
}

function isMatchingFileProvider(value: unknown, filePath: string): boolean {
  const provider = getRecord(value);
  return Boolean(
    provider &&
    provider.source === "file" &&
    provider.path === filePath &&
    provider.mode === "singleValue",
  );
}

function allocateFileProviderAlias(params: {
  raw: Record<string, unknown>;
  filePath: string;
  aliasSuffix?: string;
}): string | undefined {
  let secrets = getRecord(params.raw.secrets);
  if (!secrets) {
    if (params.raw.secrets !== undefined) {
      return undefined;
    }
    secrets = {};
    params.raw.secrets = secrets;
  }
  let providers = getRecord(secrets.providers);
  if (!providers) {
    if (secrets.providers !== undefined) {
      return undefined;
    }
    providers = {};
    secrets.providers = providers;
  }
  const suffix = params.aliasSuffix ? `-${normalizeProviderAliasSegment(params.aliasSuffix)}` : "";
  const base = `qqbot${suffix}-client-secret`.slice(0, 60).replace(/-+$/g, "");
  for (let index = 1; index <= 999; index += 1) {
    const alias = index === 1 ? base : `${base.slice(0, 60 - String(index).length)}-${index}`;
    const existing = providers[alias];
    if (existing === undefined) {
      providers[alias] = {
        source: "file",
        path: params.filePath,
        mode: "singleValue",
      };
      return alias;
    }
    if (isMatchingFileProvider(existing, params.filePath)) {
      return alias;
    }
  }
  return undefined;
}

export function migrateClientSecretFile(params: {
  raw: Record<string, unknown>;
  entry: Record<string, unknown>;
  path: string;
  aliasSuffix?: string;
  changes: string[];
}): void {
  if (!hasOwnKey(params.entry, "clientSecretFile")) {
    return;
  }
  if (params.entry.clientSecret !== undefined) {
    delete params.entry.clientSecretFile;
    params.changes.push(
      `Removed ${params.path}.clientSecretFile (${params.path}.clientSecret already set).`,
    );
    return;
  }
  const filePath =
    typeof params.entry.clientSecretFile === "string" ? params.entry.clientSecretFile.trim() : "";
  if (!filePath) {
    params.entry.enabled = false;
    delete params.entry.clientSecretFile;
    params.changes.push(
      `Removed invalid ${params.path}.clientSecretFile and disabled this QQBot account.`,
    );
    return;
  }
  const provider = allocateFileProviderAlias({
    raw: params.raw,
    filePath,
    aliasSuffix: params.aliasSuffix,
  });
  if (!provider) {
    params.entry.enabled = false;
    params.changes.push(
      `Disabled ${params.path} because its clientSecretFile could not be migrated while secrets.providers has an incompatible shape.`,
    );
    return;
  }
  params.entry.clientSecret = { source: "file", provider, id: "value" };
  delete params.entry.clientSecretFile;
  params.changes.push(
    `Moved ${params.path}.clientSecretFile → ${params.path}.clientSecret using file provider ${provider}.`,
  );
}
