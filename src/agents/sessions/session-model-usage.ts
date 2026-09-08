import type { Usage } from "@openclaw/ai";
import { createSessionManagerRuntimeRegistry } from "../agent-hooks/session-manager-runtime-registry.js";

export type SessionModelUsageSink = (usage: Usage) => void;

const sinkBySessionManager = createSessionManagerRuntimeRegistry<SessionModelUsageSink>();

/** Records one auxiliary model completion at the session that owns the request. */
export function recordSessionModelUsage(sessionManager: unknown, usage: Usage): void {
  sinkBySessionManager.get(sessionManager)?.(usage);
}

/** Sets the active accounting owner for auxiliary model usage. */
export function setSessionModelUsageSink(
  sessionManager: unknown,
  sink: SessionModelUsageSink | null,
): void {
  sinkBySessionManager.set(sessionManager, sink);
}
