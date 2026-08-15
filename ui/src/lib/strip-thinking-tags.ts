// Control UI module implements strip thinking tags behavior.
import { stripAssistantInternalScaffolding } from "../../../src/shared/text/assistant-visible-text.js";

export function stripThinkingTags(value: string): string {
  return stripAssistantInternalScaffolding(value);
}
