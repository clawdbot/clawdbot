import { listProviderChannelLoginChoices } from "../plugins/provider-login-options.js";
/** Built-in command registry data for auto-reply commands. */
import { buildBuiltinChatCommands } from "./commands-registry.shared.js";
import type { ChatCommandDefinition } from "./commands-registry.types.js";
import { listThinkingLevels } from "./thinking.js";

let cachedCommands: ChatCommandDefinition[] | null = null;

/** Returns the built-in command registry with runtime thinking-level choices. */
export function getChatCommands(): ChatCommandDefinition[] {
  return (cachedCommands ??= buildBuiltinChatCommands({
    listThinkingLevels,
    listProviderLoginChoices: () =>
      listProviderChannelLoginChoices().map((choice) => ({
        value: choice.command,
        label: choice.label,
      })),
  }));
}
