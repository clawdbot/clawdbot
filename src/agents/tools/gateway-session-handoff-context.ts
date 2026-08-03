import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentRuntimeSessionHandoffContext } from "../../gateway/agent-runtime-identity-token.js";

const sessionHandoffContext = new AsyncLocalStorage<AgentRuntimeSessionHandoffContext>();

/** Scope source-run tool authority to one derived session run. */
export function runWithGatewaySessionHandoffContext<T>(
  context: AgentRuntimeSessionHandoffContext,
  run: () => Promise<T>,
): Promise<T> {
  return sessionHandoffContext.run(context, run);
}

export function getGatewaySessionHandoffContext(): AgentRuntimeSessionHandoffContext | undefined {
  return sessionHandoffContext.getStore();
}
