// Normalizes origin route fields from inbound messages and provider context.
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { OriginatingChannelType } from "../templating.js";

/** Resolves the original message provider before reply redirection. */
export function resolveOriginMessageProvider(params: {
  originatingChannel?: OriginatingChannelType;
  provider?: string;
}): string | undefined {
  return (
    normalizeMessageChannel(params.originatingChannel) ?? normalizeMessageChannel(params.provider)
  );
}
