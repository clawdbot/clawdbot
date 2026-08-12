// Workboard API module exposes the plugin public contract.
export { registerWorkboardGatewayMethods } from "./src/gateway.js";
export type {
  WorkboardCard,
  WorkboardClaim,
  WorkboardDiagnostic,
  WorkboardExternalExecutionLink,
  WorkboardListResult,
  WorkboardPriority,
  WorkboardReconciliationApplyResult,
  WorkboardReconciliationObservation,
  WorkboardReconciliationSourceObservation,
  WorkboardReconciliationPage,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
