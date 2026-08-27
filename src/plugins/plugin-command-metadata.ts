import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawPluginCommandDefinition } from "./types.js";

type PluginCommandNativeMetadata = Readonly<{
  name: string;
  description: string;
  descriptionLocalizations?: Readonly<Record<string, string>>;
  acceptsArgs: boolean;
  requireAuth: boolean;
  progressMessage?: string;
}>;

export function pluginCommandSupportsChannel(
  command: OpenClawPluginCommandDefinition,
  channel?: string,
): boolean {
  if (!command.channels || command.channels.length === 0 || !channel) {
    return true;
  }
  const normalizedChannel = normalizeOptionalLowercaseString(channel);
  return command.channels.some(
    (entry) => normalizeOptionalLowercaseString(entry) === normalizedChannel,
  );
}

/** Projects the safe provider-native metadata shared by catalog and runtime surfaces. */
export function projectPluginCommandNativeMetadata(
  command: OpenClawPluginCommandDefinition,
  provider?: string,
): PluginCommandNativeMetadata {
  const normalizedProvider = normalizeOptionalLowercaseString(provider);
  const providerName = normalizedProvider ? command.nativeNames?.[normalizedProvider] : undefined;
  const defaultName = command.nativeNames?.default;
  const name =
    typeof providerName === "string" && providerName.trim()
      ? providerName.trim()
      : typeof defaultName === "string" && defaultName.trim()
        ? defaultName.trim()
        : command.name.trim() || command.name;
  const providerProgress = normalizedProvider
    ? command.nativeProgressMessages?.[normalizedProvider]
    : undefined;
  const defaultProgress = command.nativeProgressMessages?.default;
  const progressMessage =
    typeof providerProgress === "string" && providerProgress.trim()
      ? providerProgress.trim()
      : typeof defaultProgress === "string" && defaultProgress.trim()
        ? defaultProgress.trim()
        : undefined;
  const descriptionLocalizations = command.descriptionLocalizations
    ? Object.freeze({ ...command.descriptionLocalizations })
    : undefined;
  return Object.freeze({
    name: normalizeOptionalLowercaseString(name) ?? name,
    description: command.description.trim(),
    ...(descriptionLocalizations ? { descriptionLocalizations } : {}),
    acceptsArgs: command.acceptsArgs ?? false,
    requireAuth: command.requireAuth !== false,
    ...(progressMessage ? { progressMessage } : {}),
  });
}
