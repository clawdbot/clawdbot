import type { GatewayRecoveryRuntime } from "./server-instance-runtime.types.js";

type ActiveGatewayRecoveryRuntime = {
  owner: symbol;
  runtime: GatewayRecoveryRuntime;
};

let activeRuntime: ActiveGatewayRecoveryRuntime | undefined;

/** Registers the recovery principal owned by the latest process-global Gateway instance. */
export function registerGatewayRecoveryRuntime(runtime: GatewayRecoveryRuntime): () => void {
  const owner = Symbol("gateway-recovery-runtime");
  activeRuntime = { owner, runtime };
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    // An older Gateway may finish closing after its replacement has registered.
    // Never let that stale close clear the replacement's recovery authority.
    if (activeRuntime?.owner === owner) {
      activeRuntime = undefined;
    }
  };
}

export function getGatewayRecoveryRuntime(): GatewayRecoveryRuntime | undefined {
  return activeRuntime?.runtime;
}
