// Stable machine contract for external supervisors consuming gateway restart handoffs.
export const GATEWAY_RESTART_HANDOFF_PROTOCOL = "openclaw.gateway.restart-handoff";
export const GATEWAY_RESTART_HANDOFF_PROTOCOL_VERSION = 1;

export function createGatewayRestartHandoffCapabilities() {
  return {
    protocol: GATEWAY_RESTART_HANDOFF_PROTOCOL,
    protocolVersion: GATEWAY_RESTART_HANDOFF_PROTOCOL_VERSION,
    operations: ["consume"] as const,
  };
}
