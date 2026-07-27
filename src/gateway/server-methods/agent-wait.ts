import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentWaitParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { waitForAgentJob } from "./agent-job.js";
import type { GatewayRequestHandlers } from "./types.js";

export const agentWaitHandler: GatewayRequestHandlers["agent.wait"] = async ({
  params,
  respond,
  context,
}) => {
  if (!validateAgentWaitParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid agent.wait params: ${formatValidationErrors(validateAgentWaitParams.errors)}`,
      ),
    );
    return;
  }
  const runId = (params.runId ?? "").trim();
  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(0, Math.floor(params.timeoutMs))
      : 30_000;
  // `hasActiveChatRun` must exclude agent-kind abort entries so wait snapshot
  // preference continues to distinguish chat.send from agent RPC runs.
  const activeChatEntry = context.chatAbortControllers.get(runId);
  const hasActiveChatRun = activeChatEntry !== undefined && activeChatEntry.kind !== "agent";
  const snapshot = await waitForAgentJob({
    runId,
    timeoutMs,
    ...(hasActiveChatRun ? { source: "chat" } : {}),
  });
  if (!snapshot) {
    const activeRunRegistered = activeChatEntry !== undefined;
    respond(true, {
      runId,
      status: "timeout",
      timeoutPhase: activeRunRegistered ? "gateway_draining" : "queue",
      ...(activeRunRegistered ? {} : { providerStarted: false }),
    });
    return;
  }
  respond(true, {
    runId,
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
    error: snapshot.error,
    stopReason: snapshot.stopReason,
    livenessState: snapshot.livenessState,
    yielded: snapshot.yielded,
    pendingError: snapshot.pendingError,
    timeoutPhase: snapshot.timeoutPhase,
    providerStarted: snapshot.providerStarted,
  });
};
