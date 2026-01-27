/**
 * Plugin Command Registry
 *
 * Manages commands registered by plugins that bypass the LLM agent.
 * These commands are processed before built-in commands and before agent invocation.
 */

import type { MoltbotConfig } from "../config/config.js";
import type {
  MoltbotPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "./types.js";
import { logVerbose } from "../globals.js";

type RegisteredPluginCommand = MoltbotPluginCommandDefinition & {
  pluginId: string;
};

// Registry of plugin commands
const pluginCommands: Map<string, RegisteredPluginCommand> = new Map();

// Lock to prevent modifications during command execution
let registryLocked = false;

// Maximum allowed length for command arguments (defense in depth)
const MAX_ARGS_LENGTH = 4096;

/**
 * Reserved command names that plugins cannot override.
 * These are built-in commands from commands-registry.data.ts.
 */
const RESERVED_COMMANDS = new Set([
  // Core commands
  "help",
  "commands",
  "status",
  "whoami",
  "context",
  // Session management
  "stop",
  "restart",
  "reset",
  "new",
  "compact",
  // Configuration
  "config",
  "debug",
  "allowlist",
  "activation",
  // Agent control
  "skill",
  "subagents",
  "model",
  "models",
  "queue",
  // Messaging
  "send",
  // Execution
  "bash",
  "exec",
  // Mode toggles
  "think",
  "verbose",
  "reasoning",
  "elevated",
  // Billing
  "usage",
]);

/**
 * Validate a command name.
 * Returns an error message if invalid, or null if valid.
 */
export function validateCommandName(name: string): string | null {
  const trimmed = name.trim().toLowerCase();

  if (!trimmed) {
    return "Command name cannot be empty";
  }

  // Must start with a letter, contain only letters, numbers, hyphens, underscores
  // Note: trimmed is already lowercased, so no need for /i flag
  if (!/^[a-z][a-z0-9_-]*$/.test(trimmed)) {
    return "Command name must start with a letter and contain only letters, numbers, hyphens, and underscores";
  }

  // Check reserved commands
  if (RESERVED_COMMANDS.has(trimmed)) {
    return `Command name "${trimmed}" is reserved by a built-in command`;
  }

  return null;
}

export type CommandRegistrationResult = {
  ok: boolean;
  error?: string;
};

/**
 * Register a plugin command.
 * Returns an error if the command name is invalid or reserved.
 */
export function registerPluginCommand(
  pluginId: string,
  command: MoltbotPluginCommandDefinition,
): CommandRegistrationResult {
  // Prevent registration while commands are being processed
  if (registryLocked) {
    return { ok: false, error: "Cannot register commands while processing is in progress" };
  }

  // Validate handler is a function
  if (typeof command.handler !== "function") {
    return { ok: false, error: "Command handler must be a function" };
  }

  const validationError = validateCommandName(command.name);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  const key = `/${command.name.toLowerCase()}`;

  // Check for duplicate registration
  if (pluginCommands.has(key)) {
    const existing = pluginCommands.get(key)!;
    return {
      ok: false,
      error: `Command "${command.name}" already registered by plugin "${existing.pluginId}"`,
    };
  }

  pluginCommands.set(key, { ...command, pluginId });
  logVerbose(`Registered plugin command: ${key} (plugin: ${pluginId})`);
  return { ok: true };
}

/**
 * Clear all registered plugin commands.
 * Called during plugin reload.
 */
export function clearPluginCommands(): void {
  pluginCommands.clear();
}

/**
 * Clear plugin commands for a specific plugin.
 */
export function clearPluginCommandsForPlugin(pluginId: string): void {
  for (const [key, cmd] of pluginCommands.entries()) {
    if (cmd.pluginId === pluginId) {
      pluginCommands.delete(key);
    }
  }
}

/**
 * Check if a command body matches a registered plugin command.
 * Returns the command definition and parsed args if matched.
 *
 * Note: If a command has `acceptsArgs: false` and the user provides arguments,
 * the command will not match. This allows the message to fall through to
 * built-in handlers or the agent. Document this behavior to plugin authors.
 */
export function matchPluginCommand(
  commandBody: string,
): { command: RegisteredPluginCommand; args?: string } | null {
  const trimmed = commandBody.trim();
  if (!trimmed.startsWith("/")) return null;

  // Extract command name and args
  const spaceIndex = trimmed.indexOf(" ");
  const commandName = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const args = spaceIndex === -1 ? undefined : trimmed.slice(spaceIndex + 1).trim();

  const key = commandName.toLowerCase();
  const command = pluginCommands.get(key);

  if (!command) return null;

  // If command doesn't accept args but args were provided, don't match
  if (args && !command.acceptsArgs) return null;

  return { command, args: args || undefined };
}

/**
 * Sanitize command arguments to prevent injection attacks.
 * Removes control characters and enforces length limits.
 */
function sanitizeArgs(args: string | undefined): string | undefined {
  if (!args) return undefined;

  // Enforce length limit
  if (args.length > MAX_ARGS_LENGTH) {
    return args.slice(0, MAX_ARGS_LENGTH);
  }

  // Remove control characters (except newlines and tabs which may be intentional)
  let sanitized = "";
  for (const char of args) {
    const code = char.charCodeAt(0);
    const isControl = (code <= 0x1f && code !== 0x09 && code !== 0x0a) || code === 0x7f;
    if (!isControl) sanitized += char;
  }
  return sanitized;
}

/**
 * Execute a plugin command handler.
 *
 * Note: Plugin authors should still validate and sanitize ctx.args for their
 * specific use case. This function provides basic defense-in-depth sanitization.
 */
export async function executePluginCommand(params: {
  command: RegisteredPluginCommand;
  args?: string;
  senderId?: string;
  channel: string;
  isAuthorizedSender: boolean;
  commandBody: string;
  config: MoltbotConfig;
}): Promise<PluginCommandResult> {
  const { command, args, senderId, channel, isAuthorizedSender, commandBody, config } = params;

  // Check authorization
  const requireAuth = command.requireAuth !== false; // Default to true
  if (requireAuth && !isAuthorizedSender) {
    logVerbose(
      `Plugin command /${command.name} blocked: unauthorized sender ${senderId || "<unknown>"}`,
    );
    return { text: "⚠️ This command requires authorization." };
  }

  // Sanitize args before passing to handler
  const sanitizedArgs = sanitizeArgs(args);

  const ctx: PluginCommandContext = {
    senderId,
    channel,
    isAuthorizedSender,
    args: sanitizedArgs,
    commandBody,
    config,
  };

  // Lock registry during execution to prevent concurrent modifications
  registryLocked = true;
  try {
    const result = await command.handler(ctx);
    logVerbose(
      `Plugin command /${command.name} executed successfully for ${senderId || "unknown"}`,
    );
    return result;
  } catch (err) {
    const error = err as Error;
    logVerbose(`Plugin command /${command.name} error: ${error.message}`);
    // Don't leak internal error details - return a safe generic message
    return { text: "⚠️ Command failed. Please try again later." };
  } finally {
    registryLocked = false;
  }
}

/**
 * List all registered plugin commands.
 * Used for /help and /commands output.
 */
export function listPluginCommands(): Array<{
  name: string;
  description: string;
  pluginId: string;
}> {
  return Array.from(pluginCommands.values()).map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    pluginId: cmd.pluginId,
  }));
}

/**
 * Get plugin command specs for native command registration (e.g., Telegram).
 */
export function getPluginCommandSpecs(): Array<{
  name: string;
  description: string;
}> {
  return Array.from(pluginCommands.values()).map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
  }));
}
