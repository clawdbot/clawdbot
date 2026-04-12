import { listLoadedChannelPlugins } from "../channels/plugins/registry-loaded.js";
import { getActivePluginChannelRegistryVersionFromState } from "../plugins/runtime-channel-state.js";
import {
  assertCommandRegistry,
  buildBuiltinChatCommands,
  defineChatCommand,
} from "./commands-registry.shared.js";
import type { ChatCommandDefinition } from "./commands-registry.types.js";

type ChannelPlugin = ReturnType<typeof listLoadedChannelPlugins>[number];

function supportsNativeCommands(plugin: ChannelPlugin): boolean {
  return plugin.capabilities?.nativeCommands === true;
}

function defineDockCommand(plugin: ChannelPlugin): ChatCommandDefinition {
  return defineChatCommand({
    key: `dock:${plugin.id}`,
    nativeName: `dock_${plugin.id}`,
    description: `Switch to ${plugin.id} for replies.`,
    textAliases: [`/dock-${plugin.id}`, `/dock_${plugin.id}`],
    category: "docks",
  });
}

let cachedCommands: ChatCommandDefinition[] | null = null;
let cachedRegistryVersion = -1;
let cachedNativeCommandSurfaces: Set<string> | null = null;
let cachedNativeRegistryVersion = -1;

function buildChatCommands(): ChatCommandDefinition[] {
  const commands: ChatCommandDefinition[] = [
    ...buildBuiltinChatCommands(),
    ...listLoadedChannelPlugins()
      .filter(supportsNativeCommands)
      .map((plugin) => defineDockCommand(plugin)),
  ];

  assertCommandRegistry(commands);
  return commands;
}

export function getChatCommands(): ChatCommandDefinition[] {
  const registryVersion = getActivePluginChannelRegistryVersionFromState();
  if (cachedCommands && registryVersion === cachedRegistryVersion) {
    return cachedCommands;
  }
  const commands = buildChatCommands();
  cachedCommands = commands;
  cachedRegistryVersion = registryVersion;
  cachedNativeCommandSurfaces = null;
  return commands;
}

export function getNativeCommandSurfaces(): Set<string> {
  const registryVersion = getActivePluginChannelRegistryVersionFromState();
  if (cachedNativeCommandSurfaces && registryVersion === cachedNativeRegistryVersion) {
    return cachedNativeCommandSurfaces;
  }
  cachedNativeCommandSurfaces = new Set(
    listLoadedChannelPlugins()
      .filter(supportsNativeCommands)
      .map((plugin) => plugin.id),
  );
  cachedNativeRegistryVersion = registryVersion;
  return cachedNativeCommandSurfaces;
}
