import { createSubsystemLogger } from "../logging/subsystem.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";

const embeddedLog = createSubsystemLogger("agent/embedded");

export function resolveEmbeddedAgentSessionLogger(messageChannel?: string) {
  const normalizedChannel = normalizeMessageChannel(messageChannel);
  return normalizedChannel && isDeliverableMessageChannel(normalizedChannel)
    ? createSubsystemLogger(`gateway/channels/${normalizedChannel}`)
    : embeddedLog;
}
