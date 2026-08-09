import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readAgentRunIndexVersion } from "../../infra/agent-run-registry.js";
import { readSessionIdentityMutationVersion } from "../../sessions/session-lifecycle-events.js";
import { isGatewayAdmin } from "../session-sharing.js";
import { readSessionTitleProjectionUnavailableVersion } from "../session-transcript-title-reader.js";
import type { SessionsListResult } from "../session-utils.types.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { readSessionsMutationVersion } from "./session-change-event.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

type SessionListFence = {
  agentRunIndexVersion: number;
  sessionIdentityMutationVersion: number;
  sessionsMutationVersion: number;
  titleProjectionUnavailableVersion: number;
};
type SessionListOperation = SessionListFence & { promise: Promise<SessionsListResult> };
type SessionListCompleted = SessionListFence & { expiresAt?: number; result: SessionsListResult };
type SessionListState = {
  completed: Map<string, SessionListCompleted>;
  config: OpenClawConfig;
  inFlight: Map<string, SessionListOperation>;
};

const SESSIONS_LIST_COMPLETED_CACHE_LIMIT = 64;
const sessionListsByContext = new WeakMap<GatewayRequestContext, SessionListState>();

function readSessionListFence(context: GatewayRequestContext): SessionListFence {
  return {
    agentRunIndexVersion: readAgentRunIndexVersion(),
    sessionIdentityMutationVersion: readSessionIdentityMutationVersion(),
    sessionsMutationVersion: readSessionsMutationVersion(context),
    titleProjectionUnavailableVersion: readSessionTitleProjectionUnavailableVersion(),
  };
}

function matchesSessionListFence(value: SessionListFence, fence: SessionListFence): boolean {
  return (
    value.agentRunIndexVersion === fence.agentRunIndexVersion &&
    value.sessionIdentityMutationVersion === fence.sessionIdentityMutationVersion &&
    value.sessionsMutationVersion === fence.sessionsMutationVersion &&
    value.titleProjectionUnavailableVersion === fence.titleProjectionUnavailableVersion
  );
}

function sessionListVisibilityIdentity(client: GatewayClient | null): string {
  if (isGatewayAdmin(client)) {
    return "admin";
  }
  const profileId = gatewayClientSessionCreator(client)?.id;
  return profileId ? `profile:${profileId}` : "anonymous";
}

function sessionListWorkKey(params: SessionsListParams, client: GatewayClient | null): string {
  return JSON.stringify([
    sessionListVisibilityIdentity(client),
    Object.entries(params).toSorted(([left], [right]) => left.localeCompare(right)),
  ]);
}

function sessionListState(
  context: GatewayRequestContext,
  config: OpenClawConfig,
): SessionListState {
  let state = sessionListsByContext.get(context);
  if (!state || state.config !== config) {
    state = { completed: new Map(), config, inFlight: new Map() };
    sessionListsByContext.set(context, state);
  }
  return state;
}

function rememberCompletedSessionList(
  state: SessionListState,
  workKey: string,
  completed: SessionListCompleted,
): void {
  state.completed.delete(workKey);
  state.completed.set(workKey, completed);
  while (state.completed.size > SESSIONS_LIST_COMPLETED_CACHE_LIMIT) {
    const oldest = state.completed.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    state.completed.delete(oldest);
  }
}

function resolveSessionListExpiration(result: SessionsListResult): number | null | undefined {
  let expiresAt: number | undefined;
  for (const session of result.sessions) {
    // Live work can settle without a session/index mutation, running durations tick,
    // and a retained child can sit outside this page. None has a safe cache deadline.
    if (session.hasActiveRun || session.hasActiveSubagentRun || session.childSessions?.length) {
      return null;
    }
    const statusExpiration = session.agentStatus?.expiresAt;
    if (
      statusExpiration !== undefined &&
      (expiresAt === undefined || statusExpiration < expiresAt)
    ) {
      expiresAt = statusExpiration;
    }
  }
  return expiresAt;
}

export async function respondWithCachedSessionList(params: {
  client: GatewayClient | null;
  config: OpenClawConfig;
  context: GatewayRequestContext;
  request: SessionsListParams;
  respond: RespondFn;
  run: () => Promise<SessionsListResult>;
}): Promise<void> {
  const workKey = sessionListWorkKey(params.request, params.client);
  const state = sessionListState(params.context, params.config);
  // Every input that can change a projected row must fence reuse. Session identity,
  // Gateway projection, and live-run mutations have separate monotonic owners.
  const fence = readSessionListFence(params.context);
  // Activity windows and child retention expire without mutations; hidden paginated rows
  // prevent deriving a safe deadline, so only concurrent temporal requests share work.
  const cacheCompleted = params.request.activeMinutes === undefined && !params.request.spawnedBy;
  const completed = cacheCompleted ? state.completed.get(workKey) : undefined;
  if (
    completed &&
    matchesSessionListFence(completed, fence) &&
    (completed.expiresAt === undefined || completed.expiresAt > Date.now())
  ) {
    params.respond(true, completed.result, undefined);
    return;
  }
  const pending = state.inFlight.get(workKey);
  if (pending && matchesSessionListFence(pending, fence)) {
    params.respond(true, await pending.promise, undefined);
    return;
  }

  // A request may share only work begun at the same fence. A transition during projection
  // leaves current callers intact but fences every later caller and cache write.
  const promise = Promise.resolve()
    .then(params.run)
    .then((result) => {
      if (cacheCompleted && matchesSessionListFence(readSessionListFence(params.context), fence)) {
        const expiresAt = resolveSessionListExpiration(result);
        if (expiresAt !== null && (expiresAt === undefined || expiresAt > Date.now())) {
          rememberCompletedSessionList(state, workKey, { ...fence, result, expiresAt });
        }
      }
      return result;
    });
  const operation = { ...fence, promise };
  state.inFlight.set(workKey, operation);
  try {
    params.respond(true, await promise, undefined);
  } finally {
    if (state.inFlight.get(workKey) === operation) {
      state.inFlight.delete(workKey);
    }
  }
}
