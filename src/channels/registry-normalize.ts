import type { ActivePluginChannelRegistration } from "../plugins/channel-registry-state.types.js";
import { getActivePluginChannelRegistryFromState } from "../plugins/runtime-channel-state.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import type { ChannelId } from "./plugins/channel-id.types.js";

function listRegisteredChannelPluginEntries(): ActivePluginChannelRegistration[] {
  const channelRegistry = getActivePluginChannelRegistryFromState();
  if (channelRegistry?.channels && channelRegistry.channels.length > 0) {
    return channelRegistry.channels;
  }
  return [];
}

export function normalizeAnyChannelId(raw?: string | null): ChannelId | null {
  const key = normalizeOptionalLowercaseString(raw);
  if (!key) {
    return null;
  }
  return (
    listRegisteredChannelPluginEntries().find((entry) => {
      const id = normalizeOptionalLowercaseString(entry.plugin.id ?? "") ?? "";
      if (id && id === key) {
        return true;
      }
      return (entry.plugin.meta?.aliases ?? []).some(
        (alias) => normalizeOptionalLowercaseString(alias) === key,
      );
    })?.plugin.id ?? null
  );
}
