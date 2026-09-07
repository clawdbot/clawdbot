import {
  registerOperatorBridge,
  type SecurityGatewayConfig,
} from "./local-security-gateway.js";

/**
 * Isolated Operator Module for Local Security Gateway.
 *
 * Provides operator-only administrative controls for trusted local application
 * management. Not imported or exposed to model tools or agent runtime environments.
 */

const OPERATOR_SECRET = Symbol("LOCAL_SECURITY_GATEWAY_OPERATOR_SECRET");

let operatorHandlers: {
  configure: (config: Partial<SecurityGatewayConfig>) => void;
  reset: () => void;
  clearEmergencyStop: () => void;
} | undefined = undefined;

// Register the operator bridge with local-security-gateway
registerOperatorBridge(OPERATOR_SECRET, {
  bindHandlers(handlers) {
    operatorHandlers = handlers;
  },
});

/** Configure security gateway settings from a trusted operator context. */
export function operatorConfigureGateway(config: Partial<SecurityGatewayConfig>): void {
  if (!operatorHandlers) {
    throw new Error("Operator bridge not initialized");
  }
  operatorHandlers.configure(config);
}

/** Reset security gateway configuration and state from a trusted operator context. */
export function operatorResetGateway(): void {
  if (!operatorHandlers) {
    throw new Error("Operator bridge not initialized");
  }
  operatorHandlers.reset();
}

/** Clear active emergency stop state from a trusted operator context. */
export function operatorClearEmergencyStop(): void {
  if (!operatorHandlers) {
    throw new Error("Operator bridge not initialized");
  }
  operatorHandlers.clearEmergencyStop();
}
