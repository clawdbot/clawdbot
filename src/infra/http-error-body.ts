import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { formatErrorMessage } from "./errors.js";
import { readResponseTextPrefix } from "./http-body.js";

const errorBodyLog = createSubsystemLogger("http-error-body");

export async function readResponseBodySnippet(
  response: Response,
  limits: { maxBytes: number; maxChars: number },
): Promise<string> {
  try {
    const body = response.body;
    if (!body || typeof body.getReader !== "function") {
      return "";
    }

    const prefix = await readResponseTextPrefix(response, limits.maxBytes);
    return truncateUtf16Safe(prefix.text, limits.maxChars);
  } catch (err) {
    errorBodyLog.warn(`Failed to read response body snippet: ${formatErrorMessage(err)}`);
    return "";
  }
}
