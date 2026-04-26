import { normalizeChannelId } from "./registry.js";
import { getChannelPlugin } from "./registry.js";
import type { ChannelTtsVoiceDeliveryCapabilities } from "./types.core.js";

export function resolveChannelTtsVoiceDelivery(
  channel: string | undefined,
): ChannelTtsVoiceDeliveryCapabilities | undefined {
  const channelId = normalizeChannelId(channel);
  if (!channelId) {
    return undefined;
  }
  return getChannelPlugin(channelId)?.capabilities.tts?.voice;
}
