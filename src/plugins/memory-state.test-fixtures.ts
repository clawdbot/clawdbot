/** Test-only compatibility fixtures for plugin memory state. */
import { registerMemoryCapability, type MemoryPromptSectionBuilder } from "./memory-state.js";

export * from "./memory-state.js";

export function registerTestMemoryPromptBuilder(builder: MemoryPromptSectionBuilder): void {
  registerMemoryCapability("test-memory", { promptBuilder: builder });
}
