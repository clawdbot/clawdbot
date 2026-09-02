import {
  normalizeConversationReadInvocationOrigin,
  type ConversationReadInvocationOrigin,
} from "../channels/plugins/conversation-read-origin.js";
import type { GatewayClient } from "./server-methods/types.js";

/**
 * Resolves one RPC's requested operator origin. Connection metadata is not an
 * authority signal, and a server-attested agent runtime always stays delegated.
 */
export function resolveGatewayConversationReadOrigin(params: {
  client: GatewayClient | null | undefined;
  requestedOrigin?: unknown;
}): ConversationReadInvocationOrigin {
  if (params.client?.internal?.agentRuntimeIdentity) {
    return "delegated";
  }
  return normalizeConversationReadInvocationOrigin(params.requestedOrigin);
}
