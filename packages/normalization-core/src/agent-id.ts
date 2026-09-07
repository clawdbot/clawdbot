import { err, ok, type Result } from "./result.js";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.js";

const DEFAULT_AGENT_ID = "main";
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

/** Normalizes an OpenClaw agent id to its filesystem-safe canonical form. */
export function normalizeAgentId(value: string | undefined | null): string {
  const result = normalizeAgentIdStrict(value);
  return result.ok ? result.value : DEFAULT_AGENT_ID;
}

/** Normalizes an explicitly supplied agent id without falling back to the default agent. */
export function normalizeAgentIdStrict(
  value: string | undefined | null,
): Result<string, "unrepresentable"> {
  const trimmed = (value ?? "").trim();
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (VALID_ID_RE.test(trimmed)) {
    return ok(normalized);
  }
  const agentId = normalized
    .replace(INVALID_CHARS_RE, "-")
    .replace(LEADING_DASH_RE, "")
    .replace(TRAILING_DASH_RE, "")
    .slice(0, 64);
  return agentId ? ok(agentId) : err("unrepresentable");
}

/** Returns whether a value is already a canonical agent-id input. */
export function isValidAgentId(value: string | undefined | null): boolean {
  const trimmed = (value ?? "").trim();
  return Boolean(trimmed) && VALID_ID_RE.test(trimmed);
}
