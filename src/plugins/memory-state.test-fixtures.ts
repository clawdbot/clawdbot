/** Test-only compatibility fixtures for plugin memory state. */
import {
  registerMemoryPromptSectionForPlugin,
  type MemoryPromptSectionBuilder,
} from "./memory-state.js";

export * from "./memory-state.js";

export function registerMemoryPromptSection(builder: MemoryPromptSectionBuilder): void {
  registerMemoryPromptSectionForPlugin("test-memory", builder);
}
