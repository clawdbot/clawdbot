import type { ProviderFailoverErrorContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_CLI_BACKEND_ID } from "./cli-constants.js";

const CLAUDE_CLI_USAGE_LIMIT_RE = /\byou(?:['\u2019]ve| have) hit your (?:session )?limit\b/i;

function classifyAnthropicFailoverDescriptor(value: string | undefined) {
  switch (value?.trim().toUpperCase()) {
    case "RATE_LIMIT_ERROR":
      return "rate_limit" as const;
    case "API_ERROR":
      return "server_error" as const;
    default:
      return undefined;
  }
}

export function classifyAnthropicFailoverReason({
  provider,
  errorMessage,
  code,
  errorType,
}: ProviderFailoverErrorContext) {
  const descriptorReason =
    classifyAnthropicFailoverDescriptor(errorType) ?? classifyAnthropicFailoverDescriptor(code);
  if (descriptorReason) {
    return descriptorReason;
  }
  // Claude CLI reports subscription exhaustion as prose rather than an API descriptor.
  // Keep this provider-gated so unrelated session-limit errors retain their meaning.
  if (
    normalizeLowercaseStringOrEmpty(provider) === CLAUDE_CLI_BACKEND_ID &&
    CLAUDE_CLI_USAGE_LIMIT_RE.test(errorMessage)
  ) {
    return "rate_limit" as const;
  }
  return undefined;
}
