import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";

type ChannelPluginRuntime = typeof import("../../channels/plugins/index.js");

let channelPluginRuntimePromise: Promise<ChannelPluginRuntime> | undefined;

async function loadChannelPluginRuntime() {
  channelPluginRuntimePromise ??= import("../../channels/plugins/index.js");
  return await channelPluginRuntimePromise;
}

export async function resolveCronChannelOutputPolicy(channel: string | undefined): Promise<{
  preferFinalAssistantVisibleText: boolean;
}> {
  const channelId = normalizeOptionalLowercaseString(channel);
  if (!channelId) {
    return { preferFinalAssistantVisibleText: false };
  }
  const { getChannelPlugin } = await loadChannelPluginRuntime();
  return {
    preferFinalAssistantVisibleText:
      getChannelPlugin(channelId)?.outbound?.preferFinalAssistantVisibleText === true,
  };
}

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
