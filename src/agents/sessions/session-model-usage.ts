import type { AgentCoreCompletionRuntimeDeps } from "@openclaw/agent-core";
import type { Usage } from "@openclaw/ai";
import { createSessionManagerRuntimeRegistry } from "../agent-hooks/session-manager-runtime-registry.js";

export type SessionModelUsageSink = NonNullable<
  AgentCoreCompletionRuntimeDeps["internalUsageSink"]
>;

const sinkBySessionManager = createSessionManagerRuntimeRegistry<SessionModelUsageSink>();

/** Records one auxiliary model completion at the session that owns the request. */
export function recordSessionModelUsage(
  sessionManager: unknown,
  usage: Usage,
  path?: Parameters<SessionModelUsageSink>[1],
  reason?: string,
): void {
  sinkBySessionManager.get(sessionManager)?.(usage, path, reason);
}

/** Sets the active accounting owner for auxiliary model usage. */
export function setSessionModelUsageSink(
  sessionManager: unknown,
  sink: SessionModelUsageSink | null,
): void {
  sinkBySessionManager.set(sessionManager, sink);
}
