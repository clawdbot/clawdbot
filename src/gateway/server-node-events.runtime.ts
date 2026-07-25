// Runtime import barrel for node event handlers. Keeping these dependencies in
// one lazy boundary prevents gateway startup paths from loading every node-event
// helper before node traffic is actually handled.
export { resolveSessionAgentId } from "../agents/agent-scope.js";
export { sanitizeInboundSystemTags } from "../auto-reply/reply/inbound-text.js";
export { normalizeChannelId } from "../channels/plugins/index.js";
export { sendDurableMessageBatch } from "../channels/message/runtime.js";
export { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
export { agentCommandFromIngress } from "../commands/agent.js";
export { getRuntimeConfig } from "../config/io.js";
export { canonicalizeSessionEntryAliases } from "../config/sessions.js";
export { loadOrCreateProcessDeviceIdentity } from "../infra/device-identity.js";
export { requestHeartbeat } from "../infra/heartbeat-wake.js";
export { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
export { resolveOutboundTarget } from "../infra/outbound/targets.js";
export {
  ApnsRegistrationPairingChangedError,
  registerApnsRegistration,
} from "../infra/push-apns.js";
export { enqueueSystemEvent } from "../infra/system-events.js";
export { deleteMediaBuffer } from "../media/store.js";
export { normalizeMainKey } from "../routing/session-key.js";
export { defaultRuntime } from "../runtime.js";
export {
  parseMessageWithAttachments,
  persistInboundImagesForTranscript,
  resolveChatAttachmentMaxBytes,
} from "./chat-attachments.js";
export { normalizeRpcAttachmentsToChatAttachments } from "./server-methods/attachment-normalize.js";
export {
  loadSessionEntry,
  resolveGatewayModelSupportsImages,
  resolveSessionModelRef,
} from "./session-utils.js";
export { formatForLog } from "./ws-log.js";
