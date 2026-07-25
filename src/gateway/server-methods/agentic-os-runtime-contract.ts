import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { stripToolMessages } from "../../agents/tools/chat-history-text.js";
import { findTaskByRunIdForStatus } from "../../tasks/task-status-access.js";
import {
  ContractInputError,
  acquireAgenticOsAllowLease,
  historyAgenticOsSession,
  listAgenticOsAllowLeases,
  listAgenticOsSessions,
  releaseAgenticOsAllowLease,
  spawnAgenticOsSession,
  statusAgenticOsSession,
} from "../agentic-os-runtime-contract.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { waitForAgentJob } from "./agent-job.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { sessionReadHandlers } from "./sessions-read.js";
import type { GatewayRequestHandler, GatewayRequestHandlers, RespondFn } from "./types.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./types.js";

async function respondWithContract(
  params: Record<string, unknown>,
  respond: RespondFn,
  implementation: (
    params: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>,
) {
  try {
    respond(true, await implementation(params), undefined);
  } catch (error) {
    const message =
      error instanceof ContractInputError ? error.message : "Agentic OS runtime contract failure";
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
  }
}

function authenticatedPrincipalId(client: GatewayClient | null): string {
  return (
    client?.internal?.agentRuntimeIdentity?.sessionKey ??
    client?.authenticatedUserId ??
    client?.connect.device?.id ??
    client?.pairedClientId ??
    client?.connId ??
    "internal"
  );
}

function authenticatedRequesterAgentId(opts: GatewayRequestHandlerOptions): string {
  const internalAgentId = opts.client?.internal?.agentRuntimeIdentity?.agentId;
  if (internalAgentId) {
    return internalAgentId;
  }
  const getRuntimeConfig = (opts.context as Partial<GatewayRequestHandlerOptions["context"]>)
    .getRuntimeConfig;
  return getRuntimeConfig ? resolveDefaultAgentId(getRuntimeConfig()) : "main";
}

function rejectConnectedClientMissingAdmin(
  client: GatewayClient | null,
  respond: RespondFn,
): boolean {
  if (!client || client.connect.scopes?.includes(ADMIN_SCOPE)) {
    return false;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${ADMIN_SCOPE}`),
  );
  return true;
}

async function callCanonicalHandler(
  handler: GatewayRequestHandler,
  opts: GatewayRequestHandlerOptions,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const respond: RespondFn = (ok, payload, error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (ok && payload && typeof payload === "object" && !Array.isArray(payload)) {
        resolve(payload as Record<string, unknown>);
        return;
      }
      reject(new ContractInputError(error?.message ?? "canonical session read failed"));
    };
    Promise.resolve(handler({ ...opts, params, respond })).catch(reject);
  });
}

export const agenticOsRuntimeContractHandlers: GatewayRequestHandlers = {
  "subagents.allowLease.acquire": async (opts) => {
    const { params, respond } = opts;
    if (rejectConnectedClientMissingAdmin(opts.client, respond)) {
      return;
    }
    void [
      params?.client_lease_id,
      params?.idempotency_key,
      params?.run_id,
      params?.phase,
      params?.transition_id,
      params?.agent_id,
      params?.requester_agent_id,
      params?.ttl_ms,
    ];
    await respondWithContract(params, respond, (input) =>
      acquireAgenticOsAllowLease(
        input,
        authenticatedRequesterAgentId(opts),
        authenticatedPrincipalId(opts.client),
      ),
    );
  },
  "subagents.allowLease.status": async ({ params, respond, client }) => {
    void params;
    await respondWithContract(params, respond, () =>
      listAgenticOsAllowLeases(authenticatedPrincipalId(client)),
    );
  },
  "subagents.allowLease.release": async (opts) => {
    const { params, respond } = opts;
    void [
      params?.client_lease_id,
      params?.release_idempotency_key,
      params?.run_id,
      params?.phase,
      params?.transition_id,
      params?.agent_id,
      params?.requester_agent_id,
      params?.gateway_lease_id,
    ];
    await respondWithContract(params, respond, (input) =>
      releaseAgenticOsAllowLease(
        input,
        authenticatedRequesterAgentId(opts),
        authenticatedPrincipalId(opts.client),
      ),
    );
  },
  sessions_spawn: async (opts) => {
    await respondWithContract(opts.params, opts.respond, (input) =>
      spawnAgenticOsSession(
        input,
        authenticatedRequesterAgentId(opts),
        authenticatedPrincipalId(opts.client),
      ),
    );
  },
  sessions_list: async ({ params, respond, client }) => {
    await respondWithContract(params, respond, () =>
      listAgenticOsSessions(authenticatedPrincipalId(client)),
    );
  },
  sessions_status: async (opts) => {
    await respondWithContract(opts.params, opts.respond, async (input) => {
      const tracked = statusAgenticOsSession(input, authenticatedPrincipalId(opts.client));
      const sessionKey = tracked.session_key;
      let canonical: Record<string, unknown> | null = null;
      try {
        canonical = await callCanonicalHandler(sessionReadHandlers["sessions.get"]!, opts, {
          sessionKey,
          limit: 1,
        });
      } catch {
        // A child can fail before its transcript is created; lifecycle remains authoritative.
      }
      const messages = Array.isArray(canonical?.messages) ? canonical.messages : [];
      const runId = typeof tracked.runId === "string" ? tracked.runId : undefined;
      const runtimeTask = runId ? findTaskByRunIdForStatus(runId) : undefined;
      const runSnapshot = runId ? await waitForAgentJob({ runId, timeoutMs: 0 }) : null;
      const lifecycleStatus = runSnapshot
        ? runSnapshot.status === "ok"
          ? "completed"
          : "failed"
        : runtimeTask
          ? runtimeTask.status === "queued" || runtimeTask.status === "running"
            ? "running"
            : runtimeTask.status === "succeeded"
              ? "completed"
              : "failed"
          : "unknown";
      return {
        ...tracked,
        runtime_session: {
          key: sessionKey,
          observed: messages.length > 0,
          message_count: messages.length,
          transcript_available: canonical !== null,
          lifecycle_status: lifecycleStatus,
          runtime_status: runSnapshot?.status ?? runtimeTask?.status ?? "unavailable",
          terminal: runSnapshot
            ? true
            : runtimeTask
              ? runtimeTask.status !== "queued" && runtimeTask.status !== "running"
              : false,
          started_at_ms: runSnapshot?.startedAt ?? runtimeTask?.startedAt,
          ended_at_ms: runSnapshot?.endedAt ?? runtimeTask?.endedAt,
        },
      };
    });
  },
  sessions_history: async (opts) => {
    await respondWithContract(opts.params, opts.respond, async (input) => {
      const tracked = historyAgenticOsSession(input, authenticatedPrincipalId(opts.client));
      const sessionKey = tracked.session_key;
      let canonical: Record<string, unknown>;
      try {
        canonical = await callCanonicalHandler(chatHistoryHandlers["chat.history"]!, opts, {
          sessionKey,
          ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
        });
      } catch {
        throw new ContractInputError("canonical chat.history read failed");
      }
      const rawMessages = Array.isArray(canonical.messages) ? canonical.messages : [];
      const messages = input.includeTools === true ? rawMessages : stripToolMessages(rawMessages);
      return { ...tracked, messages };
    });
  },
};
