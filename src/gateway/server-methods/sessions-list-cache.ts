import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readAgentRunIndexVersion } from "../../infra/agent-run-registry.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import {
  readSessionIdentityMutationVersion,
  readSessionLifecycleVersion,
} from "../../sessions/session-lifecycle-events.js";
import { readSessionTranscriptUpdateVersion } from "../../sessions/transcript-events.js";
import {
  readOpenClawAgentDatabaseRegistryToken,
  readOpenIncognitoAgentDatabaseGeneration,
} from "../../state/openclaw-agent-db.js";
import { readUserProfileVersion } from "../../state/user-profile-events.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import { readSessionAutomationVersion } from "../session-automation-index.js";
import { readSessionLifecyclePersistenceVersion } from "../session-lifecycle-state.js";
import { readSessionObserverDigestVersion } from "../session-observer-model.js";
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
  sessionAutomationVersion: number;
  sessionIdentityMutationVersion: number;
  sessionLifecycleVersion: number;
  sessionObserverDigestVersion: number;
  userProfileVersion: number;
  sessionsMutationVersion: number;
  sessionTranscriptUpdateVersion: number;
  titleProjectionUnavailableVersion: number;
  workerEnvironmentInventoryVersion: number;
  workerPlacementDiskSpaceVersion: number;
  workerPlacementRunnerAvailabilityVersion: number;
};
type CatalogFence = { modelCatalogRevision: string };
type SessionListOperation = CatalogFence & { promise: Promise<SessionsListResult> };
type SessionListCompleted = CatalogFence & { expiresAt?: number; result: SessionsListResult };
type SessionListState = SessionListFence & {
  completed: Map<string, SessionListCompleted>;
  config: OpenClawConfig;
  inFlight: Map<string, SessionListOperation>;
};

const SESSIONS_LIST_COMPLETED_CACHE_LIMIT = 64;
const sessionListsByContext = new WeakMap<GatewayRequestContext, SessionListState>();
const modelCatalogRevisions = new WeakMap<object, number>();
let nextModelCatalogRevision = 1;

