import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isGatewayAdmin } from "../session-sharing.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { readSessionsMutationVersion } from "./session-change-event.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

type SessionListOperation = { mutationVersion: number; promise: Promise<unknown> };
type SessionListCompleted = { mutationVersion: number; result: unknown };
type SessionListState = {
  completed: Map<string, SessionListCompleted>;
  config: OpenClawConfig;
  inFlight: Map<string, SessionListOperation>;
};

const SESSIONS_LIST_COMPLETED_CACHE_LIMIT = 64;
const sessionListsByContext = new WeakMap<GatewayRequestContext, SessionListState>();

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

export async function respondWithCachedSessionList(params: {
  client: GatewayClient | null;
  config: OpenClawConfig;
  context: GatewayRequestContext;
  request: SessionsListParams;
  respond: RespondFn;
  run: () => Promise<unknown>;
}): Promise<void> {
  const workKey = sessionListWorkKey(params.request, params.client);
  const state = sessionListState(params.context, params.config);
  const mutationVersion = readSessionsMutationVersion(params.context);
  const completed = state.completed.get(workKey);
  if (completed?.mutationVersion === mutationVersion) {
    params.respond(true, completed.result, undefined);
    return;
  }
  const pending = state.inFlight.get(workKey);
  if (pending?.mutationVersion === mutationVersion) {
    params.respond(true, await pending.promise, undefined);
    return;
  }

  // A request may share only work begun at the same mutation version. A mutation during
  // projection leaves current callers intact but fences every later caller and cache write.
  const promise = Promise.resolve()
    .then(params.run)
    .then((result) => {
      if (readSessionsMutationVersion(params.context) === mutationVersion) {
        rememberCompletedSessionList(state, workKey, { mutationVersion, result });
      }
      return result;
    });
  const operation = { mutationVersion, promise };
  state.inFlight.set(workKey, operation);
  try {
    params.respond(true, await promise, undefined);
  } finally {
    if (state.inFlight.get(workKey) === operation) {
      state.inFlight.delete(workKey);
    }
  }
}
