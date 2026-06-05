// Workboard API module exposes the plugin public contract.
export { registerWorkboardGatewayMethods } from "./src/gateway.js";
export type {
  WorkboardCard,
  WorkboardClaim,
  WorkboardDiagnostic,
  WorkboardListResult,
  WorkboardPriority,
  WorkboardStatus,
} from "./src/types.js";
