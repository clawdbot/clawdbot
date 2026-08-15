// Voice Call provider HTTP clients share bounded response body readers.
import {
  readResponseTextPrefix,
  readResponseWithLimit,
} from "openclaw/plugin-sdk/response-limit-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";

const PROVIDER_JSON_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;
const PROVIDER_ERROR_RESPONSE_MAX_BYTES = 8 * 1024;
const TRUNCATED_SUFFIX = "... [truncated]";

export async function cancelProviderResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function appendTruncatedSuffix(text: string): string {
  return `${text.trimEnd()}${TRUNCATED_SUFFIX}`;
}

export async function readVoiceCallProviderJsonResponse<T>(
  response: Response,
  malformedJsonMessage: string,
): Promise<T | undefined> {
  const body = await readResponseWithLimit(response, PROVIDER_JSON_RESPONSE_MAX_BYTES, {
    onOverflow: ({ size, maxBytes }) =>
      new Error(`provider response body too large: ${size} bytes (limit: ${maxBytes} bytes)`),
  });
  if (body.byteLength === 0) {
    return undefined;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error(malformedJsonMessage, { cause });
  }
}

export async function readProviderErrorResponseSnippet(response: Response): Promise<string> {
  const prefix = await readResponseTextPrefix(response, PROVIDER_ERROR_RESPONSE_MAX_BYTES);
  // Provider error bodies can echo credential-bearing request details (Authorization
  // headers, account identifiers, signed URLs), so redact before the snippet reaches
  // error messages and logs. Tools mode keeps redaction on regardless of log config.
  const text = redactSensitiveText(prefix.text, { mode: "tools" });
  return prefix.truncated ? appendTruncatedSuffix(text) : text;
}
