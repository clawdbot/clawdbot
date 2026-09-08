/**
 * Channel config mutation helpers.
 *
 * Updates account enabled state and detects configured secret-like values.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";

type ChannelSection = {
  accounts?: Record<string, Record<string, unknown>>;
  enabled?: boolean;
};

/** Replace one section; undefined removes it and prunes an empty channels object. */
export function writeChannelSection(
  cfg: OpenClawConfig,
  channelKey: string,
  section: Record<string, unknown> | undefined,
): OpenClawConfig {
  if (section !== undefined) {
    return { ...cfg, channels: { ...cfg.channels, [channelKey]: section } };
  }
  const channels = { ...cfg.channels };
  delete channels[channelKey];
  const next = { ...cfg };
  if (Object.keys(channels).length > 0) {
    next.channels = channels;
  } else {
    delete next.channels;
  }
  return next;
}

export function setTopLevelChannelEnabledInConfigSection(params: {
  cfg: OpenClawConfig;
  sectionKey: string;
  enabled: boolean;
}): OpenClawConfig {
  return writeChannelSection(params.cfg, params.sectionKey, {
    ...params.cfg.channels?.[params.sectionKey],
    enabled: params.enabled,
  });
}

export function clearTopLevelChannelConfigFields(params: {
  cfg: OpenClawConfig;
  sectionKey: string;
  clearBaseFields: string[];
}): OpenClawConfig {
  const section = params.cfg.channels?.[params.sectionKey];
  if (!section) {
    return params.cfg;
  }
  const nextSection = { ...section };
  for (const field of params.clearBaseFields) {
    delete nextSection[field];
  }
  return writeChannelSection(params.cfg, params.sectionKey, nextSection);
}

function isConfiguredSecretValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return Boolean(value);
}

/**
 * Updates an account enabled flag in a channel config section.
 */
export function setAccountEnabledInConfigSection(params: {
  cfg: OpenClawConfig;
  sectionKey: string;
  accountId: string;
  enabled: boolean;
  allowTopLevel?: boolean;
}): OpenClawConfig {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[params.sectionKey] as ChannelSection | undefined;
  const hasAccounts = Boolean(base?.accounts);
  if (params.allowTopLevel && accountKey === DEFAULT_ACCOUNT_ID && !hasAccounts) {
    // Legacy single-account sections store enabled at the channel root until accounts exist.
    return setTopLevelChannelEnabledInConfigSection(params);
  }

  const baseAccounts = base?.accounts ?? {};
  const existing = baseAccounts[accountKey] ?? {};
  return writeChannelSection(params.cfg, params.sectionKey, {
    ...base,
    accounts: {
      ...baseAccounts,
      [accountKey]: { ...existing, enabled: params.enabled },
    },
  });
}

/**
 * Deletes one account from a channel config section, pruning empty channel/accounts objects.
 */
export function deleteAccountFromConfigSection(params: {
  cfg: OpenClawConfig;
  sectionKey: string;
  accountId: string;
  clearBaseFields?: string[];
}): OpenClawConfig {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[params.sectionKey] as ChannelSection | undefined;
  if (!base) {
    return params.cfg;
  }

  const accounts = base.accounts && typeof base.accounts === "object" ? { ...base.accounts } : {};
  if (accountKey === DEFAULT_ACCOUNT_ID && Object.keys(accounts).length === 0) {
    return writeChannelSection(params.cfg, params.sectionKey, undefined);
  }

  delete accounts[accountKey];
  const baseRecord = { ...(base as Record<string, unknown>) };
  if (accountKey === DEFAULT_ACCOUNT_ID) {
    // Deleting the default account can also clear root-level credential fields that represented
    // the legacy default account.
    for (const field of params.clearBaseFields ?? []) {
      if (field in baseRecord) {
        baseRecord[field] = undefined;
      }
    }
  }
  return writeChannelSection(params.cfg, params.sectionKey, {
    ...baseRecord,
    accounts: Object.keys(accounts).length ? accounts : undefined,
  });
}

