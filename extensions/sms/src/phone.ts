export function normalizeSmsPhoneNumber(raw: string): string {
  const trimmed = raw.trim().replace(/^(?:sms|twilio-sms):/i, "");
  if (!trimmed) {
    return "";
  }
  const withPlus = trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
  return withPlus.replace(/[^\d+]/g, "");
}

export function looksLikeSmsPhoneNumber(raw: string): boolean {
  const normalized = normalizeSmsPhoneNumber(raw);
  return /^\+[1-9]\d{6,14}$/.test(normalized);
}

export function normalizeSmsAllowFrom(raw: string): string {
  if (raw.trim() === "*") {
    return "*";
  }
  return normalizeSmsPhoneNumber(raw).toLowerCase();
}
