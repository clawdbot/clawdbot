// Workboard API module exposes the plugin public contract.
export { registerWorkboardGatewayMethods } from "./src/gateway.js";
export { createRuntimeConversationSend } from "./src/closeout-tool.js";
export type { ConversationSend, ConversationSendResult } from "./src/closeout-tracker.js";
export type {
  WorkboardCard,
  WorkboardClaim,
  WorkboardDiagnostic,
  WorkboardListResult,
  WorkboardPriority,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
