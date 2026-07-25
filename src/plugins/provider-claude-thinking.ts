// Leaf module for Claude thinking-profile resolution. Kept dependency-light so
// auto-reply and the plugin-sdk barrel can both import without cycling through
// `plugin-sdk/provider-model-shared`.
import {
  CLAUDE_FABLE_5_THINKING_PROFILE,
  CLAUDE_OPUS_5_THINKING_PROFILE,
  CLAUDE_SONNET_5_THINKING_PROFILE,
  resolveClaudeFable5ModelIdentity,
  resolveClaudeModelIdentity,
  resolveClaudeMythos5ModelIdentity,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeXhighEffort,
} from "@openclaw/llm-core";
import type { ProviderThinkingProfile } from "./provider-thinking.types.js";

const BASE_CLAUDE_THINKING_LEVELS = [
  { id: "off" },
  { id: "minimal" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
] as const satisfies ProviderThinkingProfile["levels"];

/** @deprecated Anthropic provider-owned model helper; do not use from third-party plugins. */
export function isClaudeAdaptiveThinkingDefaultModelId(
  /** Claude model id to check against adaptive-thinking default families. */
  modelId: string,
): boolean {
  const ref = { id: modelId };
  return supportsClaudeAdaptiveThinking(ref) && !supportsClaudeNativeXhighEffort(ref);
}

/** @deprecated Anthropic provider-owned model helper; do not use from third-party plugins. */
export function resolveClaudeThinkingProfile(
  /** Claude model id used to choose available thinking levels and defaults. */
  modelId: string,
  params?: Record<string, unknown>,
  options?: { includeNativeMax?: boolean },
): ProviderThinkingProfile {
  const ref = { id: modelId, params };
  const canonicalModelId = resolveClaudeModelIdentity(ref);
  if (resolveClaudeFable5ModelIdentity(ref) || resolveClaudeMythos5ModelIdentity(ref)) {
    return CLAUDE_FABLE_5_THINKING_PROFILE;
  }
  if (resolveClaudeSonnet5ModelIdentity(ref)) {
    return CLAUDE_SONNET_5_THINKING_PROFILE;
  }
  // Before the generic xhigh branch: Opus 5 defaults thinking on ("high"),
  // unlike Opus 4.7/4.8 whose omitted-thinking default is off.
  if (resolveClaudeOpus5ModelIdentity(ref)) {
    return CLAUDE_OPUS_5_THINKING_PROFILE;
  }
  if (supportsClaudeNativeXhighEffort(ref)) {
    return {
      levels: [...BASE_CLAUDE_THINKING_LEVELS, { id: "xhigh" }, { id: "adaptive" }, { id: "max" }],
      defaultLevel: "off",
    };
  }
  if (isClaudeAdaptiveThinkingDefaultModelId(canonicalModelId)) {
    return {
      levels: [
        ...BASE_CLAUDE_THINKING_LEVELS,
        { id: "adaptive" },
        ...(options?.includeNativeMax ? [{ id: "max" as const }] : []),
      ],
      defaultLevel: "adaptive",
    };
  }
  return { levels: BASE_CLAUDE_THINKING_LEVELS };
}
