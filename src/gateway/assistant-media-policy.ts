import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { resolveSessionPermissionCoreToolPolicy } from "../agents/session-permission-exec-mode.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../agents/tool-fs-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { AuthorizedControlUiReadRequest } from "./http-auth-utils.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { createProfileSessionEntryFilter } from "./session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import { resolveSessionWorkspaceRoots } from "./session-workspace-roots.js";

export type AssistantMediaSession = {
  sessionKey: string;
  agentId: string;
  sessionId: string;
};

export function resolveAssistantMediaPolicy(params: {
  config: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  requestAuth?: AuthorizedControlUiReadRequest;
}) {
  let config = params.config;
  let agentId = params.agentId;
  let session: AssistantMediaSession | undefined;
  let sessionRoot: string | undefined;
  let permissionMode;
  let remote = false;
  if (params.sessionKey) {
    const owner = resolveRequestedSessionAgentId(config, params.sessionKey, agentId);
    if (!owner.ok) return undefined;
    const loaded = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: owner.agentId });
    const entry = loaded.entry;
    if (!entry?.sessionId) return undefined;
    remote = Boolean(entry.execNode);
    const auth = params.requestAuth;
    if (auth && !auth.operatorScopes.includes("operator.admin")) {
      const profileId = auth.authenticatedUserProfile?.profileId;
      if (profileId && profileId !== GATEWAY_OWNER_PROFILE_ID) {
        // Match artifact reads: named people cannot read incognito; named roles
        // additionally apply the session catalog's creator/visibility ceiling.
        if (entry.incognito || isIncognitoSessionKey(loaded.canonicalKey)) return undefined;
        if (
          auth.operatorRolePolicy &&
          !createProfileSessionEntryFilter({
            profileId,
            sessionCap: auth.operatorRolePolicy.sessions.others,
          })(loaded.canonicalKey, entry)
        )
          return undefined;
      } else if (!profileId && config.gateway?.roles) {
        return undefined;
      }
    }
    config = loaded.cfg;
    agentId = loaded.agentId ?? owner.agentId;
    session = { sessionKey: loaded.canonicalKey, agentId, sessionId: entry.sessionId };
    sessionRoot =
      entry.sessionRoot ?? resolveSessionWorkspaceRoots(loaded.cfg, agentId, entry).root;
    permissionMode = entry.permissionMode;
  }
  const localRoots = getAgentScopedMediaLocalRoots(config, agentId, sessionRoot);
  return {
    session,
    remote,
    localRoots,
    workspaceOnly:
      !session ||
      (permissionMode
        ? resolveSessionPermissionCoreToolPolicy({ mode: permissionMode }).workspaceOnly
        : resolveEffectiveToolFsWorkspaceOnly({ cfg: config, agentId })),
  };
}
