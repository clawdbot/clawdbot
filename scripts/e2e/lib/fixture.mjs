// Shared command fixture dispatcher for E2E scripts.
import { configCommands } from "./fixtures/config.mjs";
import { pluginCommands } from "./fixtures/plugins.mjs";
import { workspaceCommands } from "./fixtures/workspace.mjs";

const [command, ...args] = process.argv.slice(2);

const handler = {
  ...pluginCommands,
  ...configCommands,
  ...workspaceCommands,
}[command];
if (!handler) {
  throw new Error(`unknown fixture command: ${command}`);
}

handler(args);
