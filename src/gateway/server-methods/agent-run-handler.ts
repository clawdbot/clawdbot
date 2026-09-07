import { validateAgentParams } from "../../../packages/gateway-protocol/src/index.js";
import { prepareAgentRequestPreflight } from "../agent-turn/agent-request-preflight.js";
import { createAgentTurnService } from "../agent-turn/agent-turn-service.js";
import { createAgentTurnIo } from "../agent-turn/io.js";
import { captureAgentTurnPrincipal, resolveAgentTurnRunObserver } from "../agent-turn/principal.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const agentRunHandler: GatewayRequestHandlers["agent"] = async ({
  params,
  respond,
  context,
  client,
  isWebchatConnect,
  sessionMutationCommitGuard,
}) => {
  sessionMutationCommitGuard?.();
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
  const onRunObserved = resolveAgentTurnRunObserver({
    principal,
    registerToolEventRecipient: context.registerToolEventRecipient,
  });
  await createAgentTurnService({ context, isWebchatConnect }).startTurn({
    assertAdmissionCurrent: sessionMutationCommitGuard,
    preflight,
    principal,
    io,
    onRunObserved,
  });
};
