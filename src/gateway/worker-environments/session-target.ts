import { loadCombinedSessionStore } from "../../config/sessions/combined-store.js";
import type { SessionTranscriptWriteScope } from "../../config/sessions/session-accessor.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "../../config/sessions/session-entry-loader.js";
import { resolveSessionStoreTargetWithStore } from "../../config/sessions/session-store-target.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionIdMatchSelection } from "../../sessions/session-id-resolution.js";

export type ResolvedWorkerSessionTarget = Omit<
  SessionTranscriptWriteScope,
  "sessionId" | "sessionKey" | "storePath"
> & {
  sessionEntry: NonNullable<ReturnType<typeof resolveCanonicalSessionEntryFromStoreKeys>>;
  sessionId: string;
  sessionKey: string;
  sessionStore: Record<
    string,
    NonNullable<ReturnType<typeof resolveCanonicalSessionEntryFromStoreKeys>>
  >;
  storePath: string;
};

export function resolveWorkerSessionTarget(
  cfg: OpenClawConfig,
  sessionId: string,
): ResolvedWorkerSessionTarget | undefined {
  const { store } = loadCombinedSessionStore(cfg);
  const matches = Object.entries(store).filter(([, entry]) => entry.sessionId === sessionId);
  const selection = resolveSessionIdMatchSelection(matches, sessionId);
  if (selection.kind !== "selected") {
    return undefined;
  }
  const target = resolveSessionStoreTargetWithStore({
    cfg,
    key: selection.sessionKey,
    clone: false,
  });
  const entry = resolveCanonicalSessionEntryFromStoreKeys(target.store, target.storeKeys);
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
