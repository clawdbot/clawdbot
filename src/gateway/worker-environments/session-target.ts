import { expectDefined } from "@openclaw/normalization-core";
import type { SessionTranscriptWriteScope } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionIdMatchSelection } from "../../sessions/session-id-resolution.js";
import {
  loadCombinedSessionStoreForGatewayCore,
  resolveCanonicalSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTargetWithStore,
} from "../session-utils.js";

export type ResolvedWorkerSessionTarget = Omit<
  SessionTranscriptWriteScope,
  "sessionId" | "sessionKey" | "storePath"
> & {
  agentId: string;
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
  const { store, targetsBySessionKey } = loadCombinedSessionStoreForGatewayCore(cfg);
  const matches = Object.entries(store).filter(([, entry]) => entry.sessionId === sessionId);
  const selection = resolveSessionIdMatchSelection(matches, sessionId);
  if (selection.kind !== "selected") {
    return undefined;
  }
  // Combined-store projection records the logical owner alongside each row.
  // Reserved global keys cannot recover that owner from the key itself.
  const agentId = expectDefined(
    targetsBySessionKey.get(selection.sessionKey),
    "worker session owner",
  ).agentId;
  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg,
    key: selection.sessionKey,
    agentId,
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