function readModelCatalogRevision(modelCatalog: object | undefined): number {
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
 * when any row owner's entries or provider policy changes. A new read wrapper
 * alone does not invalidate the cache; the prepared facts retain stable identity.
 */
function readSessionListModelCatalogFence(
  modelCatalog: SessionListModelCatalog | undefined,
): string {
  if (!modelCatalog || modelCatalog.size === 0) {
    return "none";
  }
  return [...modelCatalog.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(
      ([agentId, catalog]) =>
        `${agentId}:${readModelCatalogRevision(catalog?.entries)}:${readModelCatalogRevision(catalog?.pluginRegistry)}`,
    )
    .join(",");
}

function readSessionListFence(context: GatewayRequestContext): SessionListFence {
  return {
    agentRunIndexVersion: readAgentRunIndexVersion(),
    agentDatabaseRegistryToken: readOpenClawAgentDatabaseRegistryToken(),
    incognitoDatabaseGeneration: readOpenIncognitoAgentDatabaseGeneration(),
    lifecyclePersistenceVersion: readSessionLifecyclePersistenceVersion(),
    sessionAutomationVersion: readSessionAutomationVersion(),
    sessionIdentityMutationVersion: readSessionIdentityMutationVersion(),
    sessionLifecycleVersion: readSessionLifecycleVersion(),
    sessionObserverDigestVersion: readSessionObserverDigestVersion(),
    userProfileVersion: readUserProfileVersion(),
    sessionsMutationVersion: readSessionsMutationVersion(context),
    // Rows embed transcript-derived previews/titles; a committed transcript
    // write without a session mutation must still invalidate reuse.
    sessionTranscriptUpdateVersion: readSessionTranscriptUpdateVersion(),
    titleProjectionUnavailableVersion: readSessionTitleProjectionUnavailableVersion(),
    workerEnvironmentInventoryVersion: context.workerEnvironmentService?.inventoryVersion() ?? 0,
    workerPlacementDiskSpaceVersion: context.workerPlacementDiskSpaceReader?.version() ?? 0,
    workerPlacementRunnerAvailabilityVersion:
      context.workerPlacementRunnerAvailabilityReader?.version() ?? 0,
  };
}

function matchesSessionListFence(value: SessionListFence, fence: SessionListFence): boolean {
  return (
    value.agentRunIndexVersion === fence.agentRunIndexVersion &&
    value.agentDatabaseRegistryToken === fence.agentDatabaseRegistryToken &&
    value.incognitoDatabaseGeneration === fence.incognitoDatabaseGeneration &&
    value.lifecyclePersistenceVersion === fence.lifecyclePersistenceVersion &&
    value.sessionAutomationVersion === fence.sessionAutomationVersion &&
    value.sessionIdentityMutationVersion === fence.sessionIdentityMutationVersion &&
    value.sessionLifecycleVersion === fence.sessionLifecycleVersion &&
    value.sessionObserverDigestVersion === fence.sessionObserverDigestVersion &&
    value.userProfileVersion === fence.userProfileVersion &&
    value.sessionsMutationVersion === fence.sessionsMutationVersion &&
    value.sessionTranscriptUpdateVersion === fence.sessionTranscriptUpdateVersion &&
    value.titleProjectionUnavailableVersion === fence.titleProjectionUnavailableVersion &&
    value.workerEnvironmentInventoryVersion === fence.workerEnvironmentInventoryVersion &&
    value.workerPlacementDiskSpaceVersion === fence.workerPlacementDiskSpaceVersion &&
    value.workerPlacementRunnerAvailabilityVersion ===
      fence.workerPlacementRunnerAvailabilityVersion
  );
}

function sessionListWorkKey(
  params: SessionsListParams,
  client: GatewayClient | null,
  config: OpenClawConfig,
): string {
  return JSON.stringify([
    // Admin visibility is global, but owner-first and involving-me rows remain viewer-specific.
    gatewayClientSessionCreator(client)?.id ?? null,
    isGatewayAdmin(client) ? "admin" : (operatorSessionCap(client, config) ?? null),
    Object.entries(params).toSorted(([left], [right]) => left.localeCompare(right)),
  ]);
}

function sessionListState(
  context: GatewayRequestContext,
  config: OpenClawConfig,
): SessionListState {
  let state = sessionListsByContext.get(context);
  // Every input that can change a projected row must fence reuse. Session identity,
  // Gateway projection, and live-run mutations have separate monotonic owners.
  const fence = readSessionListFence(context);
  if (!state || state.config !== config || !matchesSessionListFence(state, fence)) {
    // Pending callers retain their generation until they settle, but its completed
    // pages are already unusable and must not remain reachable through those callers.
    state?.completed.clear();
    state = { ...fence, completed: new Map(), config, inFlight: new Map() };
    sessionListsByContext.set(context, state);
  }
  return state;
}

function readCompletedSessionList(
  state: SessionListState,
  workKey: string,
  modelCatalogRevision: string,
): SessionsListResult | undefined {
  const completed = state.completed.get(workKey);
  if (
    completed?.modelCatalogRevision === modelCatalogRevision &&
    (completed.expiresAt === undefined || completed.expiresAt > Date.now())
  ) {
    return completed.result;
  }
  // Keep invalid lookups in this synchronous frame, not a suspended refresh.
  state.completed.delete(workKey);
  return undefined;
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
  const workKey = sessionListWorkKey(params.request, params.client, params.config);
  const state = sessionListState(params.context, params.config);
  const modelCatalogRevision = readSessionListModelCatalogFence(params.modelCatalog);
  // Activity windows and child retention expire without mutations; hidden paginated rows
  // prevent deriving a safe deadline, so only concurrent temporal requests share work.
  // Rejected and off-page candidates can change live/goal state without a store write.
  // Searches may coalesce in flight, but returned rows cannot fence their completed cache.
  const cacheCompleted =
    params.request.activeMinutes === undefined &&
    !params.request.spawnedBy &&
    !params.request.search?.trim();
  const completed = cacheCompleted
    ? readCompletedSessionList(state, workKey, modelCatalogRevision)
    : undefined;
  if (completed) {
    params.respond(true, completed, undefined);
    return;
  }
  const pending = state.inFlight.get(workKey);
  if (pending?.modelCatalogRevision === modelCatalogRevision) {
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
        sessionListsByContext.get(params.context) === state &&
        matchesSessionListFence(state, readSessionListFence(params.context)) &&
        readSessionListModelCatalogFence(params.modelCatalog) === modelCatalogRevision
      ) {
        const expiresAt = resolveSessionListExpiration(result);
        if (expiresAt !== null && (expiresAt === undefined || expiresAt > Date.now())) {
          state.completed.delete(workKey);
          state.completed.set(workKey, { modelCatalogRevision, result, expiresAt });
          pruneMapToMaxSize(state.completed, SESSIONS_LIST_COMPLETED_CACHE_LIMIT);
        }
      }
      return result;
    });
  const operation = { modelCatalogRevision, promise };
  state.inFlight.set(workKey, operation);
  try {
    params.respond(true, await promise, undefined);
  } finally {
    if (state.inFlight.get(workKey) === operation) {
      state.inFlight.delete(workKey);
    }
  }
}
