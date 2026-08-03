// Control UI module implements external link behavior.
import { normalizeOptionalLowercaseString } from "./string-coerce.ts";

const REQUIRED_EXTERNAL_REL_TOKENS = ["noopener", "noreferrer"] as const;

export const EXTERNAL_LINK_TARGET = "_blank";

export function buildExternalLinkRel(currentRel?: string): string {
  const extraTokens: string[] = [];
  const seen = new Set<string>(REQUIRED_EXTERNAL_REL_TOKENS);

  for (const rawToken of (currentRel ?? "").split(/\s+/)) {
    const token = normalizeOptionalLowercaseString(rawToken);
    if (!token || seen.has(token)) {
      continue;
    }
    seen.add(token);
    extraTokens.push(token);
  }

  return [...REQUIRED_EXTERNAL_REL_TOKENS, ...extraTokens].join(" ");
}
