import {
  createAccountListHelpers,
  resolveChannelMediaMaxBytes,
} from "openclaw/plugin-sdk/account-helpers";
// Sms plugin module implements accounts behavior.
import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import {
  DEFAULT_ACCOUNT_ID,
  hasConfiguredAccountValue,
  resolveAccountEntry,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeSmsAllowFrom, normalizeSmsPhoneNumber } from "./phone.js";
import { parseSmsPublicWebhookUrl } from "./public-webhook-url.js";
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
    // Positive like the numeric branch: a zero limit makes chunkSmsPlainText
    // in send.ts emit one Twilio send per character.
    return parseStrictPositiveInteger(raw.trim()) ?? DEFAULT_TEXT_CHUNK_LIMIT;
  }
  return DEFAULT_TEXT_CHUNK_LIMIT;
}

function firstNonBlankEnv(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim());
}

function hasBaseAccount(channelCfg: SmsChannelConfig | undefined): boolean {
  return (
    [
      channelCfg?.accountSid,
      channelCfg?.fromNumber,
      channelCfg?.messagingServiceSid,
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN,
      process.env.TWILIO_PHONE_NUMBER,
      process.env.TWILIO_SMS_FROM,
      process.env.TWILIO_MESSAGING_SERVICE_SID,
    ].some((value) => hasConfiguredAccountValue(value)) ||
    hasConfiguredSecretInput(channelCfg?.authToken)
  );
}

const {
  listAccountIds: listSmsAccountIds,
  resolveDefaultAccountId: resolveDefaultSmsAccountId,
  resolveAccountConfig: resolveMergedSmsAccountConfig,
} = createAccountListHelpers<Record<string, unknown> & SmsChannelConfig>(CHANNEL_ID, {
  fallbackAccountIdWhenEmpty: false,
  hasImplicitDefaultAccount: (cfg) => hasBaseAccount(getChannelConfig(cfg)),
  omitKeys: ["defaultAccount"],
});

export { listSmsAccountIds, resolveDefaultSmsAccountId };

export function resolveSmsAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedSmsAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = normalizeOptionalAccountId(accountId) ?? resolveDefaultSmsAccountId(cfg);
  const accountConfig = resolveAccountEntry(channelCfg.accounts, id);
  const merged = resolveMergedSmsAccountConfig(cfg, id);

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
    mediaMaxBytes: resolveChannelMediaMaxBytes({
      cfg,
      accountId: id,
      resolveChannelLimitMb: () => merged.mediaMaxMb,
    }),
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
    signatureValidation: account.dangerouslyDisableSignatureValidation
      ? "configured"
      : !account.publicWebhookUrl
        ? "missing-public-url"
        : parseSmsPublicWebhookUrl(account.publicWebhookUrl)
          ? "configured"
          : "invalid-public-url",
  };
}

export function isSmsAccountConfigured(account: ResolvedSmsAccount): boolean {
  return Boolean(
    account.accountSid && account.authToken && (account.fromNumber || account.messagingServiceSid),
  );
}
