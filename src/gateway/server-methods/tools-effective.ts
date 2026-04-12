import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateToolsEffectiveParams,
} from "../protocol/index.js";
import {
  deliveryContextFromSession,
  listAgentIds,
  loadConfig,
  loadSessionEntry,
  resolveEffectiveToolInventory,
  resolveReplyToMode,
  resolveSessionAgentId,
  resolveSessionModelRef,
} from "./tools-effective.runtime.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

function resolveRequestedAgentIdOrRespondError(params: {
  rawAgentId: unknown;
  cfg: OpenClawConfig;
  respond: RespondFn;
}) {
  const knownAgents = listAgentIds(params.cfg);
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

function resolveTrustedToolsEffectiveContext(params: {
  sessionKey: string;
  requestedAgentId?: string;
  senderIsOwner: boolean;
  respond: RespondFn;
}) {
  const loaded = loadSessionEntry(params.sessionKey);
  if (!loaded.entry) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session key "${params.sessionKey}"`),
    );
    return null;
  }

  const sessionAgentId = resolveSessionAgentId({
    sessionKey: loaded.canonicalKey ?? params.sessionKey,
    config: loaded.cfg,
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

  const delivery = deliveryContextFromSession(loaded.entry);
  const resolvedModel = resolveSessionModelRef(loaded.cfg, loaded.entry, sessionAgentId);
  return {
    cfg: loaded.cfg,
    agentId: sessionAgentId,
    senderIsOwner: params.senderIsOwner,
    modelProvider: resolvedModel.provider,
    modelId: resolvedModel.model,
    messageProvider:
      delivery?.channel ??
      loaded.entry.lastChannel ??
      loaded.entry.channel ??
      loaded.entry.origin?.provider,
    accountId: delivery?.accountId ?? loaded.entry.lastAccountId ?? loaded.entry.origin?.accountId,
    currentChannelId: delivery?.to,
    currentThreadTs:
      delivery?.threadId != null
        ? String(delivery.threadId)
        : loaded.entry.lastThreadId != null
          ? String(loaded.entry.lastThreadId)
          : loaded.entry.origin?.threadId != null
            ? String(loaded.entry.origin.threadId)
            : undefined,
    groupId: loaded.entry.groupId,
    groupChannel: loaded.entry.groupChannel,
    groupSpace: loaded.entry.space,
    replyToMode: resolveReplyToMode(
      loaded.cfg,
      delivery?.channel ??
        loaded.entry.lastChannel ??
        loaded.entry.channel ??
        loaded.entry.origin?.provider,
      delivery?.accountId ?? loaded.entry.lastAccountId ?? loaded.entry.origin?.accountId,
      loaded.entry.chatType ?? loaded.entry.origin?.chatType,
    ),
  };
}

export const toolsEffectiveHandlers: GatewayRequestHandlers = {
  "tools.effective": ({ params, respond, client }) => {
    if (!validateToolsEffectiveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tools.effective params: ${formatValidationErrors(validateToolsEffectiveParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const requestedAgentId = resolveRequestedAgentIdOrRespondError({
      rawAgentId: params.agentId,
      cfg,
      respond,
    });
    if (requestedAgentId === null) {
      return;
    }
    const trustedContext = resolveTrustedToolsEffectiveContext({
      sessionKey: params.sessionKey,
      requestedAgentId,
      senderIsOwner: Array.isArray(client?.connect?.scopes)
        ? client.connect.scopes.includes(ADMIN_SCOPE)
        : false,
      respond,
    });
    if (!trustedContext) {
      return;
    }
    respond(
      true,
      resolveEffectiveToolInventory({
        cfg: trustedContext.cfg,
        agentId: trustedContext.agentId,
        sessionKey: params.sessionKey,
        messageProvider: trustedContext.messageProvider,
        modelProvider: trustedContext.modelProvider,
        modelId: trustedContext.modelId,
        senderIsOwner: trustedContext.senderIsOwner,
        currentChannelId: trustedContext.currentChannelId,
        currentThreadTs: trustedContext.currentThreadTs,
        accountId: trustedContext.accountId,
        groupId: trustedContext.groupId,
        groupChannel: trustedContext.groupChannel,
        groupSpace: trustedContext.groupSpace,
        replyToMode: trustedContext.replyToMode,
      }),
      undefined,
    );
  },
};
