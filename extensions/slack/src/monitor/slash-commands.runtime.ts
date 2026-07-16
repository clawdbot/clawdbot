import {
  buildCommandTextFromArgs as buildCommandTextFromArgsImpl,
  findCommandByNativeName as findCommandByNativeNameImpl,
  listNativeCommandSpecsForConfig as listNativeCommandSpecsForConfigImpl,
  parseCommandArgs as parseCommandArgsImpl,
  resolveCommandArgMenu as resolveCommandArgMenuImpl,
} from "openclaw/plugin-sdk/command-auth";

type BuildCommandTextFromArgs =
  typeof import("openclaw/plugin-sdk/command-auth").buildCommandTextFromArgs;
type FindCommandByNativeName =
  typeof import("openclaw/plugin-sdk/command-auth").findCommandByNativeName;
type ListNativeCommandSpecsForConfig =
  typeof import("openclaw/plugin-sdk/command-auth").listNativeCommandSpecsForConfig;
type ParseCommandArgs = typeof import("openclaw/plugin-sdk/command-auth").parseCommandArgs;
type ResolveCommandArgMenu =
  typeof import("openclaw/plugin-sdk/command-auth").resolveCommandArgMenu;

export function buildCommandTextFromArgs(
  ...args: Parameters<BuildCommandTextFromArgs>
): ReturnType<BuildCommandTextFromArgs> {
  return buildCommandTextFromArgsImpl(...args);
}

export function findCommandByNativeName(
  ...args: Parameters<FindCommandByNativeName>
): ReturnType<FindCommandByNativeName> {
  return findCommandByNativeNameImpl(...args);
}

export function listNativeCommandSpecsForConfig(
  ...args: Parameters<ListNativeCommandSpecsForConfig>
): ReturnType<ListNativeCommandSpecsForConfig> {
  return listNativeCommandSpecsForConfigImpl(...args);
}

export function parseCommandArgs(
  ...args: Parameters<ParseCommandArgs>
): ReturnType<ParseCommandArgs> {
  return parseCommandArgsImpl(...args);
}

export function resolveCommandArgMenu(
  ...args: Parameters<ResolveCommandArgMenu>
): ReturnType<ResolveCommandArgMenu> {
  return resolveCommandArgMenuImpl(...args);
}
