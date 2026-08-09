import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { validateAgentParams } from "../../../packages/gateway-protocol/src/index.js";
import { createAgentTurnService } from "../agent-turn/agent-turn-service.js";
import { createAgentTurnIo } from "../agent-turn/io.js";
import type { AgentTurnPrincipal } from "../agent-turn/types.js";
import { prepareAgentRequestPreflight } from "./agent-request-preflight.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import type { GatewayClient, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function captureAgentTurnPrincipal(client: GatewayClient | null): AgentTurnPrincipal | null {
  if (!client) {
    return null;
  }
  return {
    authenticatedUserId: client.authenticatedUserId,
    authenticatedUserProfile: client.authenticatedUserProfile,
    connId: client.connId,
    connect: client.connect,
    internal: client.internal,
    isDeviceTokenAuth: client.isDeviceTokenAuth,
  };
}

export const agentRunHandler: GatewayRequestHandlers["agent"] = async ({
  params,
  respond,
  context,
  client,
  isWebchatConnect,
}) => {
  const io = createAgentTurnIo(respond);
  if (
    !assertValidParams(params, validateAgentParams, "agent", (ok, payload, error, meta) =>
      io.emitAcceptance([ok, payload, error], meta),
    )
  ) {
    return;
  }
  const request = params as AgentRunRequest;
  const principal = captureAgentTurnPrincipal(client);
  const preflight = prepareAgentRequestPreflight({ request, context, client: principal, io });
  if (!preflight) {
    return;
  }
  const connId = principal?.connId;
  const onRunObserved =
    connId && hasGatewayClientCap(principal?.connect?.caps, GATEWAY_CLIENT_CAPS.TOOL_EVENTS)
      ? (runId: string) => context.registerToolEventRecipient(runId, connId)
      : undefined;
  await createAgentTurnService({ context, isWebchatConnect }).startTurn({
    preflight,
    principal,
    io,
    onRunObserved,
  });
};
