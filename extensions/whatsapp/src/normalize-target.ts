// Whatsapp helper module supports normalize target behavior.
import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeStringEntries,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const WHATSAPP_USER_JID_RE = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i;
const WHATSAPP_LEGACY_USER_JID_RE = /^(\d+)@c\.us$/i;
const WHATSAPP_LID_RE = /^(\d+)@lid$/i;
const NON_WHATSAPP_PROVIDER_PREFIX_RE = /^[a-z][a-z0-9-]*:/i;
const WHATSAPP_NEWSLETTER_JID_RE = /^([0-9]+)@newsletter$/i;

function stripWhatsAppTargetPrefixes(value: string): string {
  let candidate = value.trim();
  for (;;) {
    const before = candidate;
    candidate = candidate.replace(/^whatsapp:/i, "").trim();
    if (candidate === before) {
      return candidate;
    }
  }
}

function normalizeWhatsAppGroupJid(value: string): string | null {
  const candidate = stripWhatsAppTargetPrefixes(value)
    .replace(/^group:/i, "")
    .trim();
  const lower = normalizeLowercaseStringOrEmpty(candidate);
  if (!lower.endsWith("@g.us")) {
    return null;
  }
  const localPart = candidate.slice(0, candidate.length - "@g.us".length);
  if (!localPart || localPart.includes("@")) {
    return null;
  }
  return /^[0-9]+(-[0-9]+)*$/.test(localPart) ? `${localPart}@g.us` : null;
}

export function isWhatsAppGroupJid(value: string): boolean {
  return normalizeWhatsAppGroupJid(value) !== null;
}

export function isWhatsAppNewsletterJid(value: string): boolean {
  const candidate = stripWhatsAppTargetPrefixes(value);
  return WHATSAPP_NEWSLETTER_JID_RE.test(candidate);
}

export function isWhatsAppUserTarget(value: string): boolean {
  const candidate = stripWhatsAppTargetPrefixes(value);
  return (
    WHATSAPP_USER_JID_RE.test(candidate) ||
    WHATSAPP_LEGACY_USER_JID_RE.test(candidate) ||
    WHATSAPP_LID_RE.test(candidate)
  );
}

function extractUserJidPhone(jid: string): string | null {
  const userMatch = jid.match(WHATSAPP_USER_JID_RE);
  if (userMatch) {
    const phone = userMatch[1];
    return phone ? phone : null;
  }
  const legacyUserMatch = jid.match(WHATSAPP_LEGACY_USER_JID_RE);
  if (legacyUserMatch) {
    const phone = legacyUserMatch[1];
    return phone ? phone : null;
  }
  const lidMatch = jid.match(WHATSAPP_LID_RE);
  if (lidMatch) {
    const phone = lidMatch[1];
    return phone ? phone : null;
  }
  return null;
}

export function normalizeWhatsAppTarget(value: string): string | null {
  const candidate = stripWhatsAppTargetPrefixes(value);
  if (!candidate) {
    return null;
  }
  const groupJid = normalizeWhatsAppGroupJid(candidate);
  if (groupJid) {
    return groupJid;
  }
  if (isWhatsAppNewsletterJid(candidate)) {
    const match = candidate.match(WHATSAPP_NEWSLETTER_JID_RE);
    return match ? `${match[1]}@newsletter` : null;
  }
  if (isWhatsAppUserTarget(candidate)) {
    const phone = extractUserJidPhone(candidate);
    if (!phone) {
      return null;
    }
    const normalized = normalizeE164(phone);
    return normalized.length > 1 ? normalized : null;
  }
  if (candidate.includes("@")) {
    return null;
  }
  if (NON_WHATSAPP_PROVIDER_PREFIX_RE.test(candidate)) {
    return null;
  }
  const normalized = normalizeE164(candidate);
  return normalized.length > 1 ? normalized : null;
}

export function normalizeWhatsAppMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizeWhatsAppTarget(trimmed) ?? undefined;
}

export function normalizeWhatsAppAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return uniqueStrings(
    normalizeStringEntries(allowFrom)
      .map(normalizeWhatsAppAllowFromEntry)
      .filter((entry): entry is string => Boolean(entry)),
  );
}

export function normalizeWhatsAppAllowFromEntry(entry: string): string | null {
  if (entry === "*") {
    return entry;
  }
  const normalized = normalizeWhatsAppTarget(entry);
  if (!normalized) {
    return null;
  }
  return normalized.startsWith("+") ? normalized.slice(1) : normalized;
}

export function looksLikeWhatsAppTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  return (
    /^whatsapp:/i.test(trimmed) ||
    isWhatsAppGroupJid(trimmed) ||
    isWhatsAppNewsletterJid(trimmed) ||
    isWhatsAppUserTarget(trimmed) ||
    normalizeWhatsAppTarget(trimmed) !== null
  );
}
