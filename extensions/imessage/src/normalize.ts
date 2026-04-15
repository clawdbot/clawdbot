import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";

const SERVICE_PREFIXES = ["imessage:", "sms:", "auto:"] as const;
const CHAT_TARGET_PREFIX_RE =
  /^(chat_id:|chatid:|chat:|chat_guid:|chatguid:|guid:|chat_identifier:|chatidentifier:|chatident:)/i;

function looksLikeHandleOrPhoneTarget(params: {
  raw: string;
  prefixPattern: RegExp;
  phonePattern?: RegExp;
}): boolean {
  const trimmed = params.raw.trim();
  if (!trimmed) {
    return false;
  }
  if (params.prefixPattern.test(trimmed)) {
    return true;
  }
  if (trimmed.includes("@")) {
    return true;
  }
  return (params.phonePattern ?? /^\+?\d{3,}$/).test(trimmed);
}

export function normalizeIMessageHandle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  if (lowered.startsWith("imessage:")) {
    return normalizeIMessageHandle(trimmed.slice("imessage:".length));
  }
  if (lowered.startsWith("sms:")) {
    return normalizeIMessageHandle(trimmed.slice("sms:".length));
  }
  if (lowered.startsWith("auto:")) {
    return normalizeIMessageHandle(trimmed.slice("auto:".length));
  }
  if (CHAT_TARGET_PREFIX_RE.test(trimmed)) {
    const prefix = trimmed.match(CHAT_TARGET_PREFIX_RE)?.[0];
    if (!prefix) {
      return "";
    }
    const value = trimmed.slice(prefix.length).trim();
    return `${normalizeLowercaseStringOrEmpty(prefix)}${value}`;
  }
  if (trimmed.includes("@")) {
    return normalizeLowercaseStringOrEmpty(trimmed);
  }
  const normalized = normalizeE164(trimmed);
  if (normalized) {
    return normalized;
  }
  return trimmed.replace(/\s+/g, "");
}

export function normalizeIMessageMessagingTarget(raw: string): string | undefined {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return undefined;
  }

  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  for (const prefix of SERVICE_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const remainder = trimmed.slice(prefix.length).trim();
      const normalizedHandle = normalizeIMessageHandle(remainder);
      if (!normalizedHandle) {
        return undefined;
      }
      if (CHAT_TARGET_PREFIX_RE.test(normalizedHandle)) {
        return normalizedHandle;
      }
      return `${prefix}${normalizedHandle}`;
    }
  }

  const normalized = normalizeIMessageHandle(trimmed);
  return normalized || undefined;
}

export function looksLikeIMessageTargetId(raw: string): boolean {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return false;
  }
  if (CHAT_TARGET_PREFIX_RE.test(trimmed)) {
    return true;
  }
  return looksLikeHandleOrPhoneTarget({
    raw: trimmed,
    prefixPattern: /^(imessage:|sms:|auto:)/i,
  });
}
