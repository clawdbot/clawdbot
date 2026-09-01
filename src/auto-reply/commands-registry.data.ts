/** Built-in command registry data for auto-reply commands. */
import { buildBuiltinChatCommands } from "./commands-registry.shared.js";
import type { ChatCommandDefinition } from "./commands-registry.types.js";
import { listThinkingLevels } from "./thinking.js";

let cachedCommands: ChatCommandDefinition[] | null = null;

/** Returns the built-in command registry with runtime thinking-level choices. */
export function getChatCommands(): ChatCommandDefinition[] {
  return (cachedCommands ??= buildBuiltinChatCommands({ listThinkingLevels }));
}
