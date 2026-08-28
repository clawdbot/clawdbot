import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { sessionDeliveryOrigin } from "../../utils/delivery-context.shared.js";
import type {
  ToolsEffectiveDependencies,
  TrustedToolsEffectiveContext,
} from "./tools-effective-types.js";
import type { RespondFn } from "./types.js";

export function resolveRequestedAgentIdOrRespondError(params: {
  rawAgentId: unknown;
  cfg: OpenClawConfig;
  respond: RespondFn;
  dependencies: ToolsEffectiveDependencies;
}) {
  const knownAgents = params.dependencies.listAgentIds(params.cfg);
  const requestedAgentId = normalizeOptionalString(params.rawAgentId) ?? "";
  if (!requestedAgentId) {
    return undefined;
  }
  if (!knownAgents.includes(requestedAgentId)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return requestedAgentId;
}

export function resolveTrustedToolsEffectiveContext(params: {
  sessionKey: string;
  requestedAgentId?: string;
  respond: RespondFn;
  dependencies: ToolsEffectiveDependencies;
}): TrustedToolsEffectiveContext | null {
  // The effective tools request is read-only but security-sensitive. Derive
  // routing/account/model context from the persisted session, not client params.
  const loaded = params.dependencies.loadGatewaySessionEntryReadOnly(
    params.sessionKey,
    params.requestedAgentId ? { agentId: params.requestedAgentId } : undefined,
  );
  if (!loaded.entry) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session key "${params.sessionKey}"`),
    );
    return null;
  }

  const canonicalKey = loaded.canonicalKey ?? params.sessionKey;
  const sessionAgentId = params.dependencies.resolveSessionAgentId({
    sessionKey: canonicalKey,
    config: loaded.cfg,
    ...(params.requestedAgentId ? { agentId: params.requestedAgentId } : {}),
  });
  if (params.requestedAgentId && params.requestedAgentId !== sessionAgentId) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `agent id "${params.requestedAgentId}" does not match session agent "${sessionAgentId}"`,
      ),
    );
    return null;
  }

  const delivery = params.dependencies.deliveryContextFromSession(loaded.entry);
  const origin = sessionDeliveryOrigin(loaded.entry);
  const resolvedModel = params.dependencies.resolveSessionModelRef(
    loaded.cfg,
    loaded.entry,
    sessionAgentId,
  );
  const workspaceDir =
    normalizeOptionalString(loaded.entry.spawnedWorkspaceDir) ??
    params.dependencies.resolveAgentWorkspaceDir(loaded.cfg, sessionAgentId);
  const runtimeConfigCacheKey = params.dependencies.resolveRuntimeConfigCacheKey(loaded.cfg);
  const pluginRegistryVersion = params.dependencies.getActivePluginRegistryVersion();
  const channelRegistryVersion = params.dependencies.getActivePluginChannelRegistryVersion();
  const nodePluginToolsVersion = params.dependencies.getConnectedNodePluginToolsVersion();
  return {
    cfg: loaded.cfg,
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    sessionId: loaded.entry.sessionId,
    workspaceDir,
    runtimeConfigCacheKey,
    pluginRegistryVersion,
    channelRegistryVersion,
    nodePluginToolsVersion,
    modelProvider: resolvedModel.provider,
    modelId: resolvedModel.model,
    messageProvider: delivery?.channel ?? origin?.provider,
    accountId: delivery?.accountId ?? origin?.accountId,
    currentChannelId: delivery?.to,
    currentThreadTs:
      delivery?.threadId != null
        ? stringifyRouteThreadId(delivery.threadId)
        : origin?.threadId != null
          ? stringifyRouteThreadId(origin.threadId)
          : undefined,
    groupId: loaded.entry.groupId,
    groupChannel: loaded.entry.groupChannel,
    groupSpace: loaded.entry.space,
    spawnedBy: normalizeOptionalString(loaded.entry.spawnedBy),
    agentHarnessId: normalizeOptionalString(loaded.entry.agentHarnessId),
    toolOverrides: loaded.entry.toolOverrides,
    replyToMode: params.dependencies.resolveReplyToMode(
      loaded.cfg,
      delivery?.channel ?? origin?.provider,
      delivery?.accountId ?? origin?.accountId,
      loaded.entry.chatType ?? origin?.chatType,
    ),
  };
}
