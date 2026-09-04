import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { formatErrorMessage } from "../infra/errors.js";
import { redactToolPayloadText } from "../logging/redact.js";

const STREAMABLE_RESPONSE_BODY_MARKER = "Error POSTing to endpoint:";
const LEGACY_RESPONSE_BODY_RE = /Error POSTing to endpoint \(HTTP \d+\):/;

/** Redacts MCP diagnostics, including response bodies the SDK includes in thrown errors. */
export function redactMcpDiagnosticError(error: unknown): string {
  let message = formatErrorMessage(error);
  const streamableIndex = message.indexOf(STREAMABLE_RESPONSE_BODY_MARKER);
  const legacyMatch = LEGACY_RESPONSE_BODY_RE.exec(message);
  const prefixEnd =
    streamableIndex >= 0
      ? streamableIndex + STREAMABLE_RESPONSE_BODY_MARKER.length
      : legacyMatch
        ? legacyMatch.index + legacyMatch[0].length
        : undefined;
  if (prefixEnd !== undefined) {
    message = `${message.slice(0, prefixEnd)} [redacted response body]`;
  }
  return redactToolPayloadText(redactSensitiveUrlLikeString(message));
}
