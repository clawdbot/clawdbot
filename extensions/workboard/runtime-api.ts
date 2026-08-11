// Workboard API module exposes the plugin public contract.
export { createRuntimeConversationSend } from "./src/closeout-tool.js";
export {
  createCloseoutTracker,
  type CloseoutRecord,
  type CloseoutTrackerStore,
} from "./src/closeout-tracker.js";
export { registerWorkboardGatewayMethods } from "./src/gateway.js";
export type {
  WorkboardCard,
  WorkboardClaim,
  WorkboardDiagnostic,
  WorkboardListResult,
  WorkboardPriority,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
