// Voice Call provider HTTP clients share bounded response body readers.
import {
  readResponseTextPrefix,
  readResponseWithLimit,
} from "openclaw/plugin-sdk/response-limit-runtime";

const PROVIDER_JSON_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;
const PROVIDER_ERROR_RESPONSE_MAX_BYTES = 8 * 1024;
const TRUNCATED_SUFFIX = "... [truncated]";

type ReadProviderResponseTextParams = {
  response: Response;
  maxBytes: number;
  truncateOnLimit?: boolean;
};

export async function cancelProviderResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function appendTruncatedSuffix(text: string): string {
  return `${text.trimEnd()}${TRUNCATED_SUFFIX}`;
}

async function readProviderResponseTextWithLimit(
  params: ReadProviderResponseTextParams,
): Promise<string> {
  if (params.truncateOnLimit) {
    const prefix = await readResponseTextPrefix(params.response, params.maxBytes);
    return prefix.truncated ? appendTruncatedSuffix(prefix.text) : prefix.text;
  }

  const body = await readResponseWithLimit(params.response, params.maxBytes, {
    onOverflow: ({ size, maxBytes }) =>
      new Error(`provider response body too large: ${size} bytes (limit: ${maxBytes} bytes)`),
  });
  return new TextDecoder().decode(body);
}

export async function readProviderJsonResponseText(response: Response): Promise<string> {
  return await readProviderResponseTextWithLimit({
    response,
    maxBytes: PROVIDER_JSON_RESPONSE_MAX_BYTES,
  });
}

export async function readProviderErrorResponseSnippet(response: Response): Promise<string> {
  return await readProviderResponseTextWithLimit({
    response,
    maxBytes: PROVIDER_ERROR_RESPONSE_MAX_BYTES,
    truncateOnLimit: true,
  });
}
