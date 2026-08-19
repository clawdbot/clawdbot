import { AsyncLocalStorage } from "node:async_hooks";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import type { SessionEntry } from "../config/sessions.js";
import { createAgentPatchedSessionModelFallback } from "../config/sessions/session-model-fallback.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const agentSessionModelPatch = new AsyncLocalStorage<boolean>();

export function withAgentSessionModelPatchOrigin<T>(run: () => T): T {
  return agentSessionModelPatch.run(true, run);
}

export function isAgentSessionModelPatchOrigin(): boolean {
  return agentSessionModelPatch.getStore() === true;
}

export function snapshotAgentModelFallback(
  cfg: OpenClawConfig,
  entry: SessionEntry,
  agentId: string,
  now: number,
): NonNullable<SessionEntry["modelFallback"]> {
  const prior = resolveSessionModelRef(cfg, entry, agentId);
  return createAgentPatchedSessionModelFallback({
    model: prior.model,
    provider: prior.provider,
    entry,
    ts: now,
  });
}
