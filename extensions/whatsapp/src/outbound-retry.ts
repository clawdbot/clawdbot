// WhatsApp plugin module implements outbound retry behavior.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createChannelApiRetryRunner } from "openclaw/plugin-sdk/retry-runtime";
import { formatError } from "./session-errors.js";
import { isWhatsAppSocketOperationTimeoutError } from "./socket-timing.js";

const WHATSAPP_OUTBOUND_MAX_ATTEMPTS = 3;
const WHATSAPP_OUTBOUND_MIN_DELAY_MS = 500;
const WHATSAPP_OUTBOUND_MAX_DELAY_MS = 1_000;
const WHATSAPP_RETRYABLE_OUTBOUND_ERROR_PATTERN = /closed|reset|disconnect/i;
// A transport-level timeout can occur after the message reached WhatsApp, so any
// error whose text mentions a timeout is treated as ambiguous-delivery and not
// retried — even if it also mentions a disconnect keyword (e.g. "request timed
// out after socket closed"), because the timeout ambiguity takes precedence.
// Covers the common spellings: "timed out", "timeout", "TimeoutError", ETIMEDOUT.
const WHATSAPP_OUTBOUND_TIMEOUT_ERROR_PATTERN = /timed\s*out|timeout|ETIMEDOUT/i;

class WhatsAppOutboundRetryError extends Error {
  constructor(readonly original: unknown) {
    super(formatError(original), { cause: original });
  }
}

function isRetryableWhatsAppOutboundError(error: unknown): boolean {
  // Outbound sends surface direct failures; inspecting wrappers or causes can
  // replay a non-idempotent send. A direct local timeout may have delivered it,
  // and a transport-layer "timed out" (Baileys/axios) can occur after the
  // message reached WhatsApp, so neither is retried. Only errors that prove the
  // socket died (closed/reset/disconnect) are retried, matching
  // shouldClearSocketRefAfterSendFailure. A timeout in the text wins over a
  // disconnect keyword to avoid replaying a possibly-delivered message.
  if (isChannelPartialDeliveryError(error) || isWhatsAppSocketOperationTimeoutError(error)) {
    return false;
  }
  const text = formatError(error);
  if (WHATSAPP_OUTBOUND_TIMEOUT_ERROR_PATTERN.test(text)) {
    return false;
  }
  return WHATSAPP_RETRYABLE_OUTBOUND_ERROR_PATTERN.test(text);
}

type WhatsAppOutboundRetryInfo = {
  attempt: number;
  maxAttempts: number;
  backoffMs: number;
  error: unknown;
  errorText: string;
};

export async function sendWhatsAppOutboundWithRetry<T>(params: {
  send: () => Promise<T>;
  onRetry?: (info: WhatsAppOutboundRetryInfo) => void;
}): Promise<T> {
  const runWithRetry = createChannelApiRetryRunner({
    retry: {
      attempts: WHATSAPP_OUTBOUND_MAX_ATTEMPTS,
      minDelayMs: WHATSAPP_OUTBOUND_MIN_DELAY_MS,
      maxDelayMs: WHATSAPP_OUTBOUND_MAX_DELAY_MS,
      jitter: 0,
    },
    strictShouldRetry: true,
    retryAfterMs: () => undefined,
    shouldRetry: (error, attempt) => {
      if (
        !(error instanceof WhatsAppOutboundRetryError) ||
        !isRetryableWhatsAppOutboundError(error.original)
      ) {
        return false;
      }
      params.onRetry?.({
        attempt,
        maxAttempts: WHATSAPP_OUTBOUND_MAX_ATTEMPTS,
        backoffMs: Math.min(
          WHATSAPP_OUTBOUND_MIN_DELAY_MS * 2 ** (attempt - 1),
          WHATSAPP_OUTBOUND_MAX_DELAY_MS,
        ),
        error: error.original,
        errorText: formatError(error.original),
      });
      return true;
    },
  });
  try {
    return await runWithRetry(async () => {
      try {
        return await params.send();
      } catch (error) {
        // The shared runner normalizes non-Error throws. Keep the original in
        // an Error wrapper so the WhatsApp adapter can restore exact identity.
        throw new WhatsAppOutboundRetryError(error);
      }
    });
  } catch (error) {
    if (error instanceof WhatsAppOutboundRetryError) {
      throw error.original;
    }
    throw error;
  }
}
