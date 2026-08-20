import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readAgentRunIndexVersion } from "../../infra/agent-run-registry.js";
import { readSessionIdentityMutationVersion } from "../../sessions/session-lifecycle-events.js";
import { readSessionTranscriptUpdateVersion } from "../../sessions/transcript-events.js";
import {
  readOpenClawAgentDatabaseRegistryToken,
  readOpenIncognitoAgentDatabaseGeneration,
} from "../../state/openclaw-agent-db.js";
import { readSessionAutomationVersion } from "../session-automation-index.js";
import { readSessionLifecyclePersistenceVersion } from "../session-lifecycle-state.js";
import { isGatewayAdmin } from "../session-sharing.js";
import { readSessionTitleProjectionUnavailableVersion } from "../session-transcript-title-reader.js";
import type { SessionListModelCatalog, SessionsListResult } from "../session-utils.types.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { readSessionsMutationVersion } from "./session-change-event.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

type SessionListFence = {
  agentRunIndexVersion: number;
  agentDatabaseRegistryToken: symbol;
  incognitoDatabaseGeneration: number;
  lifecyclePersistenceVersion: number;
  modelCatalogRevision: string;
  sessionAutomationVersion: number;
  sessionIdentityMutationVersion: number;
  sessionsMutationVersion: number;
  sessionTranscriptUpdateVersion: number;
  titleProjectionUnavailableVersion: number;
  workerPlacementDiskSpaceVersion: number;
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
const modelCatalogRevisions = new WeakMap<readonly ModelCatalogEntry[], number>();
let nextModelCatalogRevision = 1;

function readModelCatalogRevision(modelCatalog: readonly ModelCatalogEntry[] | undefined): number {
  if (!modelCatalog) {
    return 0;
  }
  const existing = modelCatalogRevisions.get(modelCatalog);
  if (existing !== undefined) {
    return existing;
  }
  const revision = nextModelCatalogRevision++;
  modelCatalogRevisions.set(modelCatalog, revision);
  return revision;
}

/**
 * Serializes the per-agent catalog revision set so the cache fence advances
 * when any row owner's catalog changes. The revision identity of each distinct
 * catalog array is monotonic; the string join is stable per sorted agent set.
 */
function readSessionListModelCatalogFence(
  modelCatalog: SessionListModelCatalog | undefined,
): string {
  if (!modelCatalog || modelCatalog.size === 0) {
    return "none";
  }
  return [...modelCatalog.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([agentId, entries]) => `${agentId}:${readModelCatalogRevision(entries)}`)
    .join(",");
}

function readSessionListFence(
  context: GatewayRequestContext,
  modelCatalog: SessionListModelCatalog | undefined,
): SessionListFence {
  return {
    agentRunIndexVersion: readAgentRunIndexVersion(),
    agentDatabaseRegistryToken: readOpenClawAgentDatabaseRegistryToken(),
    incognitoDatabaseGeneration: readOpenIncognitoAgentDatabaseGeneration(),
    lifecyclePersistenceVersion: readSessionLifecyclePersistenceVersion(),
    modelCatalogRevision: readSessionListModelCatalogFence(modelCatalog),
    sessionAutomationVersion: readSessionAutomationVersion(),
    sessionIdentityMutationVersion: readSessionIdentityMutationVersion(),
    sessionsMutationVersion: readSessionsMutationVersion(context),
    // Rows embed transcript-derived previews/titles; a committed transcript
    // write without a session mutation must still invalidate reuse.
    sessionTranscriptUpdateVersion: readSessionTranscriptUpdateVersion(),
    titleProjectionUnavailableVersion: readSessionTitleProjectionUnavailableVersion(),
    workerPlacementDiskSpaceVersion: context.workerPlacementDiskSpaceReader?.version() ?? 0,
  };
}

function matchesSessionListFence(value: SessionListFence, fence: SessionListFence): boolean {
  return (
    value.agentRunIndexVersion === fence.agentRunIndexVersion &&
    value.agentDatabaseRegistryToken === fence.agentDatabaseRegistryToken &&
    value.incognitoDatabaseGeneration === fence.incognitoDatabaseGeneration &&
    value.lifecyclePersistenceVersion === fence.lifecyclePersistenceVersion &&
    value.modelCatalogRevision === fence.modelCatalogRevision &&
    value.sessionAutomationVersion === fence.sessionAutomationVersion &&
    value.sessionIdentityMutationVersion === fence.sessionIdentityMutationVersion &&
    value.sessionsMutationVersion === fence.sessionsMutationVersion &&
    value.sessionTranscriptUpdateVersion === fence.sessionTranscriptUpdateVersion &&
    value.titleProjectionUnavailableVersion === fence.titleProjectionUnavailableVersion &&
    value.workerPlacementDiskSpaceVersion === fence.workerPlacementDiskSpaceVersion
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
  modelCatalog?: SessionListModelCatalog;
  request: SessionsListParams;
  respond: RespondFn;
  run: () => Promise<SessionsListResult>;
}): Promise<void> {
  const workKey = sessionListWorkKey(params.request, params.client);
  const state = sessionListState(params.context, params.config);
  // Every input that can change a projected row must fence reuse. Session identity,
  // Gateway projection, and live-run mutations have separate monotonic owners.
  const fence = readSessionListFence(params.context, params.modelCatalog);
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
      if (
        cacheCompleted &&
        matchesSessionListFence(readSessionListFence(params.context, params.modelCatalog), fence)
      ) {
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
