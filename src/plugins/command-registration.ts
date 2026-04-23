import { logVerbose } from "../globals.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import {
  clearPluginCommands,
  clearPluginCommandsForPlugin,
  getPluginCommandSpecs,
  isPluginCommandRegistryLocked,
  listProviderPluginCommandSpecs,
  pluginCommands,
  type RegisteredPluginCommand,
} from "./command-registry-state.js";
import type { OpenClawPluginCommandDefinition } from "./types.js";

/**
 * Reserved command names that plugins cannot override (built-in commands).
 *
 * Constructed lazily inside validateCommandName to avoid TDZ errors: the
 * bundler can place this module's body after call sites within the same
 * output chunk, so any module-level const/let would be uninitialized when
 * first accessed during plugin registration.
 */
let reservedCommands: Set<string> | undefined;

export type CommandRegistrationResult = {
  ok: boolean;
  error?: string;
};

export function validateCommandName(name: string): string | null {
  const trimmed = normalizeOptionalLowercaseString(name) ?? "";

  if (!trimmed) {
    return "Command name cannot be empty";
  }

  // Must start with a letter, contain only letters, numbers, hyphens, underscores
  // Note: trimmed is already lowercased, so no need for /i flag
  if (!/^[a-z][a-z0-9_-]*$/.test(trimmed)) {
    return "Command name must start with a letter and contain only letters, numbers, hyphens, and underscores";
  }

  reservedCommands ??= new Set([
    "help",
    "commands",
    "status",
    "whoami",
    "context",
    "btw",
    "stop",
    "restart",
    "reset",
    "new",
    "compact",
    "config",
    "debug",
    "allowlist",
    "activation",
    "skill",
    "subagents",
    "kill",
    "steer",
    "tell",
    "model",
    "models",
    "queue",
    "send",
    "bash",
    "exec",
    "think",
    "verbose",
    "reasoning",
    "elevated",
    "usage",
  ]);

  if (reservedCommands.has(trimmed)) {
    return `Command name "${trimmed}" is reserved by a built-in command`;
  }

  return null;
}

/**
 * Validate a plugin command definition without registering it.
 * Returns an error message if invalid, or null if valid.
 * Shared by both the global registration path and snapshot (non-activating) loads.
 */
export function validatePluginCommandDefinition(
  command: OpenClawPluginCommandDefinition,
): string | null {
  if (typeof command.handler !== "function") {
    return "Command handler must be a function";
  }
  if (typeof command.name !== "string") {
    return "Command name must be a string";
  }
  if (typeof command.description !== "string") {
    return "Command description must be a string";
  }
  if (!command.description.trim()) {
    return "Command description cannot be empty";
  }
  const nameError = validateCommandName(command.name.trim());
  if (nameError) {
    return nameError;
  }
  for (const [label, alias] of Object.entries(command.nativeNames ?? {})) {
    if (typeof alias !== "string") {
      continue;
    }
    const aliasError = validateCommandName(alias.trim());
    if (aliasError) {
      return `Native command alias "${label}" invalid: ${aliasError}`;
    }
  }
  for (const [label, message] of Object.entries(command.nativeProgressMessages ?? {})) {
    if (typeof message !== "string") {
      return `Native progress message "${label}" must be a string`;
    }
    if (!message.trim()) {
      return `Native progress message "${label}" cannot be empty`;
    }
  }
  return null;
}

export function listPluginInvocationKeys(command: OpenClawPluginCommandDefinition): string[] {
  const keys = new Set<string>();
  const push = (value: string | undefined) => {
    const normalized = normalizeOptionalLowercaseString(value);
    if (!normalized) {
      return;
    }
    keys.add(`/${normalized}`);
  };

  push(command.name);
  for (const alias of Object.values(command.nativeNames ?? {})) {
    if (typeof alias === "string") {
      push(alias);
    }
  }

  return [...keys];
}

export function registerPluginCommand(
  pluginId: string,
  command: OpenClawPluginCommandDefinition,
  opts?: { pluginName?: string; pluginRoot?: string },
): CommandRegistrationResult {
  // Prevent registration while commands are being processed
  if (isPluginCommandRegistryLocked()) {
    return { ok: false, error: "Cannot register commands while processing is in progress" };
  }

  const definitionError = validatePluginCommandDefinition(command);
  if (definitionError) {
    return { ok: false, error: definitionError };
  }

  const name = command.name.trim();
  const description = command.description.trim();
  const normalizedCommand = {
    ...command,
    name,
    description,
  };
  const invocationKeys = listPluginInvocationKeys(normalizedCommand);
  const key = `/${normalizeLowercaseStringOrEmpty(name)}`;

  // Check for duplicate registration
  for (const invocationKey of invocationKeys) {
    const existing =
      pluginCommands.get(invocationKey) ??
      Array.from(pluginCommands.values()).find((candidate) =>
        listPluginInvocationKeys(candidate).includes(invocationKey),
      );
    if (existing) {
      return {
        ok: false,
        error: `Command "${invocationKey.slice(1)}" already registered by plugin "${existing.pluginId}"`,
      };
    }
  }

  pluginCommands.set(key, {
    ...normalizedCommand,
    pluginId,
    pluginName: opts?.pluginName,
    pluginRoot: opts?.pluginRoot,
  });
  logVerbose(`Registered plugin command: ${key} (plugin: ${pluginId})`);
  return { ok: true };
}

export {
  clearPluginCommands,
  clearPluginCommandsForPlugin,
  getPluginCommandSpecs,
  listProviderPluginCommandSpecs,
};
export type { RegisteredPluginCommand };
