import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import {
  type WorkerSessionsSendParams,
  WorkerSessionsSendParamsSchema,
  type WorkerSessionsSpawnParams,
  WorkerSessionsSpawnParamsSchema,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  buildBlockedToolResult,
  runBeforeToolCallHook,
} from "../../agents/agent-tools.before-tool-call.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerSessionToolSource } from "./worker-session-tool-topology.js";

export type WorkerSessionOperationRequest = {
  identity: WorkerConnectionIdentity;
  signal?: AbortSignal;
} & (
  | { toolName: "sessions_spawn"; request: WorkerSessionsSpawnParams }
  | { toolName: "sessions_send"; request: WorkerSessionsSendParams }
);

export async function applyWorkerSessionToolPolicy(params: {
  request: WorkerSessionOperationRequest;
  source: Pick<WorkerSessionToolSource, "agentId" | "sessionId" | "sessionKey">;
}): Promise<
  { request: WorkerSessionOperationRequest } | { result: ReturnType<typeof buildBlockedToolResult> }
> {
  const { toolCallId, ...toolParams } = params.request.request;
  const runId = params.request.identity.runId ?? undefined;
  const outcome = await runBeforeToolCallHook({
    toolName: params.request.toolName,
    params: toolParams,
    toolCallId,
    ctx: {
      agentId: params.source.agentId,
      config: getRuntimeConfig(),
      sessionKey: params.source.sessionKey,
      sessionId: params.source.sessionId,
      runId,
    },
    ...(params.request.signal ? { signal: params.request.signal } : {}),
    approvalMode: "deny",
  });
  if (outcome.blocked) {
    return {
      result: buildBlockedToolResult({
        reason: outcome.reason,
        deniedReason: outcome.deniedReason,
        toolCallId,
        runId,
      }),
    };
  }
  const adjustedRequest = { ...asNonArrayRecord(outcome.params), toolCallId };
  const schema =
    params.request.toolName === "sessions_spawn"
      ? WorkerSessionsSpawnParamsSchema
      : WorkerSessionsSendParamsSchema;
  if (!Value.Check(schema, adjustedRequest)) {
    return {
      result: buildBlockedToolResult({
        reason: `Tool call blocked because before_tool_call returned invalid ${params.request.toolName} input.`,
        toolCallId,
        runId,
      }),
    };
  }
  return {
    // SAFETY: Value.Check used the schema selected by this unchanged toolName discriminant.
    request: { ...params.request, request: adjustedRequest } as WorkerSessionOperationRequest,
  };
}
