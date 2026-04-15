export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

const TELEGRAM_APPROVE_ALLOW_ALWAYS_PATTERN =
  /^\/approve(?:@[^\s]+)?\s+[A-Za-z0-9][A-Za-z0-9._:-]*\s+allow-always$/i;

export function fitsTelegramCallbackData(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES;
}

export function rewriteTelegramApprovalDecisionAlias(value: string): string {
  if (!value.endsWith(" allow-always")) {
    return value;
  }
  if (!TELEGRAM_APPROVE_ALLOW_ALWAYS_PATTERN.test(value)) {
    return value;
  }
  return value.slice(0, -"allow-always".length) + "always";
}

export function sanitizeTelegramCallbackData(value: string): string | undefined {
  const rewritten = rewriteTelegramApprovalDecisionAlias(value);
  return fitsTelegramCallbackData(rewritten) ? rewritten : undefined;
}
