import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentRuntimeSessionSpawnContext } from "../../gateway/agent-runtime-identity-token.js";

const sessionSpawnContext = new AsyncLocalStorage<AgentRuntimeSessionSpawnContext>();

/** Scope signed session-creation authority to one local Gateway tool call. */
export function runWithGatewaySessionSpawnContext<T>(
  context: AgentRuntimeSessionSpawnContext,
  run: () => Promise<T>,
): Promise<T> {
  return sessionSpawnContext.run(context, run);
}

export function getGatewaySessionSpawnContext(): AgentRuntimeSessionSpawnContext | undefined {
  return sessionSpawnContext.getStore();
}
