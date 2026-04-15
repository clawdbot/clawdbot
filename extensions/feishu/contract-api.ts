export { createFeishuThreadBindingManager } from "./src/thread-bindings.js";
export { __testing as feishuThreadBindingTesting } from "./src/thread-bindings.js";
export {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./src/secret-contract.js";
export { collectFeishuSecurityAuditFindings } from "./src/security-audit.js";
export { messageActionTargetAliases } from "./src/message-action-contract.js";
export {
  buildFeishuConversationId,
  parseFeishuConversationId,
  parseFeishuDirectConversationId,
  parseFeishuTargetId,
} from "./src/conversation-id.js";

export const feishuSessionBindingAdapterChannels = ["feishu"] as const;
