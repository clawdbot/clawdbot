/**
 * System prompt cache-boundary helpers.
 *
 * Keeps stable prompt prefixes separate from dynamic runtime additions for provider prompt caching.
 */
import { normalizeStructuredPromptSection } from "./prompt-cache-stability.js";

export const SYSTEM_PROMPT_CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n";

/**
 * Delimits a bounded region of the system prompt that carries no behavioral
 * guidance: per-session runtime facts. Transports whose tool schemas serialize
 * after the system message may move this region behind them so the cacheable
 * prefix stays byte-identical across sessions.
 *
 * Bounded at both ends rather than running to the end of the prompt, because
 * callers append once it is built — an `appendSystemContext` hook, a permission
 * refresh notice — and an open-ended region would sweep those into the relocated
 * text and demote them to user content.
 */
// The marker text is hyphenated rather than underscored on purpose: an
// `OPENCLAW_*` token here would register as a new environment-variable name in
// the `config/env-var-count-budget.txt` ratchet, which is meant to ratchet down.
export const SYSTEM_PROMPT_RELOCATABLE_BOUNDARY = "\n<!-- OPENCLAW-RELOCATABLE-BOUNDARY -->\n";
export const SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END = "\n<!-- /OPENCLAW-RELOCATABLE-BOUNDARY -->";

export function stripSystemPromptCacheBoundary(text: string): string {
  // Both internal markers are stripped here so every existing caller keeps the
  // guarantee that no marker reaches a provider.
  return stripSystemPromptRelocatableBoundary(text.replaceAll(SYSTEM_PROMPT_CACHE_BOUNDARY, "\n"));
}

/**
 * Cut out the non-behavioral region a transport may carry past its tool schemas.
 *
 * `remainingPrompt` is the prompt with the region excised, so text appended once
 * the prompt was built — hook context, a permission notice, a section-closing
 * comment — stays in the system message in its original role. Returns undefined
 * unless both markers are present in order, leaving a prompt that carries only
 * the opening marker whole rather than relocating its remainder.
 */
export function splitSystemPromptRelocatableBoundary(
  text: string,
): { remainingPrompt: string; relocatable: string } | undefined {
  const opened = splitOnBoundary(text, SYSTEM_PROMPT_RELOCATABLE_BOUNDARY);
  if (!opened) {
    return undefined;
  }
  const closed = splitOnBoundary(opened.suffix, SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END);
  if (!closed) {
    return undefined;
  }
  return {
    remainingPrompt: [opened.prefix, closed.suffix].filter(Boolean).join("\n"),
    relocatable: closed.prefix,
  };
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

/** Shared marker split so both boundaries stay on one implementation. */
function splitOnBoundary(
  text: string,
  marker: string,
): { prefix: string; suffix: string } | undefined {
  const boundaryIndex = text.indexOf(marker);
  if (boundaryIndex === -1) {
    return undefined;
  }
  return {
    prefix: text.slice(0, boundaryIndex).trimEnd(),
    suffix: text.slice(boundaryIndex + marker.length).trimStart(),
  };
}

export function splitSystemPromptCacheBoundary(
  text: string,
): { stablePrefix: string; dynamicSuffix: string } | undefined {
  const split = splitOnBoundary(text, SYSTEM_PROMPT_CACHE_BOUNDARY);
  return split ? { stablePrefix: split.prefix, dynamicSuffix: split.suffix } : undefined;
}

/**
 * Remove only the relocatable marker, leaving the cache boundary in place for
 * transports that anchor a cache breakpoint on it. Those transports do not
 * relocate anything, so the marker must not survive into their payload.
 */
export function stripSystemPromptRelocatableBoundary(text: string): string {
  // The closing marker carries its own leading newline and is dropped whole:
  // the prompt builder closes the region on its last line, so substituting a
  // newline there would leave trailing whitespace the prompt never had.
  return text
    .replaceAll(SYSTEM_PROMPT_RELOCATABLE_BOUNDARY, "\n")
    .replaceAll(SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END, "");
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
