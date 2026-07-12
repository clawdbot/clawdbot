import type { SessionTranscriptWriteScope } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionIdMatchSelection } from "../../sessions/session-id-resolution.js";
import {
  loadCombinedSessionStoreForGateway,
  resolveFreshestSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTargetWithStore,
} from "../session-utils.js";

export type ResolvedWorkerSessionTarget = Omit<
  SessionTranscriptWriteScope,
  "sessionId" | "sessionKey"
> & {
  sessionEntry: NonNullable<ReturnType<typeof resolveFreshestSessionEntryFromStoreKeys>>;
  sessionId: string;
  sessionKey: string;
  sessionStore: Record<
    string,
    NonNullable<ReturnType<typeof resolveFreshestSessionEntryFromStoreKeys>>
  >;
};

export function resolveWorkerSessionTarget(
  cfg: OpenClawConfig,
  sessionId: string,
): ResolvedWorkerSessionTarget | undefined {
  const { store } = loadCombinedSessionStoreForGateway(cfg);
  const matches = Object.entries(store).filter(([, entry]) => entry.sessionId === sessionId);
  const selection = resolveSessionIdMatchSelection(matches, sessionId);
  if (selection.kind !== "selected") {
    return undefined;
  }
  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg,
    key: selection.sessionKey,
    clone: false,
  });
  const entry = resolveFreshestSessionEntryFromStoreKeys(target.store, target.storeKeys);
  if (!entry || entry.sessionId !== sessionId) {
    return undefined;
  }
  return {
    agentId: target.agentId,
    sessionEntry: entry,
    sessionId,
    sessionKey: target.canonicalKey,
    sessionStore: target.store,
    storePath: target.storePath,
  };
}
