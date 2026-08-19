import type {
  GatewayLifecycleAgentDispatchOptions,
  GatewayRecoveryRuntime,
} from "./server-instance-runtime.types.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";

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

/** Dispatches detached Gateway lifecycle work through the active instance principal. */
export async function dispatchGatewayLifecycleMethod<T = unknown>(
  method: "agent",
  params: Record<string, unknown>,
  options: GatewayLifecycleAgentDispatchOptions = {},
): Promise<T> {
  const agentParams = params as AgentRunRequest; // SAFETY: the bound facade validates the payload.
  const runtime = getGatewayRecoveryRuntime();
  if (!runtime) {
    throw new Error(`Gateway instance lifecycle dispatch unavailable for ${method}`);
  }
  return await runtime.dispatchAgent<T>(agentParams, options.timeoutMs, options);
}
