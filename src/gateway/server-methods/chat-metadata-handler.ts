import {
  ErrorCodes,
  errorShape,
  validateChatMetadataParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { resolveRequestedChatAgentId } from "./chat-origin-routing.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { preparePersonalModelAccountSelection } from "./users-model-account-access.js";
import { resolveAuthenticatedProfileId } from "./users-profile-access.js";
import { assertValidParams } from "./validation.js";

export async function handleChatMetadataRequest({
  params,
  respond,
  context,
  client,
  signal,
}: GatewayRequestHandlerOptions): Promise<void> {
  if (!assertValidParams(params, validateChatMetadataParams, "chat.metadata", respond)) {
    return;
  }
  const metadataParams = params;
  const cfg = context.getRuntimeConfig();
  if (metadataParams.sessionKey) {
    const requested = resolveRequestedChatAgentId({
      cfg,
      requestedSessionKey: metadataParams.sessionKey,
      agentId: metadataParams.agentId,
    });
    if (!requested.ok) {
      respond(false, undefined, requested.error);
      return;
    }
    // The router authorizes the session selector; only the persisted entry supplies auth profiles.
    const session = loadGatewaySessionEntryReadOnly(metadataParams.sessionKey, {
      agentId: requested.agentId,
      projection: "list",
    });
    respond(
      true,
      await context.readChatMetadata({
        agentId: resolveSessionAgentId({
          sessionKey: metadataParams.sessionKey,
          config: session.cfg,
          agentId: requested.agentId,
        }),
        sessionKey: session.canonicalKey,
        sessionEntry: session.entry,
        requesterProfileId: resolveAuthenticatedProfileId(client),
      }),
    );
    return;
  }
  const resolvedAgent = resolveAgentIdOrRespondError({
    rawAgentId: metadataParams.agentId,
    respond,
    cfg,
    normalize: (rawAgentId) =>
      typeof rawAgentId === "string" && rawAgentId.trim()
        ? normalizeAgentId(rawAgentId)
        : undefined,
  });
  if (!resolvedAgent) {
    return;
  }
  try {
    const draftAccountSelection = metadataParams.authProfileId
      ? preparePersonalModelAccountSelection(
          { client, context, signal },
          metadataParams.authProfileId,
          "operator.read",
        )
      : undefined;
    const metadata = await context.readChatMetadata({
      agentId: resolvedAgent.agentId,
      requesterProfileId: draftAccountSelection?.owner ?? resolveAuthenticatedProfileId(client),
      ...(draftAccountSelection ? { draftAccountSelection } : {}),
    });
    draftAccountSelection?.assertCurrent();
    respond(true, metadata);
  } catch (error) {
    if (!(error instanceof ModelAccountConnectAuthorityError)) {
      throw error;
    }
    respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, error.message));
  }
}
