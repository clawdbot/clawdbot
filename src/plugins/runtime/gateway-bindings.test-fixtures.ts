/** Clears gateway plugin runtime bindings between tests. */
import { gatewaySubagentState } from "./gateway-bindings.js";

export function clearGatewaySubagentRuntime(): void {
  gatewaySubagentState.subagent = undefined;
  gatewaySubagentState.nodes = undefined;
}
