// Gateway hook routing policy helpers.
// Normalizes configured agent allowlists for hook dispatch.
import { normalizeAgentId } from "../routing/session-key.js";

// Hook policy config narrows hooks to explicit agent ids. A wildcard means no
// restriction, matching the gateway hook routing contract.
/** Resolves configured hook agent ids, or undefined when all agents are allowed. */
export function resolveAllowedAgentIds(raw: string[] | undefined): Set<string> | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const allowed = new Set<string>();
  let hasWildcard = false;
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "*") {
      hasWildcard = true;
      break;
    }
    allowed.add(normalizeAgentId(trimmed));
  }
  if (hasWildcard) {
    return undefined;
  }
  return allowed;
}
