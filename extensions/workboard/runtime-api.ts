// Workboard API module exposes the plugin public contract.
export { registerWorkboardGatewayMethods } from "./src/gateway.js";
export type {
  WorkboardCard,
  WorkboardCardView,
  WorkboardClaim,
  WorkboardDiagnostic,
  WorkboardListResult,
  WorkboardListViewResult,
  WorkboardPriority,
  WorkboardProofPage,
  WorkboardProofPageInfo,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
