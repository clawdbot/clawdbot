/** Test-only compatibility fixtures for plugin memory state. */
import { registerMemoryCapability, type MemoryPromptSectionBuilder } from "./memory-state.js";

export * from "./memory-state.js";

const TEST_MEMORY_PLUGIN_ID = "memory-core";

function registerMemoryPromptSection(builder: MemoryPromptSectionBuilder): void {
  registerMemoryCapability(TEST_MEMORY_PLUGIN_ID, { promptBuilder: builder });
}

export function registerTestMemoryPromptBuilder(builder: MemoryPromptSectionBuilder): void {
  registerMemoryPromptSection(builder);
}
