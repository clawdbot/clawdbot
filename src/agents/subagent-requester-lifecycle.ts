/**
 * Resolves the requester session lifecycle revision at subagent handoff
 * admission, so settle wakes can fence stale completions after a reset.
 */
import { getRuntimeConfig } from "../config/config.js";
import { resolveAgentIdFromSessionKey } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore as resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveDefaultAgentId } from "./agent-scope-config.js";
import { resolveRequesterStoreKey } from "./subagents/announce/subagent-requester-store-key.js";

type RequesterLifecycleDeps = {
  getRuntimeConfig: typeof getRuntimeConfig;
  resolveAgentIdFromSessionKey: typeof resolveAgentIdFromSessionKey;
  resolveStorePath: typeof resolveStorePath;
  loadSessionEntry: typeof loadSessionEntry;
  resolveDefaultAgentId: typeof resolveDefaultAgentId;
  resolveRequesterStoreKey: typeof resolveRequesterStoreKey;
};

const defaultRequesterLifecycleDeps: RequesterLifecycleDeps = {
  getRuntimeConfig,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
  loadSessionEntry,
  resolveDefaultAgentId,
  resolveRequesterStoreKey,
};

let requesterLifecycleDeps: RequesterLifecycleDeps = defaultRequesterLifecycleDeps;

export const testing = {
  setDepsForTest(overrides?: Partial<RequesterLifecycleDeps>) {
    requesterLifecycleDeps = overrides
      ? { ...defaultRequesterLifecycleDeps, ...overrides }
      : defaultRequesterLifecycleDeps;
  },
};

/** Current lifecycle revision of the requester session, when one is persisted. */
export function loadRequesterLifecycleRevision(
  requesterSessionKey: string,
  explicitAgentId?: string,
): string | undefined {
  const rawKey = (requesterSessionKey ?? "").trim();
  if (!rawKey) {
    return undefined;
  }
  const cfg = requesterLifecycleDeps.getRuntimeConfig();
  const canonicalKey = requesterLifecycleDeps.resolveRequesterStoreKey(
    cfg,
    rawKey,
    explicitAgentId,
  );
  const agentId = requesterLifecycleDeps.resolveAgentIdFromSessionKey(
    canonicalKey,
    explicitAgentId ?? requesterLifecycleDeps.resolveDefaultAgentId(cfg),
  );
  const storePath = requesterLifecycleDeps.resolveStorePath(cfg.session?.store, { agentId });
  return requesterLifecycleDeps.loadSessionEntry({
    storePath,
    sessionKey: canonicalKey,
    clone: false,
  })?.lifecycleRevision;
}
