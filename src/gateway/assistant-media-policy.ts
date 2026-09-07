import { isCloudWorkerPlacementState } from "../../packages/gateway-protocol/src/schema/session-placement-state.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { resolveSessionPermissionCoreToolPolicy } from "../agents/session-permission-exec-mode.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../agents/tool-fs-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentScopedMediaLocalRoots, getDefaultMediaLocalRoots } from "../media/local-roots.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { getUserProfileListItem } from "../state/user-profiles.js";
import { resolveHttpProfile } from "./http-auth-user-profile.js";
import {
  applyHttpOperatorRoleScopeCeiling,
  type AuthorizedControlUiReadRequest,
} from "./http-auth-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { createProfileSessionEntryFilter } from "./session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import { resolveSessionWorkerPlacementContext } from "./session-worker-placement-context.js";
import { resolveSessionWorkspaceRoots } from "./session-workspace-roots.js";

export type AssistantMediaSession = {
  sessionKey: string;
  agentId: string;
  sessionId: string;
};

export type AssistantMediaReader = Pick<
  AuthorizedControlUiReadRequest,
  "authMethod" | "operatorScopes"
> & {
  profileId?: string;
};

function resolveAssistantMediaReaderAuth(
  reader: AssistantMediaReader,
  config: OpenClawConfig,
): AuthorizedControlUiReadRequest | undefined {
  try {
    const profile = reader.profileId ? getUserProfileListItem(reader.profileId) : undefined;
    const currentProfile = profile
      ? resolveHttpProfile(profile.id, profile.updatedAt, config)
      : undefined;
    const operatorScopes = applyHttpOperatorRoleScopeCeiling(reader.operatorScopes, currentProfile);
    if (!authorizeOperatorScopesForMethod("assistant.media.get", operatorScopes).allowed) {
      return undefined;
    }
    return { authMethod: reader.authMethod, operatorScopes, ...currentProfile };
  } catch {
    return undefined;
  }
}

export function resolveAssistantMediaPolicy(params: {
  config: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  requestAuth?: AuthorizedControlUiReadRequest;
  reader?: AssistantMediaReader;
}) {
  let loaded: ReturnType<typeof loadGatewaySessionEntryReadOnly> | undefined;
  if (params.sessionKey) {
    const owner = resolveRequestedSessionAgentId(params.config, params.sessionKey, params.agentId);
    if (!owner.ok) {
      return undefined;
    }
    loaded = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: owner.agentId });
    if (!loaded.entry?.sessionId) {
      return undefined;
    }
  }
  // Session storage reads the committed runtime config, including a reload during file preparation.
  const config = loaded?.cfg ?? params.config;
  const reader =
    params.reader ??
    (params.requestAuth
      ? {
          authMethod: params.requestAuth.authMethod,
          operatorScopes: params.requestAuth.operatorScopes,
          ...(params.requestAuth.authenticatedUserProfile
            ? { profileId: params.requestAuth.authenticatedUserProfile.profileId }
            : {}),
        }
      : undefined);
  const auth =
    params.requestAuth ?? (reader ? resolveAssistantMediaReaderAuth(reader, config) : undefined);
  if (!auth || !reader) {
    return undefined;
  }
  const agentId = loaded?.agentId ?? params.agentId;
  const entry = loaded?.entry;
  const remote = Boolean(entry?.execNode || entry?.repositoryWorkspaceId);
  let session: AssistantMediaSession | undefined;
  let sessionRoot: string | undefined;
  if (loaded && entry && agentId) {
    if (!auth.operatorScopes.includes("operator.admin")) {
      const profileId = auth.authenticatedUserProfile?.profileId;
      if (profileId && profileId !== GATEWAY_OWNER_PROFILE_ID) {
        // Match artifact reads: named people cannot read incognito; named roles
        // additionally apply the session catalog's creator/visibility ceiling.
        if (entry.incognito || isIncognitoSessionKey(loaded.canonicalKey)) {
          return undefined;
        }
        if (
          auth.operatorRolePolicy &&
          !createProfileSessionEntryFilter({
            profileId,
            sessionCap: auth.operatorRolePolicy.sessions.others,
          })(loaded.canonicalKey, entry)
        ) {
          return undefined;
        }
      } else if (!profileId && config.gateway?.roles) {
        return undefined;
      }
    }
    session = { sessionKey: loaded.canonicalKey, agentId, sessionId: entry.sessionId };
    if (!remote) {
      sessionRoot = entry.sessionRoot ?? resolveSessionWorkspaceRoots(config, agentId, entry).root;
    }
  }
  const workspaceOnly =
    !session ||
    (entry?.permissionMode
      ? resolveSessionPermissionCoreToolPolicy({ mode: entry.permissionMode }).workspaceOnly
      : resolveEffectiveToolFsWorkspaceOnly({ cfg: config, agentId }));
  const localRoots = [
    ...(remote
      ? getDefaultMediaLocalRoots()
      : getAgentScopedMediaLocalRoots(config, agentId, workspaceOnly ? sessionRoot : undefined)),
  ];
  // Full Access retains established agent-workspace downloads alongside the selected project.
  if (sessionRoot && !localRoots.includes(sessionRoot)) {
    localRoots.push(sessionRoot);
  }
  // Cloud placement owns its filesystem independently of the session exec-node setting.
  const placement = session
    ? resolveSessionWorkerPlacementContext()
        .workerSessionPlacementService?.getMany([session.sessionId])
        .get(session.sessionId)
    : undefined;
  return {
    session,
    remote: remote || isCloudWorkerPlacementState(placement?.state),
    localRoots,
    workspaceOnly,
    reader,
    canAllow: auth.operatorScopes.includes("operator.admin"),
  };
}
