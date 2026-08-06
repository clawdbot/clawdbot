/** Reads channel plugin output/threading policy for isolated cron delivery. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";

type ChannelPluginRuntime = typeof import("../../channels/plugins/index.js");

const channelPluginRuntimeLoader = createLazyImportLoader<ChannelPluginRuntime>(
  () => import("../../channels/plugins/index.js"),
);

async function loadChannelPluginRuntime() {
  return await channelPluginRuntimeLoader.load();
}

/** Resolves channel-specific cron output preferences from loaded channel plugins. */
export async function resolveCronChannelOutputPolicy(
  channel: string | undefined,
  opts?: { deliveryRequested?: boolean },
): Promise<{
  preferFinalAssistantVisibleText: boolean;
}> {
  const channelId = normalizeOptionalLowercaseString(channel);
  if (!channelId) {
    return { preferFinalAssistantVisibleText: opts?.deliveryRequested !== true };
  }
  const { getChannelPlugin } = await loadChannelPluginRuntime();
  return {
    preferFinalAssistantVisibleText:
      getChannelPlugin(channelId)?.outbound?.preferFinalAssistantVisibleText === true,
  };
}

/** Resolves the provider-specific current-thread target for a delivery address. */
export async function resolveCurrentChannelTarget(params: {
  channel?: string;
  to?: string;
  threadId?: string | number | null;
}): Promise<string | undefined> {
  if (!params.to) {
    return undefined;
  }
  const channelId = normalizeOptionalLowercaseString(params.channel);
  if (!channelId) {
    return params.to;
  }
  const { getChannelPlugin } = await loadChannelPluginRuntime();
  return (
    getChannelPlugin(channelId)?.threading?.resolveCurrentChannelId?.({
      to: params.to,
      threadId: params.threadId,
    }) ?? params.to
  );
}
