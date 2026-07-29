/**
 * Session defaults.
 *
 * Centralizes fallback thinking settings for sessions without model-specific overrides.
 */
import type { ThinkingLevel } from "../runtime/index.js";

/** Default thinking level for sessions that do not specify a model-specific override. */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
