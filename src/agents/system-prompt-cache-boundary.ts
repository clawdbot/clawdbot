import { normalizeStructuredPromptSection } from "./prompt-cache-stability.js";

export const SYSTEM_PROMPT_CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n";

export function stripSystemPromptCacheBoundary(text: string): string {
  return text.replaceAll(SYSTEM_PROMPT_CACHE_BOUNDARY, "\n");
}

// Append the cache boundary when a prompt has none (e.g. a hook systemPrompt override),
// so dynamic additions route into an uncached suffix instead of the cached prefix (#85203).
export function ensureSystemPromptCacheBoundary(systemPrompt: string): string {
  if (systemPrompt.trim().length === 0) {
    return systemPrompt;
  }
  return systemPrompt.includes(SYSTEM_PROMPT_CACHE_BOUNDARY)
    ? systemPrompt
    : `${systemPrompt}${SYSTEM_PROMPT_CACHE_BOUNDARY}`;
}

export function splitSystemPromptCacheBoundary(
  text: string,
): { stablePrefix: string; dynamicSuffix: string } | undefined {
  const boundaryIndex = text.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
  if (boundaryIndex === -1) {
    return undefined;
  }
  return {
    stablePrefix: text.slice(0, boundaryIndex).trimEnd(),
    dynamicSuffix: text.slice(boundaryIndex + SYSTEM_PROMPT_CACHE_BOUNDARY.length).trimStart(),
  };
}

export function prependSystemPromptAdditionAfterCacheBoundary(params: {
  systemPrompt: string;
  systemPromptAddition?: string;
}): string {
  const systemPromptAddition =
    typeof params.systemPromptAddition === "string"
      ? normalizeStructuredPromptSection(params.systemPromptAddition)
      : "";
  if (!systemPromptAddition) {
    return params.systemPrompt;
  }
  if (params.systemPrompt.trim().length === 0) {
    return systemPromptAddition;
  }

  const split = splitSystemPromptCacheBoundary(params.systemPrompt);
  if (!split) {
    return `${systemPromptAddition}\n\n${params.systemPrompt}`;
  }

  const dynamicSuffix = split.dynamicSuffix
    ? normalizeStructuredPromptSection(split.dynamicSuffix)
    : "";
  if (!dynamicSuffix) {
    return `${split.stablePrefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}${systemPromptAddition}`;
  }

  return `${split.stablePrefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}${systemPromptAddition}\n\n${dynamicSuffix}`;
}
