/**
 * Compaction instruction utilities.
 *
 * Provides default language-preservation instructions and a precedence-based
 * resolver for customInstructions used during context compaction summaries.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/**
 * Default instructions injected into every safeguard-mode compaction summary.
 * Preserves conversation language and persona while keeping the SDK's required
 * summary structure intact.
 */
const DEFAULT_COMPACTION_INSTRUCTIONS =
  "Write the summary body in the primary language used in the conversation.\n" +
  "Focus on factual content: what was discussed, decisions made, and current state.\n" +
  "Keep the required summary structure and section headers unchanged.\n" +
  "Do not translate or alter code, file paths, identifiers, or error messages.";

/**
 * Upper bound on custom instruction length to prevent prompt bloat.
 * ~800 chars ≈ ~200 tokens — keeps summarization quality stable.
 */
const MAX_INSTRUCTION_LENGTH = 800;

/**
 * Resolve compaction instructions with precedence:
 *   event (SDK) → runtime (config) → DEFAULT constant.
 *
 * Each input is normalized first (trim + empty→undefined) so that blank
 * strings don't short-circuit the fallback chain.
 */
export function resolveCompactionInstructions(
  eventInstructions: string | undefined,
  runtimeInstructions: string | undefined,
): string {
  const resolved =
    normalizeOptionalString(eventInstructions) ??
    normalizeOptionalString(runtimeInstructions) ??
    DEFAULT_COMPACTION_INSTRUCTIONS;
  return Array.from(resolved).slice(0, MAX_INSTRUCTION_LENGTH).join("");
}
