// Re-exports plugin modules used by build smoke checks.
export { classifyFailoverReason } from "../agents/embedded-agent-helpers.js";
export { clearPluginCommands, executePluginCommand, matchPluginCommand } from "./commands.js";
export { getPluginCommandSpecs } from "./command-specs.js";
export { loadOpenClawPlugins, loadPluginRegistryHandle } from "./loader.js";
