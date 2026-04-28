import type { SlashCommandRegistry } from "../slash-commands.js";
import { registerApproveCommands } from "./register-approve.js";
import { registerBasicBotCommands } from "./register-basic.js";
import { registerClearStorageCommands } from "./register-clear-storage.js";
import { registerLogCommands } from "./register-logs.js";
import { registerStreamingCommands } from "./register-streaming.js";

/**
 * Register all built-in slash commands on the shared registry instance.
 */
export function registerBuiltinSlashCommands(registry: SlashCommandRegistry): void {
  registerBasicBotCommands(registry);
  registerLogCommands(registry);
  registerClearStorageCommands(registry);
  registerStreamingCommands(registry);
  registerApproveCommands(registry);
}
