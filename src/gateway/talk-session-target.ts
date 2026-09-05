import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveConfiguredAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveTalkSessionAgentId } from "../talk/agent-target.js";
import { resolveSessionStoreAgentId, resolveSessionStoreKey } from "./session-store-key.js";
import { resolveGatewaySessionStoreTargetWithStore } from "./session-utils-store-lookup.js";
import type { PreparedTalkSessionTarget } from "./talk-session-target.types.js";

export function requirePreparedTalkSessionTarget(
  target: PreparedTalkSessionTarget | undefined,
): PreparedTalkSessionTarget {
  if (!target) {
    throw new Error("Talk session target was not prepared by the Gateway");
  }
  return target;
}

/** Resolve Talk ownership before aliases collapse, then retain the exact storage target. */
export function prepareTalkSessionTarget(
  cfg: OpenClawConfig,
  requestedSessionKey?: string,
): PreparedTalkSessionTarget {
  const requestedKey = normalizeOptionalString(requestedSessionKey);
  const owner = resolveTalkSessionAgentId(cfg, requestedKey ?? "main");
  const sessionKey = requestedKey ?? resolveAgentMainSessionKey({ cfg, agentId: owner });
  const { agentId, canonicalKey, storePath } = resolveTalkSessionStorageTarget(
    cfg,
    sessionKey,
    owner,
  );
  return Object.freeze({ agentId, sessionKey, canonicalKey, storePath });
}

/** Revalidate a retained owner without consulting the current ambient Talk default. */
export function assertTalkSessionStorageTarget(
  cfg: OpenClawConfig,
  target: PreparedTalkSessionTarget,
): void {
  const current = resolveTalkSessionStorageTarget(cfg, target.canonicalKey, target.agentId);
  if (
    current.agentId !== target.agentId ||
    current.canonicalKey !== target.canonicalKey ||
    current.storePath !== target.storePath
  ) {
    throw new Error("Talk session storage target changed; retry the request");
  }
}

function resolveTalkSessionStorageTarget(cfg: OpenClawConfig, sessionKey: string, owner: string) {
  const requestedAgentId = resolveSessionStoreAgentId(
    cfg,
    sessionKey,
    resolveConfiguredAgentId(cfg, owner),
  );
  const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey, storeAgentId: requestedAgentId });
  // A scoped main alias may become global. Validate the fixed-store owner again,
  // rather than dropping the explicit owner when the canonical key loses its prefix.
  const agentId = resolveSessionStoreAgentId(cfg, canonicalKey, requestedAgentId);
  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg,
    key: canonicalKey,
    agentId,
    readOnly: true,
    exactRead: true,
  });
  return { agentId, canonicalKey, storePath: target.storePath };
}
