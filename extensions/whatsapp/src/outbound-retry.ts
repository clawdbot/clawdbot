// WhatsApp plugin module implements outbound retry behavior.
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import { formatError } from "./session-errors.js";
import { isWhatsAppSocketOperationTimeoutError } from "./socket-timing.js";

const WHATSAPP_OUTBOUND_MAX_ATTEMPTS = 3;
const WHATSAPP_OUTBOUND_MIN_DELAY_MS = 500;
const WHATSAPP_OUTBOUND_MAX_DELAY_MS = 1_000;
const WHATSAPP_RETRYABLE_OUTBOUND_ERROR_PATTERN = /closed|reset|timed\s*out|disconnect/i;

class WhatsAppOutboundRetryError extends Error {
  constructor(readonly original: unknown) {
    super(formatError(original), { cause: original });
  }
}

function isRetryableWhatsAppOutboundError(error: unknown): boolean {
  // Outbound sends surface direct failures; inspecting wrappers or causes can
  // replay a non-idempotent send. A direct local timeout may have delivered it.
  if (isWhatsAppSocketOperationTimeoutError(error)) {
    return false;
  }
  return WHATSAPP_RETRYABLE_OUTBOUND_ERROR_PATTERN.test(formatError(error));
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
  try {
    return await retryAsync(
      async () => {
        try {
          return await params.send();
        } catch (error) {
          // retryAsync normalizes non-Error throws. Keep the original value in
          // an Error wrapper so the WhatsApp adapter can restore exact identity.
          throw new WhatsAppOutboundRetryError(error);
        }
      },
      {
        attempts: WHATSAPP_OUTBOUND_MAX_ATTEMPTS,
        minDelayMs: WHATSAPP_OUTBOUND_MIN_DELAY_MS,
        maxDelayMs: WHATSAPP_OUTBOUND_MAX_DELAY_MS,
        jitter: 0,
        shouldRetry: (error) =>
          error instanceof WhatsAppOutboundRetryError &&
          isRetryableWhatsAppOutboundError(error.original),
        onRetry: ({ attempt, maxAttempts, delayMs, err }) => {
          if (!(err instanceof WhatsAppOutboundRetryError)) {
            return;
          }
          params.onRetry?.({
            attempt,
            maxAttempts,
            backoffMs: delayMs,
            error: err.original,
            errorText: formatError(err.original),
          });
        },
      },
    );
  } catch (error) {
    if (error instanceof WhatsAppOutboundRetryError) {
      throw error.original;
    }
    throw error;
  }
}
