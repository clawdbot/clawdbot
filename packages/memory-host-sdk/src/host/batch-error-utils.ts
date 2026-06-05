// Memory Host SDK helper module supports batch error utils behavior.
import { formatErrorMessage } from "./error-utils.js";

// Extracts provider batch error text from output and unavailable error files.

/** Minimal batch output line shape that can carry provider error messages. */
type BatchOutputErrorLike = {
  error?: { message?: string };
  response?: {
    body?:
      | string
      | {
          error?: { message?: string };
        };
  };
};

/** Pull a nested response error message without assuming a fixed provider body shape. */
function getResponseErrorMessage(line: BatchOutputErrorLike | undefined): string | undefined {
  const body = line?.response?.body;
  if (typeof body === "string") {
    return body || undefined;
  }
  if (!body || typeof body !== "object") {
    return undefined;
  }
  return typeof body.error?.message === "string" ? body.error.message : undefined;
}

/** Return the first useful error message from batch output lines. */
export function extractBatchErrorMessage(lines: BatchOutputErrorLike[]): string | undefined {
  const first = lines.find((line) => line.error?.message || getResponseErrorMessage(line));
  return first?.error?.message ?? getResponseErrorMessage(first);
}

/** Format a failed error-file read without hiding the underlying read problem. */
export function formatUnavailableBatchError(err: unknown): string | undefined {
  const message = formatErrorMessage(err);
  return message ? `error file unavailable: ${message}` : undefined;
}
