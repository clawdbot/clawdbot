import { DEFAULT_ACCOUNT_ID, type OpenClawConfig } from "openclaw/plugin-sdk/account-core";

const WHATSAPP_GROUP_SCOPE_FIELDS = ["groupPolicy", "groupAllowFrom", "groups"] as const;

type WhatsAppGroupScopeField = (typeof WHATSAPP_GROUP_SCOPE_FIELDS)[number];

function resolveWhatsAppAccountKey(
  accounts: Record<string, unknown> | undefined,
  accountId: string,
): string | undefined {
  if (!accounts) {
    return undefined;
  }
  if (Object.hasOwn(accounts, accountId)) {
    return accountId;
  }
  const normalizedAccountId = accountId.trim().toLowerCase();
  return Object.keys(accounts).find((key) => key.trim().toLowerCase() === normalizedAccountId);
}

function normalizePathAccountId(accountId?: string | null): string {
  return typeof accountId === "string"
    ? accountId.trim() || DEFAULT_ACCOUNT_ID
    : DEFAULT_ACCOUNT_ID;
}

function hasConfiguredField(config: unknown, field: WhatsAppGroupScopeField): boolean {
  return Boolean(
    config &&
    typeof config === "object" &&
    Object.hasOwn(config as Record<string, unknown>, field) &&
    (config as Record<string, unknown>)[field] !== undefined,
  );
}

function resolveSpecificFieldBasePath(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  field: WhatsAppGroupScopeField;
}): string | undefined {
  const accountId = normalizePathAccountId(params.accountId);
  const whatsapp = params.cfg.channels?.whatsapp;
  const accounts = whatsapp?.accounts as Record<string, unknown> | undefined;
  const accountKey = resolveWhatsAppAccountKey(accounts, accountId);
  const defaultAccountKey = resolveWhatsAppAccountKey(accounts, DEFAULT_ACCOUNT_ID);
  const accountConfig = accountKey ? accounts?.[accountKey] : undefined;
  const defaultAccountConfig = defaultAccountKey ? accounts?.[defaultAccountKey] : undefined;
  if (hasConfiguredField(accountConfig, params.field)) {
    return `channels.whatsapp.accounts.${accountKey}`;
  }
  if (accountId !== DEFAULT_ACCOUNT_ID && hasConfiguredField(defaultAccountConfig, params.field)) {
    return `channels.whatsapp.accounts.${defaultAccountKey}`;
  }
  if (hasConfiguredField(whatsapp, params.field)) {
    return "channels.whatsapp";
  }
  return undefined;
}

function resolveWhatsAppGroupScopeBasePath(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string {
  const accountId = normalizePathAccountId(params.accountId);
  const whatsapp = params.cfg.channels?.whatsapp;
  const accounts = whatsapp?.accounts as Record<string, unknown> | undefined;
  const accountKey = resolveWhatsAppAccountKey(accounts, accountId);
  const defaultAccountKey = resolveWhatsAppAccountKey(accounts, DEFAULT_ACCOUNT_ID);
  const accountConfig = accountKey ? accounts?.[accountKey] : undefined;
  const defaultAccountConfig = defaultAccountKey ? accounts?.[defaultAccountKey] : undefined;
  const matchesAnyGroupScopeField = (config: unknown): boolean =>
    WHATSAPP_GROUP_SCOPE_FIELDS.some((field) => hasConfiguredField(config, field));
  if (matchesAnyGroupScopeField(accountConfig)) {
    return `channels.whatsapp.accounts.${accountKey}`;
  }
  if (accountId !== DEFAULT_ACCOUNT_ID && matchesAnyGroupScopeField(defaultAccountConfig)) {
    return `channels.whatsapp.accounts.${defaultAccountKey}`;
  }
  return "channels.whatsapp";
}

export function resolveWhatsAppConfigPath(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  field: WhatsAppGroupScopeField;
}): string {
  return `${resolveWhatsAppGroupScopeBasePath(params)}.${params.field}`;
}

export function resolveWhatsAppGroupsConfigPath(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string {
  return `${
    resolveSpecificFieldBasePath({ ...params, field: "groups" }) ??
    resolveWhatsAppGroupScopeBasePath(params)
  }.groups`;
}
