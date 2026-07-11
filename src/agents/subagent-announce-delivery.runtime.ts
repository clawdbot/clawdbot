/**
 * Runtime dependency barrel for subagent announcement delivery.
 *
 * Tests mock this module to isolate delivery logic from gateway, outbound
 * message routing, queue settings, hooks, and embedded-run state.
 */
export { getRuntimeConfig } from "../config/config.js";
export { resolveAgentIdFromSessionKey, resolveStorePath } from "../config/sessions.js";
export { loadSessionEntry } from "../config/sessions/session-accessor.js";
export { callGateway } from "../gateway/call.js";
export { dispatchGatewayMethodInProcess } from "../gateway/server-plugins.js";
export { resolveQueueSettings } from "../auto-reply/reply/queue.js";
export { resolveExternalBestEffortDeliveryTarget } from "../infra/outbound/best-effort-delivery.js";
export { sendMessage } from "../infra/outbound/message.js";
export { createBoundDeliveryRouter } from "../infra/outbound/bound-delivery-router.js";
export { resolveConversationIdFromTargets } from "../infra/outbound/conversation-id.js";
export { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
export {
  formatEmbeddedAgentQueueFailureSummary,
  isEmbeddedAgentRunActive,
  isEmbeddedRunAbandoned,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunSessionId,
} from "./embedded-agent-runner/runs.js";
