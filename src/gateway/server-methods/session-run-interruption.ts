import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunActive,
  waitForEmbeddedAgentRunEnd,
} from "../../agents/embedded-agent-runner/runs.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { asWorkerInferenceControl } from "../worker-environments/inference-control.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import { hasTrackedActiveSessionRun } from "./session-active-runs.js";
import { resolveAbortSessionKey } from "./sessions-abort.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

/** Hard-stop session work for lifecycle mutation callers that have already fenced admission. */
export async function interruptSessionRunIfActive(params: {
  req: GatewayRequestHandlerOptions["req"];
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
  requestedKey: string;
  canonicalKey: string;
  agentId?: string;
  sessionId?: string;
  excludeRunIds?: ReadonlySet<string>;
}): Promise<{ interrupted: boolean; error?: ReturnType<typeof errorShape> }> {
  const cfg = params.context.getRuntimeConfig();
  const hasTrackedRun = hasTrackedActiveSessionRun({
    context: params.context,
    requestedKey: params.requestedKey,
    canonicalKey: params.canonicalKey,
    agentId: params.agentId,
    defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(cfg, params.canonicalKey),
    excludeRunIds: params.excludeRunIds,
  });
  const hasEmbeddedRun =
    typeof params.sessionId === "string" && params.sessionId
      ? isEmbeddedAgentRunActive(params.sessionId)
      : false;
  const hasWorkerRun =
    typeof params.sessionId === "string" && params.sessionId
      ? (asWorkerInferenceControl(params.context.workerEnvironmentService)?.hasInferenceForSession(
          params.sessionId,
        ) ?? false)
      : false;

  if (!hasTrackedRun && !hasEmbeddedRun && !hasWorkerRun) {
    return { interrupted: false };
  }

  if (hasTrackedRun || hasWorkerRun) {
    let abortOk = true;
    let abortError: ReturnType<typeof errorShape> | undefined;
    const abortSessionKey = resolveAbortSessionKey({
      context: params.context,
      requestedKey: params.requestedKey,
      canonicalKey: params.canonicalKey,
      agentId: params.agentId,
      defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(cfg, params.canonicalKey),
    });

    await handleChatAbortRequestWithLifecycle(
      {
        req: params.req,
        params: {
          sessionKey: abortSessionKey,
          ...(params.agentId ? { agentId: params.agentId } : {}),
        },
        respond: (ok, _payload, error) => {
          abortOk = ok;
          abortError = error;
        },
        context: params.context,
        client: params.client,
        isWebchatConnect: params.isWebchatConnect,
      },
      params.excludeRunIds ? { excludeRunIds: params.excludeRunIds } : {},
    );

    if (!abortOk) {
      return {
        interrupted: true,
        error:
          abortError ?? errorShape(ErrorCodes.UNAVAILABLE, "failed to interrupt active session"),
      };
    }
  }

  if (hasEmbeddedRun && params.sessionId) {
    abortEmbeddedAgentRun(params.sessionId);
  }

  clearSessionQueues([params.requestedKey, params.canonicalKey, params.sessionId]);

  if (hasEmbeddedRun && params.sessionId) {
    const ended = await waitForEmbeddedAgentRunEnd(params.sessionId, 15_000);
    if (!ended) {
      return {
        interrupted: true,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          `Session ${params.requestedKey} is still active; try again in a moment.`,
        ),
      };
    }
  }

  return { interrupted: true };
}
