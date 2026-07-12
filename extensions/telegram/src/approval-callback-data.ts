// Telegram plugin module implements approval callback data behavior.
import { buildApprovalResolutionRef } from "openclaw/plugin-sdk/approval-reference-runtime";
import type { MessagePresentationAction } from "openclaw/plugin-sdk/interactive-runtime";

const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
const TELEGRAM_APPROVAL_CALLBACK_PREFIX = "tga1:";

export type TelegramApprovalCallback = Extract<MessagePresentationAction, { type: "approval" }>;

// `(?![\s\S])` is an absolute end-of-input anchor; `$` also matches before a
// final line terminator, which would make the fixed-length alias slice corrupt it.
const TELEGRAM_APPROVE_ALLOW_ALWAYS_PATTERN =
  /^\/approve(?:@[^\s]+)?\s+[A-Za-z0-9][A-Za-z0-9._:-]*\s+allow-always(?![\s\S])/i;

export function fitsTelegramCallbackData(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES;
}

/** Reserve the Telegram approval namespace even when a callback is malformed. */
export function hasTelegramApprovalCallbackPrefix(data?: string | null): boolean {
  return data?.startsWith(TELEGRAM_APPROVAL_CALLBACK_PREFIX) === true;
}

/** Encode a typed approval action into Telegram-private, versioned callback data. */
export function buildTelegramApprovalCallbackData(
  action: TelegramApprovalCallback,
): string | undefined {
  if (!action.approvalId) {
    return undefined;
  }
  const approvalKind = action.approvalKind;
  const kind = approvalKind === "exec" ? "e" : approvalKind === "plugin" ? "p" : null;
  const decision =
    action.decision === "allow-once"
      ? "o"
      : action.decision === "allow-always"
        ? "a"
        : action.decision === "deny"
          ? "d"
          : null;
  if (!kind || !decision) {
    return undefined;
  }
  const encode = (approvalId: string) =>
    `${TELEGRAM_APPROVAL_CALLBACK_PREFIX}${kind}:${decision}:${approvalId}`;
  const exact = encode(action.approvalId);
  if (fitsTelegramCallbackData(exact)) {
    return exact;
  }
  // Telegram caps callback_data at 64 UTF-8 bytes. The full digest is only a
  // durable locator; Gateway authorization still guards the canonical record.
  return encode(buildApprovalResolutionRef({ approvalId: action.approvalId, approvalKind }));
}

/** Decode only callbacks emitted by buildTelegramApprovalCallbackData. */
export function parseTelegramApprovalCallbackData(
  data?: string | null,
): TelegramApprovalCallback | null {
  if (!hasTelegramApprovalCallbackPrefix(data) || !data || !fitsTelegramCallbackData(data)) {
    return null;
  }
  const encoded = data.slice(TELEGRAM_APPROVAL_CALLBACK_PREFIX.length);
  if (encoded.length < 5 || encoded[1] !== ":" || encoded[3] !== ":") {
    return null;
  }
  const approvalKind = encoded[0] === "e" ? "exec" : encoded[0] === "p" ? "plugin" : null;
  const decision =
    encoded[2] === "o"
      ? "allow-once"
      : encoded[2] === "a"
        ? "allow-always"
        : encoded[2] === "d"
          ? "deny"
          : null;
  const approvalId = encoded.slice(4);
  if (!approvalKind || !decision || !approvalId) {
    return null;
  }
  return { type: "approval", approvalId, approvalKind, decision };
}

export function rewriteTelegramApprovalDecisionAlias(value: string): string {
  if (!TELEGRAM_APPROVE_ALLOW_ALWAYS_PATTERN.test(value)) {
    return value;
  }
  return value.slice(0, -"allow-always".length) + "always";
}

export function sanitizeTelegramCallbackData(value: string): string | undefined {
  const rewritten = rewriteTelegramApprovalDecisionAlias(value);
  return fitsTelegramCallbackData(rewritten) ? rewritten : undefined;
}