/**
 * Clears selected fields from one account entry and reports whether configured data was removed.
 */
export function clearAccountEntryFields<TAccountEntry extends object>(params: {
  accounts?: Record<string, TAccountEntry>;
  accountId: string;
  fields: string[];
  isValueSet?: (value: unknown) => boolean;
  markClearedOnFieldPresence?: boolean;
}): {
  nextAccounts?: Record<string, TAccountEntry>;
  changed: boolean;
  cleared: boolean;
} {
  const accountKey = params.accountId || DEFAULT_ACCOUNT_ID;
  const baseAccounts =
    params.accounts && typeof params.accounts === "object" ? { ...params.accounts } : undefined;
  if (!baseAccounts || !(accountKey in baseAccounts)) {
    return { nextAccounts: baseAccounts, changed: false, cleared: false };
  }

  const entry = baseAccounts[accountKey];
  if (!entry || typeof entry !== "object") {
    return { nextAccounts: baseAccounts, changed: false, cleared: false };
  }

  const nextEntry = { ...(entry as Record<string, unknown>) };
  const hasAnyField = params.fields.some((field) => field in nextEntry);
  if (!hasAnyField) {
    return { nextAccounts: baseAccounts, changed: false, cleared: false };
  }

  const isValueSet = params.isValueSet ?? isConfiguredSecretValue;
  let cleared = Boolean(params.markClearedOnFieldPresence);
  for (const field of params.fields) {
    if (!(field in nextEntry)) {
      continue;
    }
    if (isValueSet(nextEntry[field])) {
      cleared = true;
    }
    // Preserve unrelated account fields; remove the account entry only if it becomes empty.
    delete nextEntry[field];
  }

  if (Object.keys(nextEntry).length === 0) {
    delete baseAccounts[accountKey];
  } else {
    baseAccounts[accountKey] = nextEntry as TAccountEntry;
  }

  const nextAccounts = Object.keys(baseAccounts).length > 0 ? baseAccounts : undefined;
  return {
    nextAccounts,
    changed: true,
    cleared,
  };
}

/** Clear plugin-selected account fields and prune only the config branches changed by cleanup. */
export function clearAccountFieldsFromConfigSection(params: {
  cfg: OpenClawConfig;
  sectionKey: string;
  accountId: string;
  fields: string[];
  markClearedOnFieldPresence?: boolean;
}): { nextConfig: OpenClawConfig; changed: boolean; cleared: boolean } {
  // SAFETY: Channel sections are config objects; the account helper checks nested entries.
  const section = params.cfg.channels?.[params.sectionKey] as
    | (ChannelSection & Record<string, unknown>)
    | undefined;
  const nextSection = { ...section };
  // Root fields clear as a group only for the explicit default account and a
  // truthy value. Nested cleanup retains its own empty-id and presence semantics.
  const clearedRoot =
    params.accountId === DEFAULT_ACCOUNT_ID &&
    params.fields.some((field) => Boolean(nextSection[field]));
  if (clearedRoot) {
    for (const field of params.fields) {
      delete nextSection[field];
    }
  }
  const accountCleanup = clearAccountEntryFields({
    accounts: nextSection.accounts,
    accountId: params.accountId,
    fields: params.fields,
    markClearedOnFieldPresence: params.markClearedOnFieldPresence,
  });
  if (!clearedRoot && !accountCleanup.changed) {
    return { nextConfig: params.cfg, changed: false, cleared: false };
  }
  if (accountCleanup.changed) {
    if (accountCleanup.nextAccounts) {
      nextSection.accounts = accountCleanup.nextAccounts;
    } else {
      delete nextSection.accounts;
    }
  }
  const nextConfig = writeChannelSection(
    params.cfg,
    params.sectionKey,
    Object.keys(nextSection).length > 0 ? nextSection : undefined,
  );
  return { nextConfig, changed: true, cleared: clearedRoot || accountCleanup.cleared };
}
