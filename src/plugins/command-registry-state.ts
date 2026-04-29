import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import type { OpenClawPluginCommandDefinition } from "./types.js";

export type RegisteredPluginCommand = OpenClawPluginCommandDefinition & {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
};

type PluginCommandState = {
  pluginCommands: Map<string, RegisteredPluginCommand>;
  registryLocked: boolean;
};

const PLUGIN_COMMAND_STATE_KEY = Symbol.for("openclaw.pluginCommandsState");

const getState = () =>
  resolveGlobalSingleton<PluginCommandState>(PLUGIN_COMMAND_STATE_KEY, () => ({
    pluginCommands: new Map<string, RegisteredPluginCommand>(),
    registryLocked: false,
  }));

const getPluginCommandMap = () => getState().pluginCommands;

export const pluginCommands = new Proxy(new Map<string, RegisteredPluginCommand>(), {
  get(_target, property) {
    const value = Reflect.get(getPluginCommandMap(), property, getPluginCommandMap());
    return typeof value === "function" ? value.bind(getPluginCommandMap()) : value;
  },
});

export function isPluginCommandRegistryLocked(): boolean {
  return getState().registryLocked;
}

export function setPluginCommandRegistryLocked(locked: boolean): void {
  getState().registryLocked = locked;
}

export function clearPluginCommands(): void {
  pluginCommands.clear();
}

export function clearPluginCommandsForPlugin(pluginId: string): void {
  for (const [key, cmd] of pluginCommands.entries()) {
    if (cmd.pluginId === pluginId) {
      pluginCommands.delete(key);
    }
  }
}

export function isTrustedReservedCommandOwner(command: RegisteredPluginCommand): boolean {
  return command.ownership === "reserved";
}

export function listRegisteredPluginCommands(): RegisteredPluginCommand[] {
  return Array.from(pluginCommands.values());
}

export function listRegisteredPluginAgentPromptGuidance(): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const command of pluginCommands.values()) {
    for (const line of command.agentPromptGuidance ?? []) {
      const trimmed = line.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      lines.push(trimmed);
    }
  }
  return lines;
}

export function restorePluginCommands(commands: readonly RegisteredPluginCommand[]): void {
  pluginCommands.clear();
  for (const command of commands) {
    const name = normalizeOptionalLowercaseString(command.name);
    if (!name) {
      continue;
    }
    pluginCommands.set(`/${name}`, command);
  }
}
