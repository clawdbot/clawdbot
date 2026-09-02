/** Parsing for the /send override command embedded in inbound auto-reply text. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeCommandBody } from "./commands-registry.js";
import { stripInboundMetadata } from "./reply/strip-inbound-meta.js";

type SendPolicyOverride = "allow" | "deny";

function normalizeSendPolicyOverride(raw?: string | null): SendPolicyOverride | undefined {
  const value = normalizeOptionalLowercaseString(raw);
  if (!value) {
    return undefined;
  }
  if (value === "allow" || value === "on") {
    return "allow";
  }
  if (value === "deny" || value === "off") {
    return "deny";
  }
  return undefined;
}

/** Parses /send commands and maps user-facing aliases to allow, deny, or inherit. */
export function parseSendPolicyCommand(raw?: string): {
  hasCommand: boolean;
  mode?: SendPolicyOverride | "inherit";
} {
  if (!raw) {
    return { hasCommand: false };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { hasCommand: false };
  }
  const stripped = stripInboundMetadata(trimmed);
  const normalized = normalizeCommandBody(stripped);
  const match = normalized.match(/^\/send(?:\s+([a-zA-Z]+))?\s*$/i);
  if (!match) {
    return { hasCommand: false };
  }
  const token = normalizeOptionalLowercaseString(match[1]);
  if (!token) {
    return { hasCommand: true };
  }
  if (token === "inherit" || token === "default" || token === "reset") {
    return { hasCommand: true, mode: "inherit" };
  }
  const mode = normalizeSendPolicyOverride(token);
  return { hasCommand: true, mode };
}
