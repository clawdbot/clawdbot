import { normalizeE164 } from "../utils.js";

const WHATSAPP_USER_JID_RE = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i;
const WHATSAPP_LID_RE = /^(\d+)@lid$/i;
const WHATSAPP_GROUP_SUFFIX = "@g.us";

/**
 * Removes "whatsapp:" prefixes from the string recursively and trims whitespace.
 */
function stripWhatsAppTargetPrefixes(value: string): string {
  // More efficient than a loop: matches "whatsapp:" followed by optional spaces, one or more times.
  return value
    .trim()
    .replace(/^(whatsapp:\s*)+/i, "")
    .trim();
}

export function isWhatsAppGroupJid(value: string): boolean {
  const candidate = stripWhatsAppTargetPrefixes(value);
  const lower = candidate.toLowerCase();
  if (!lower.endsWith(WHATSAPP_GROUP_SUFFIX)) return false;
  const localPart = candidate.slice(0, -WHATSAPP_GROUP_SUFFIX.length);
  if (!localPart || localPart.includes("@")) return false;
  return /^[0-9]+(-[0-9]+)*$/.test(localPart);
}

/**
 * Check if value looks like a WhatsApp user target (e.g. "41796666864:0@s.whatsapp.net" or "123@lid").
 */
export function isWhatsAppUserTarget(value: string): boolean {
  const candidate = stripWhatsAppTargetPrefixes(value);
  return WHATSAPP_USER_JID_RE.test(candidate) || WHATSAPP_LID_RE.test(candidate);
}

/**
 * Extract the phone number or ID from a WhatsApp user JID.
 * "41796666864:0@s.whatsapp.net" -> "41796666864"
 * "123456@lid" -> "123456"
 */
function extractUserJidPhone(jid: string): string | null {
  const userMatch = jid.match(WHATSAPP_USER_JID_RE);
  if (userMatch) return userMatch[1];
  const lidMatch = jid.match(WHATSAPP_LID_RE);
  if (lidMatch) return lidMatch[1];
  return null;
}

export function normalizeWhatsAppTarget(value: string): string | null {
  const candidate = stripWhatsAppTargetPrefixes(value);
  if (!candidate) return null;

  if (isWhatsAppGroupJid(candidate)) {
    const localPart = candidate.slice(0, -WHATSAPP_GROUP_SUFFIX.length);
    return `${localPart}${WHATSAPP_GROUP_SUFFIX}`;
  }

  // Handle user JIDs (e.g. "41796666864:0@s.whatsapp.net" or "123@lid")
  if (isWhatsAppUserTarget(candidate)) {
    const phone = extractUserJidPhone(candidate);
    if (!phone) return null;
    const normalized = normalizeE164(phone);
    return normalized.length > 1 ? normalized : null;
  }

  // If the caller passed a JID-ish string that we don't understand, fail fast.
  // Otherwise normalizeE164 would happily treat "group:120@g.us" as a phone number.
  if (candidate.includes("@")) return null;

  const normalized = normalizeE164(candidate);
  return normalized.length > 1 ? normalized : null;
}
