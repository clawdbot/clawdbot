import type { OpenClawConfig } from "../../config/types.openclaw.js";

export type GatewayRunRuntimeHooks = {
  releaseManagedProxy?: () => Promise<void> | void;
  refreshManagedProxy?: (config: OpenClawConfig["proxy"]) => Promise<void> | void;
};

let activeGatewayRunRuntimeHooks: GatewayRunRuntimeHooks = {};

export function getGatewayRunRuntimeHooks(): GatewayRunRuntimeHooks {
  return activeGatewayRunRuntimeHooks;
}

export function installGatewayRunRuntimeHooks(hooks: GatewayRunRuntimeHooks): () => void {
  const previous = activeGatewayRunRuntimeHooks;
  activeGatewayRunRuntimeHooks = hooks;
  return () => {
    if (activeGatewayRunRuntimeHooks === hooks) {
      activeGatewayRunRuntimeHooks = previous;
    }
  };
}
