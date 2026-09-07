import { routeIdFromPath } from "../app-routes.ts";
import { sessionRefFromPath } from "../app-session-route-paths.ts";
import { normalizeAgentId, parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import { sessionKeyUuid } from "../pages/chat/route-loader-short-cache.ts";
import { resolveChatSnapshotKey } from "../pages/chat/session-snapshot-invalidation.ts";
import { readStoredChatSnapshot } from "../pages/chat/session-snapshot-store.ts";
import { isDefaultChatLanding } from "../pages/model-setup/first-run.ts";

type SavedTranscriptProbe = {
  basePath: string;
  pathname: string;
  persistedSessionKey: string;
};

function localSessionKey(probe: SavedTranscriptProbe): string | null {
  const target = sessionRefFromPath(probe.pathname, probe.basePath);
  const persisted = probe.persistedSessionKey.trim();
  if (!target) {
    const location = { pathname: probe.pathname, search: "", hash: "" };
    return isDefaultChatLanding(location, probe.basePath, routeIdFromPath) &&
      parseAgentSessionKey(persisted)
      ? persisted
      : null;
  }
  if (target.kind === "literal") {
    return target.slugCandidate ? null : target.sessionKey;
  }
  const parsed = parseAgentSessionKey(persisted);
  if (
    !persisted ||
    (parsed && normalizeAgentId(parsed.agentId) !== normalizeAgentId(target.agentId))
  ) {
    return null;
  }
  if (target.kind === "main") {
    if (parsed?.rest === "main") {
      return persisted;
    }
    return !parsed && persisted.toLowerCase() === "main" ? persisted : null;
  }
  const uuid = sessionKeyUuid(persisted);
  return uuid?.startsWith(target.shortId.toLowerCase().replaceAll("-", "")) ? persisted : null;
}

export async function hasSavedTranscript(probe: SavedTranscriptProbe): Promise<boolean> {
  const sessionKey = localSessionKey(probe);
  if (!sessionKey) {
    return false;
  }
  const snapshot = await readStoredChatSnapshot(
    resolveChatSnapshotKey(
      { assistantAgentId: null, agentsList: null, hello: null },
      { sessionKey },
    ),
  );
  return Boolean(snapshot?.messages.length);
}
