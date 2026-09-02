/** Text-command routing decisions for surfaces that may also support native commands. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getLoadedChannelPluginById } from "../channels/plugins/registry-loaded.js";
import type { ShouldHandleTextCommandsParams } from "./commands-registry.types.js";

/** Returns whether a surface can receive provider-native slash commands. */
export function isNativeCommandSurface(surface?: string): boolean {
  const normalized = normalizeOptionalLowercaseString(surface);
  if (!normalized) {
    return false;
  }
  return getLoadedChannelPluginById(normalized)?.capabilities?.nativeCommands === true;
}

/** Decides whether text slash commands remain active for the current surface/config pair. */
export function shouldHandleTextCommands(params: ShouldHandleTextCommandsParams): boolean {
  if (params.commandSource === "native") {
    return true;
  }
  if (params.cfg.commands?.text !== false) {
    return true;
  }
  return !isNativeCommandSurface(params.surface);
}
