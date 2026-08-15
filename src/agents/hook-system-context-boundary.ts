/**
 * Wraps plugin-provided system context in stable prompt-cache boundaries.
 */
import { normalizeStructuredPromptSection } from "@openclaw/ai/internal/shared";

// Labels plugin-provided system context so harness prompt compaction and user-facing
// transcript views can distinguish it from real workspace files or chat content.
const HOOK_SYSTEM_CONTEXT_HEADER =
  "OpenClaw plugin-injected system context. This block is not workspace file content.";

/** Normalizes and fences plugin-injected system context before it enters prompts. */
export function wrapPluginSystemContextSection(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeStructuredPromptSection(value);
  if (!normalized) {
    return undefined;
  }
  return `---\n\n${HOOK_SYSTEM_CONTEXT_HEADER}\n\n${normalized}\n\n---`;
}
