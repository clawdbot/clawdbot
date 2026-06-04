import { normalizeChannelId } from "./registry.js";
import { getChannelPlugin } from "./registry.js";
import type { ChannelTtsVoiceDeliveryCapabilities } from "./types.core.js";

// Resolves channel-advertised TTS voice delivery support for prompt/runtime
// routing without exposing the full plugin object to callers.
export function resolveChannelTtsVoiceDelivery(
  channel: string | undefined,
): ChannelTtsVoiceDeliveryCapabilities | undefined {
  const channelId = normalizeChannelId(channel);
  if (!channelId) {
    return undefined;
  }
  return getChannelPlugin(channelId)?.capabilities.tts?.voice;
}
