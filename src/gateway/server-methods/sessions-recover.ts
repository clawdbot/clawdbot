import {
  validateSessionsRecoverParams,
  type SessionsRecoverResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { recoverGatewaySession } from "../session-recovery-service.js";
import { createAgentRuntimeAuthorityGuard } from "./agent-runtime-authority.js";
import { emitSessionArchived, emitSessionsChanged } from "./session-change-event.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import { launchSessionRecoveryContinuation } from "./session-recovery-continuation.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionRecoverHandlers: GatewayRequestHandlers = {
  "sessions.recover": async ({
    req,
    params,
    respond,
    client,
    context,
    sessionMutationAuthorization,
  }) => {
    if (!assertValidParams(params, validateSessionsRecoverParams, "sessions.recover", respond)) {
      return;
    }
    const authority = createAgentRuntimeAuthorityGuard(client, context, respond);
    const commitGuard =
      authority.commitGuard || sessionMutationAuthorization
        ? () => {
            authority.commitGuard?.();
            sessionMutationAuthorization?.assertCurrent();
          }
        : undefined;
    const creation = resolveOperatorSessionCreation(client);
    const recovered = await recoverGatewaySession({
      cfg: context.getRuntimeConfig(),
      key: params.key,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(creation.actor ? { actor: creation.actor } : {}),
      ...(client?.authenticatedUserProfile
        ? { requestingOperatorProfileId: client.authenticatedUserProfile.profileId }
        : {}),
      ...(client?.internal?.operatorRoleActor
        ? { operatorRoleActor: client.internal.operatorRoleActor }
        : {}),
      authorizedPluginId: client?.internal?.pluginRuntimeOwnerId,
      ...(commitGuard ? { commitGuard } : {}),
      launchContinuation: async (continuation) =>
        await launchSessionRecoveryContinuation({
          ...continuation,
          client,
          ...(commitGuard ? { commitGuard } : {}),
          context,
          req,
        }),
    }).catch((error: unknown) => authority.handleClosedError(error));
    if (!recovered) {
      return;
    }
    if (!recovered.ok) {
      respond(false, undefined, recovered.error);
      return;
    }

    emitSessionArchived(
      context,
      recovered.sourceKey,
      recovered.sourceKey === "global" ? recovered.agentId : undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: recovered.successorKey,
      reason: recovered.created ? "create" : "recovery",
      ...(recovered.successorKey === "global" ? { agentId: recovered.agentId } : {}),
    });
    const result: SessionsRecoverResult = {
      ok: true,
      key: recovered.successorKey,
      sessionId: recovered.successorEntry.sessionId,
      continuation: recovered.continuation,
    };
    respond(true, result, undefined);
  },
};
