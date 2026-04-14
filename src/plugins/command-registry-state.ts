import { getChannelPlugin } from "../channels/plugins/index.js";
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

function resolvePluginNativeName(
  command: OpenClawPluginCommandDefinition,
  provider?: string,
): string {
  const providerName = normalizeOptionalLowercaseString(provider);
  const providerOverride = providerName ? command.nativeNames?.[providerName] : undefined;
  if (typeof providerOverride === "string" && providerOverride.trim()) {
    return providerOverride.trim();
  }
  const defaultOverride = command.nativeNames?.default;
  if (typeof defaultOverride === "string" && defaultOverride.trim()) {
    return defaultOverride.trim();
  }
  return command.name;
}

export function getPluginCommandSpecs(provider?: string): Array<{
  name: string;
  description: string;
  acceptsArgs: boolean;
}> {
  const providerName = normalizeOptionalLowercaseString(provider);
  if (
    providerName &&
    getChannelPlugin(providerName)?.commands?.nativeCommandsAutoEnabled !== true
  ) {
    return [];
  }
  return listProviderPluginCommandSpecs(provider);
}

/** Resolve plugin command specs for a provider's native naming surface without support gating. */
export function listProviderPluginCommandSpecs(provider?: string): Array<{
  name: string;
  description: string;
  acceptsArgs: boolean;
}> {
  return Array.from(pluginCommands.values()).map((cmd) => ({
    name: resolvePluginNativeName(cmd, provider),
    description: cmd.description,
    acceptsArgs: cmd.acceptsArgs ?? false,
  }));
}
