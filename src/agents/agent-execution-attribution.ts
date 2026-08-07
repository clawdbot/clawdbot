import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  parseExecutionIdentityAdmissionToken,
  type ExecutionIdentityAdmissionToken,
} from "../audit/execution-identity-admission.js";

export type AgentExecutionIdentityAdmission = Readonly<{
  token: ExecutionIdentityAdmissionToken;
  retryOnly: boolean;
}>;

/** Host-owned correlation captured once for an admitted agent execution. */
export type AgentExecutionAttribution = Readonly<{
  runId: string;
  contextId: string;
  executionId: string;
  createdAt: number;
  lifecycleGeneration: string;
  executionIdentityAdmission?: AgentExecutionIdentityAdmission;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}>;

function requireAttributionField(value: string, field: "runId" | "lifecycleGeneration"): string {
  if (!value.trim()) {
    throw new TypeError(`Agent execution attribution requires ${field}`);
  }
  return value;
}

export function createAgentExecutionAttribution(params: {
  runId: string;
  lifecycleGeneration: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  executionIdentityAdmission?: AgentExecutionIdentityAdmission;
}): AgentExecutionAttribution {
  const runId = requireAttributionField(params.runId, "runId");
  const token = params.executionIdentityAdmission
    ? parseExecutionIdentityAdmissionToken(params.executionIdentityAdmission.token)
    : undefined;
  if (token && token.runId !== runId) {
    throw new TypeError("Agent execution attribution token disagrees with runId");
  }
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const sessionId = normalizeOptionalString(params.sessionId);
  const agentId = normalizeOptionalString(params.agentId);
  return Object.freeze({
    runId,
    contextId: token?.contextId ?? randomUUID(),
    executionId: token?.executionId ?? randomUUID(),
    createdAt: token?.createdAt ?? Date.now(),
    lifecycleGeneration: requireAttributionField(params.lifecycleGeneration, "lifecycleGeneration"),
    ...(token
      ? {
          executionIdentityAdmission: Object.freeze({
            token,
            retryOnly: params.executionIdentityAdmission?.retryOnly === true,
          }),
        }
      : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(agentId ? { agentId } : {}),
  });
}

export function rebindAgentExecutionAttribution(
  attribution: AgentExecutionAttribution,
  lifecycleGeneration: string,
): AgentExecutionAttribution {
  return Object.freeze({
    ...attribution,
    lifecycleGeneration: requireAttributionField(lifecycleGeneration, "lifecycleGeneration"),
  });
}
