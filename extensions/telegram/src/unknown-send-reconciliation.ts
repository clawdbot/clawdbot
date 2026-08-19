// Telegram plugin module implements unknown-send reconciliation behavior.
import type {
  ChannelMessageUnknownSendContext,
  ChannelMessageUnknownSendReconciliationResult,
} from "openclaw/plugin-sdk/channel-outbound";

// The Bot API has no arbitrary getMessage lookup, so Telegram cannot query the
// platform to verify an ambiguous send. Reconciliation may consult only the
// failure evidence recorded at the send boundary: when that evidence proves the
// request never produced a recipient-visible message, replaying is safe;
// anything else must stay unresolved — a blind replay risks a duplicate send.
const NO_SEND_PROOF_RES: readonly RegExp[] = [
  // Channel-owned no-send marker (PlatformMessageNotDispatchedError text).
  /Telegram request not started/i,
  // Connection-phase transport failures: the request never reached Telegram.
  /\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETDOWN|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_DNS_RESOLVE_FAILED)\b/,
  /\bconnect ETIMEDOUT\b/,
  // TLS negotiation failures happen before any HTTP bytes are written.
  /\b(?:ERR_TLS_\w+|ERR_SSL_\w+|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|HOSTNAME_MISMATCH)\b/,
  /certificate has expired|self[- ]signed certificate|unable to verify the first certificate|does not match certificate's altnames/i,
  // Bot API error responses: Telegram decided the request, so nothing was
  // delivered. Bounded to the status phrases the Bot API actually returns.
  /\b4\d{2}:\s*(?:Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Too Many Requests|Request Entity Too Large)/i,
  /\b5\d{2}:\s*(?:Internal Server|Bad Gateway|Service Unavailable|Gateway Timeout)/i,
];

/** True when recorded failure text proves the send never became recipient-visible. */
function telegramRecordedErrorProvesNotSent(lastError: string): boolean {
  return NO_SEND_PROOF_RES.some((re) => re.test(lastError));
}

/** Evidence-only reconciliation for queued Telegram sends with unknown outcomes. */
export function reconcileTelegramUnknownSend(
  ctx: ChannelMessageUnknownSendContext,
): ChannelMessageUnknownSendReconciliationResult {
  const lastError = ctx.lastError?.trim();
  if (lastError && telegramRecordedErrorProvesNotSent(lastError)) {
    return { status: "not_sent" };
  }
  return {
    status: "unresolved",
    retryable: false,
    error: lastError
      ? `recorded failure is not proof of a dropped send: ${lastError}`
      : "no recorded failure evidence; Telegram cannot verify an ambiguous send",
  };
}
