/**
 * Runtime dependency barrel for subagent announcement/output collection.
 *
 * Keeping these imports behind one module lets tests replace gateway/session
 * IO without changing the announce logic itself.
 */
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
export { getRuntimeConfig } from "../../../config/config.js";
export {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
} from "../../../config/sessions.js";
export { resolveContinuationRuntimeConfig } from "../../../auto-reply/continuation/config.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { normalizeDiagnosticTraceparent } from "../../../infra/diagnostic-trace-context-pure.js";
import { summarizeSpawnError } from "../../spawn-error.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { splitModelRef } from "../spawn/subagent-spawn-plan.js";
import {
  resolveGatewaySessionStoreTarget,
  upsertSessionEntryCore,
} from "../spawn/subagent-spawn.runtime.js";
export type ContinuationSpawnParams = Pick<
  SubagentRunRecord,
  | "silentAnnounce"
  | "wakeOnReturn"
  | "continuationTargetSessionKey"
  | "continuationTargetSessionKeys"
  | "continuationFanoutMode"
  | "traceparent"
> & {
  continuationDelegateFlowId?: string;
  drainsContinuationDelegateQueue?: boolean;
  continuationChainState?: {
    count: number;
    startedAt: number;
    tokens: number;
    chainId?: string;
  };
};
function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}
export function buildContinuationSessionPatch(
  params: ContinuationSpawnParams,
): Partial<SessionEntry> {
  const patch: Partial<SessionEntry> = {};
  if (params.drainsContinuationDelegateQueue) {
    patch.subagentRole = "orchestrator";
    patch.subagentControlScope = "children";
  }
  const continuationTraceparent = normalizeDiagnosticTraceparent(params.traceparent);
  if (continuationTraceparent) {
    patch.continuationTraceparent = continuationTraceparent;
  }
  const chainState = params.continuationChainState;
  if (chainState) {
    patch.continuationChainCount = normalizeNonNegativeInteger(chainState.count);
    patch.continuationChainStartedAt = normalizeNonNegativeInteger(chainState.startedAt);
    patch.continuationChainTokens = normalizeNonNegativeInteger(chainState.tokens);
    const chainId = chainState.chainId?.trim();
    if (chainId) {
      patch.continuationChainId = chainId;
    }
  }
  return patch;
}
export async function persistInitialChildRuntimeState(params: {
  cfg: Parameters<typeof resolveGatewaySessionStoreTarget>[0]["cfg"];
  childSessionKey: string;
  resolvedModel?: string;
  continuationPatch: Partial<SessionEntry>;
}): Promise<string | undefined> {
  const { provider, model } = splitModelRef(params.resolvedModel);
  const patch: Partial<SessionEntry> = {
    ...params.continuationPatch,
    ...(model ? { model } : {}),
    ...(provider ? { modelProvider: provider } : {}),
  };
  if (Object.keys(patch).length === 0) {
    return undefined;
  }
  try {
    const target = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.childSessionKey,
    });
    await upsertSessionEntryCore(
      { storePath: target.storePath, sessionKey: target.canonicalKey },
      patch,
    );
    return undefined;
  } catch (error) {
    return summarizeSpawnError(error);
  }
}

export function readSubagentSessionEntry(storePath: string, sessionKey: string) {
  return loadSessionEntry({ storePath, sessionKey });
}
export { callGateway } from "../../../gateway/call.js";
export { readSessionMessagesAsync } from "../../../gateway/session-transcript-readers.js";
export { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugins.js";
export {
  isEmbeddedAgentRunActive,
  waitForEmbeddedAgentRunEnd,
} from "../../embedded-agent-runner/runs.js";
