import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import {
  DEFAULT_ACCOUNT_ID,
  listCombinedAccountIds,
  resolveAccountEntry,
  resolveListedDefaultAccountId,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeSmsAllowFrom, normalizeSmsPhoneNumber } from "./phone.js";
import type { ResolvedSmsAccount, SmsChannelConfig } from "./types.js";

const CHANNEL_ID = "sms";
const DEFAULT_WEBHOOK_PATH = "/webhooks/sms";
const DEFAULT_TEXT_CHUNK_LIMIT = 1500;

function getChannelConfig(cfg: OpenClawConfig): SmsChannelConfig | undefined {
  return cfg?.channels?.[CHANNEL_ID] as SmsChannelConfig | undefined;
}

function parseList(raw: unknown): string[] {
  if (!raw) {
    return [];
  }
  const entries = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? normalizeStringEntries(raw.split(","))
      : [raw];
  return entries.map((entry) => normalizeSmsAllowFrom(String(entry))).filter(Boolean);
}

function parseTextChunkLimit(raw: unknown): number {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    return parseStrictInteger(raw.trim()) ?? DEFAULT_TEXT_CHUNK_LIMIT;
  }
  return DEFAULT_TEXT_CHUNK_LIMIT;
}

function firstNonBlankEnv(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim());
}

function hasBaseAccount(channelCfg: SmsChannelConfig | undefined): boolean {
  return Boolean(
    channelCfg?.accountSid ||
    hasConfiguredSecretInput(channelCfg?.authToken) ||
    channelCfg?.fromNumber ||
    channelCfg?.messagingServiceSid ||
    process.env.TWILIO_ACCOUNT_SID ||
    process.env.TWILIO_AUTH_TOKEN ||
    process.env.TWILIO_PHONE_NUMBER ||
    process.env.TWILIO_SMS_FROM ||
    process.env.TWILIO_MESSAGING_SERVICE_SID,
  );
}

export function listSmsAccountIds(cfg: OpenClawConfig): string[] {
  const channelCfg = getChannelConfig(cfg);
  return listCombinedAccountIds({
    configuredAccountIds: Object.keys(channelCfg?.accounts ?? {}),
    implicitAccountId: hasBaseAccount(channelCfg) ? DEFAULT_ACCOUNT_ID : undefined,
  });
}

export function resolveDefaultSmsAccountId(cfg: OpenClawConfig): string {
  const channelCfg = getChannelConfig(cfg);
  return resolveListedDefaultAccountId({
    accountIds: listSmsAccountIds(cfg),
    configuredDefaultAccountId: normalizeOptionalAccountId(channelCfg?.defaultAccount),
  });
}

export function resolveSmsAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedSmsAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = normalizeOptionalAccountId(accountId) ?? resolveDefaultSmsAccountId(cfg);
  const accountConfig = resolveAccountEntry(channelCfg.accounts, id);
  const channelConfig: Record<string, unknown> & SmsChannelConfig = { ...channelCfg };
  const accountEntries:
    | Record<string, Partial<Record<string, unknown> & SmsChannelConfig>>
    | undefined = channelCfg.accounts
    ? Object.fromEntries(
        Object.entries(channelCfg.accounts).map(([accountKey, account]) => [
          accountKey,
          { ...account },
        ]),
      )
    : undefined;
  const merged = resolveMergedAccountConfig<Record<string, unknown> & SmsChannelConfig>({
    channelConfig,
    accounts: accountEntries,
    accountId: id,
    omitKeys: ["defaultAccount"],
  });

  const useEnvFallbacks = id === DEFAULT_ACCOUNT_ID;
  const envAccountSid = useEnvFallbacks ? process.env.TWILIO_ACCOUNT_SID : undefined;
  const envAuthToken = useEnvFallbacks ? process.env.TWILIO_AUTH_TOKEN : undefined;
  const envFromNumber = useEnvFallbacks
    ? firstNonBlankEnv(process.env.TWILIO_PHONE_NUMBER, process.env.TWILIO_SMS_FROM)
    : undefined;
  const envMessagingServiceSid = useEnvFallbacks
    ? process.env.TWILIO_MESSAGING_SERVICE_SID
    : undefined;
  const envWebhookPath = useEnvFallbacks ? process.env.SMS_WEBHOOK_PATH : undefined;
  const envPublicWebhookUrl = useEnvFallbacks ? process.env.SMS_PUBLIC_WEBHOOK_URL : undefined;
  const envAllowFrom = useEnvFallbacks ? process.env.SMS_ALLOWED_USERS : undefined;
  const envTextChunkLimit = useEnvFallbacks ? process.env.SMS_TEXT_CHUNK_LIMIT : undefined;
  const envDisableSignatureValidation = useEnvFallbacks
    ? process.env.SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION
    : undefined;

  const webhookPath = (merged.webhookPath ?? envWebhookPath ?? DEFAULT_WEBHOOK_PATH).trim();
  const publicWebhookUrl = (merged.publicWebhookUrl ?? envPublicWebhookUrl ?? "").trim();
  const authToken =
    normalizeResolvedSecretInputString({
      value: merged.authToken ?? envAuthToken,
      path:
        id === DEFAULT_ACCOUNT_ID
          ? "channels.sms.authToken"
          : `channels.sms.accounts.${id}.authToken`,
    }) ?? "";
  return {
    accountId: id,
    enabled: channelCfg.enabled !== false && accountConfig?.enabled !== false,
    accountSid: (merged.accountSid ?? envAccountSid ?? "").trim(),
    authToken,
    fromNumber: normalizeSmsPhoneNumber(merged.fromNumber ?? envFromNumber ?? ""),
    messagingServiceSid: (merged.messagingServiceSid ?? envMessagingServiceSid ?? "").trim(),
    defaultTo: normalizeSmsPhoneNumber(merged.defaultTo ?? ""),
    webhookPath: webhookPath || DEFAULT_WEBHOOK_PATH,
    publicWebhookUrl,
    dangerouslyDisableSignatureValidation:
      merged.dangerouslyDisableSignatureValidation === true ||
      envDisableSignatureValidation === "true",
    dmPolicy: merged.dmPolicy ?? "pairing",
    allowFrom: parseList(merged.allowFrom ?? envAllowFrom),
    textChunkLimit: parseTextChunkLimit(merged.textChunkLimit ?? envTextChunkLimit),
  };
}

export function inspectSmsAccount(cfg: OpenClawConfig, accountId?: string | null) {
  const account = resolveSmsAccount(cfg, accountId);
  const configured = isSmsAccountConfigured(account);
  return {
    enabled: account.enabled,
    configured,
    tokenStatus: account.authToken ? "available" : "missing",
    webhookPath: account.webhookPath,
    signatureValidation:
      account.dangerouslyDisableSignatureValidation || account.publicWebhookUrl
        ? "configured"
        : "missing-public-url",
  };
}

export function isSmsAccountConfigured(account: ResolvedSmsAccount): boolean {
  return Boolean(
    account.accountSid && account.authToken && (account.fromNumber || account.messagingServiceSid),
  );
}
