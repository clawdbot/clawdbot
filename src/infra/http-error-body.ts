import { decodeTextPrefix } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatErrorMessage } from "./errors.js";
import { readResponseTextPrefix } from "./http-body.js";

const errorBodyLog = createSubsystemLogger("http-error-body");

export async function readResponseBodySnippet(
  response: Response,
  limits: {
    maxBytes: number;
    maxChars: number;
    redact?: (text: string, context: { truncated: boolean }) => string;
  },
): Promise<string> {
  const normalize = (text: string, truncated: boolean) =>
    truncateUtf16Safe(limits.redact?.(text, { truncated }) ?? text, limits.maxChars);
  try {
    const body = response.body;
    if (!body || typeof body.getReader !== "function") {
      const text = await response.text();
      const encoded = new TextEncoder().encode(text);
      if (encoded.byteLength > limits.maxBytes) {
        return normalize(
          decodeTextPrefix(encoded.subarray(0, limits.maxBytes), { truncated: true }),
          true,
        );
      }
      return normalize(text, false);
    }

    const prefix = await readResponseTextPrefix(response, limits.maxBytes);
    return normalize(prefix.text, prefix.truncated);
  } catch (err) {
    errorBodyLog.warn(`Failed to read response body snippet: ${formatErrorMessage(err)}`);
    return "";
  }
}
