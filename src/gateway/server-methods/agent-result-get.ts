import {
  ErrorCodes,
  errorShape,
  validateAgentResultGetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentResultGet } from "../../agents/agent-result-get.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { isLoopbackAddress } from "../net.js";
import { isAuthorizedFactoryControllerPrincipal } from "./factory-controller-principal.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const agentResultGetHandler: GatewayRequestHandlers["agent.result.get"] = async ({
  params,
  client,
  respond,
}) => {
  if (!assertValidParams(params, validateAgentResultGetParams, "agent.result.get", respond)) {
    return;
  }
  if (!client?.transportRemoteIp || !isLoopbackAddress(client.transportRemoteIp)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.FORBIDDEN, "agent.result.get is restricted to loopback clients"),
    );
    return;
  }
  if (
    !isAuthorizedFactoryControllerPrincipal({
      client,
      credential: params.factoryCredential,
    })
  ) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.FORBIDDEN,
        "agent.result.get requires the dedicated factory controller principal",
      ),
    );
    return;
  }

  const requesterSessionKey = params.requesterSessionKey.trim();
  if (!parseAgentSessionKey(requesterSessionKey)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "requesterSessionKey must be canonical"),
    );
    return;
  }

  // The exact requester lifecycle is part of the launch receipt. Deliberately
  // do not consult mutable session state here: deleting or resetting the
  // requester must not make already-frozen terminal evidence unrecoverable.
  const result = await resolveAgentResultGet({
    runId: params.runId.trim(),
    sessionKey: params.sessionKey.trim(),
    agentId: params.agentId.trim(),
    requesterSessionKey,
    requesterSessionId: params.requesterSessionId.trim(),
    ...(params.requesterLifecycleRevision?.trim()
      ? { requesterLifecycleRevision: params.requesterLifecycleRevision.trim() }
      : {}),
    replayKey: params.replayKey.trim(),
    requestFingerprint: params.requestFingerprint as `sha256:${string}`,
    launchIdentityDigest: params.launchIdentityDigest as `sha256:${string}`,
    authorityProfileId: params.authorityProfileId.trim(),
    worktreeFenceToken: params.worktreeFenceToken.trim(),
    worktreeOwnershipGeneration: params.worktreeOwnershipGeneration,
    ...(params.taskId?.trim() ? { taskId: params.taskId.trim() } : {}),
  });
  respond(true, result);
};
