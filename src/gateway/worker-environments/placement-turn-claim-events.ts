import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";
import {
  getActiveAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { AssistantMessage } from "../../llm/types.js";
import {
  captureGatewayRootWorkAdmissionContinuationScope,
  type GatewayRootWorkAdmissionContinuationScope,
} from "../../process/gateway-work-admission.js";
import { extractAssistantPhaseText } from "../../shared/chat-message-content.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";

type TurnClaimReleaseWaiter = (error?: Error) => void;

const turnClaimReleaseWaiters = resolveGlobalMap<string, Map<string, Set<TurnClaimReleaseWaiter>>>(
  Symbol.for("openclaw.turnClaimReleaseWaiters"),
  (waitersByPath) => {
    const error = new Error("Gateway lifecycle ended while waiting for turn claim release");
    for (const bySession of waitersByPath.values()) {
      for (const waiters of bySession.values()) {
        for (const reject of waiters) {
          reject(error);
        }
      }
    }
    waitersByPath.clear();
  },
);

const workerTurnClaimClosedHandlers = resolveGlobalMap<
  string,
  Set<(claim: WorkerSessionTurnClaim) => void>
>(Symbol.for("openclaw.workerTurnClaimClosedHandlers"), (handlersByPath) => {
  handlersByPath.clear();
});

export type WorkerTurnExecutionIdentity = Readonly<{
  agentId: string;
  delegatedAuthority: AgentRunDelegatedAuthority;
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
  operationalRunInstance: OperationalRunInstanceRef;
  receiptAuthority: () => void;
  sessionKey: string;
  turnClaim: WorkerSessionTurnClaim;
}>;

export type WorkerTurnExecutionIdentityCapability = Readonly<{
  run<T>(callback: (identity: WorkerTurnExecutionIdentity) => Promise<T> | T): Promise<T>;
}>;

type BoundWorkerTurnOwner = {
  capability: WorkerTurnExecutionIdentityCapability;
  claim: WorkerSessionTurnClaim;
  claimKey: string;
  runtime: {
    delegatedAuthority: AgentRunDelegatedAuthority;
    prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage;
    scope?: GatewayRootWorkAdmissionContinuationScope;
    store: WorkerTurnExecutionIdentityStore;
  };
};

const workerTurnOwners = resolveGlobalMap<string, Map<string, BoundWorkerTurnOwner>>(
  Symbol.for("openclaw.workerTurnExecutionIdentities"),
  (ownersByPath) => {
    for (const owners of ownersByPath.values()) {
      for (const owner of owners.values()) {
        owner.runtime?.scope?.release();
      }
    }
    ownersByPath.clear();
  },
);

const WORKER_TURN_EXECUTION_IDENTITY_PATH = Symbol("workerTurnExecutionIdentityPath");
type WorkerTurnExecutionIdentityStore = {
  validateTurnClaim(claim: WorkerSessionTurnClaim): boolean;
  [WORKER_TURN_EXECUTION_IDENTITY_PATH]?: string;
};

function claimKey(claim: WorkerSessionTurnClaim): string {
  return JSON.stringify([
    claim.claimId,
    claim.runId,
    claim.placementGeneration,
    claim.owner.kind,
    claim.owner.kind === "worker" ? claim.owner.environmentId : null,
    claim.owner.kind === "worker" ? claim.owner.ownerEpoch : null,
  ]);
}

/** Bind every worker to its live run; diagnostic provenance remains optional. */
export function bindWorkerTurnOwner(
  store: WorkerTurnExecutionIdentityStore,
  claim: WorkerSessionTurnClaim,
  token: ExecutionIdentityAdmissionToken | undefined,
  operationalRunInstance: OperationalRunInstanceRef,
  source: { agentId: string; sessionKey: string },
  assertRunActive: () => void,
  prepareAssistantTranscriptMessage?: PrepareAssistantTranscriptMessage,
): void {
  const scope = captureGatewayRootWorkAdmissionContinuationScope();
  const path = store[WORKER_TURN_EXECUTION_IDENTITY_PATH];
  const delegatedAuthority = getActiveAgentRunDelegatedAuthority(operationalRunInstance);
  if (!path || !store.validateTurnClaim(claim) || !delegatedAuthority) {
    scope?.release();
    throw new Error(`Session ${claim.sessionId} worker turn authority changed`);
  }
  const owners = workerTurnOwners.get(path) ?? new Map();
  const assertActive = () => {
    assertRunActive();
    if (
      owners.get(claim.sessionId) !== owner ||
      !store.validateTurnClaim(claim) ||
      !validateAgentRunDelegatedAuthority(delegatedAuthority)
    ) {
      throw new Error(`Session ${claim.sessionId} worker turn authority changed`);
    }
  };
  const identity = Object.freeze({
    agentId: source.agentId,
    delegatedAuthority,
    ...(token ? { executionIdentityToken: token } : {}),
    operationalRunInstance,
    receiptAuthority: assertActive,
    sessionKey: source.sessionKey,
    turnClaim: claim,
  });
  const capability = Object.freeze({
    async run<T>(callback: (current: WorkerTurnExecutionIdentity) => Promise<T> | T): Promise<T> {
      assertActive();
      const result = await callback(identity);
      // Awaited policy, RPC, approval, and recovery work may close either owner.
      assertActive();
      return result;
    },
  });
  const existing = owners.get(claim.sessionId);
  const currentClaimKey = claimKey(claim);
  existing?.runtime.scope?.release();
  const owner: BoundWorkerTurnOwner = {
    capability,
    claim,
    claimKey: currentClaimKey,
    runtime: {
      delegatedAuthority,
      prepareAssistantTranscriptMessage,
      scope: scope ?? undefined,
      store,
    },
  };
  owners.set(claim.sessionId, owner);
  workerTurnOwners.set(path, owners);
}

export function getWorkerTurnExecutionIdentityCapability(
  store: WorkerTurnExecutionIdentityStore,
  claim: WorkerSessionTurnClaim,
): WorkerTurnExecutionIdentityCapability | undefined {
  const path = store[WORKER_TURN_EXECUTION_IDENTITY_PATH];
  const bound = path ? workerTurnOwners.get(path)?.get(claim.sessionId) : undefined;
  return bound && bound.claimKey === claimKey(claim) && store.validateTurnClaim(claim)
    ? bound.capability
    : undefined;
}

function resolveWorkerTurnRuntime(
  identity: WorkerConnectionIdentity,
): BoundWorkerTurnOwner["runtime"] | undefined {
  const claim = identity.turnClaim;
  if (
    !claim ||
    claim.owner.kind !== "worker" ||
    identity.sessionId !== claim.sessionId ||
    identity.runId !== claim.runId ||
    identity.environmentId !== claim.owner.environmentId ||
    identity.ownerEpoch !== claim.owner.ownerEpoch
  ) {
    return undefined;
  }
  const currentClaimKey = claimKey(claim);
  let owner: BoundWorkerTurnOwner | undefined;
  for (const owners of workerTurnOwners.values()) {
    const candidate = owners.get(claim.sessionId);
    if (candidate?.claimKey !== currentClaimKey) {
      continue;
    }
    if (owner) {
      return undefined;
    }
    owner = candidate;
  }
  const runtime = owner?.runtime;
  if (
    !owner ||
    !runtime ||
    !runtime.store.validateTurnClaim(owner.claim) ||
    !validateAgentRunDelegatedAuthority(runtime.delegatedAuthority)
  ) {
    return undefined;
  }
  return runtime;
}

export function runWorkerTurnAdmissionContinuation<T>(
  identity: WorkerConnectionIdentity,
  run: () => Promise<T>,
): Promise<T> | null {
  return resolveWorkerTurnRuntime(identity)?.scope?.run(run) ?? null;
}

/** Host-owned preparation runs at append time, after any awaited transcript admission. */
export function prepareWorkerTurnTranscriptMessage(
  identity: WorkerConnectionIdentity,
  message: AssistantMessage,
): AssistantMessage {
  return (
    resolveWorkerTurnRuntime(identity)?.prepareAssistantTranscriptMessage?.(
      message,
      extractAssistantPhaseText(message),
    ) ?? message
  );
}

export function attachWorkerTurnExecutionIdentityStore(store: object, path: string): void {
  Object.defineProperty(store, WORKER_TURN_EXECUTION_IDENTITY_PATH, { value: path });
}

export function waitersFor(path: string, sessionId: string): Set<TurnClaimReleaseWaiter> {
  let bySession = turnClaimReleaseWaiters.get(path);
  if (!bySession) {
    bySession = new Map();
    turnClaimReleaseWaiters.set(path, bySession);
  }
  let waiters = bySession.get(sessionId);
  if (!waiters) {
    waiters = new Set();
    bySession.set(sessionId, waiters);
  }
  return waiters;
}

export function signalTurnClaimRelease(path: string, sessionId: string): void {
  const bySession = turnClaimReleaseWaiters.get(path);
  const waiters = bySession?.get(sessionId);
  if (!bySession || !waiters) {
    return;
  }
  bySession.delete(sessionId);
  if (bySession.size === 0) {
    turnClaimReleaseWaiters.delete(path);
  }
  for (const resolve of waiters) {
    resolve();
  }
}

export function removeTurnClaimReleaseWaiter(
  path: string,
  sessionId: string,
  waiter: TurnClaimReleaseWaiter,
): void {
  const bySession = turnClaimReleaseWaiters.get(path);
  const waiters = bySession?.get(sessionId);
  if (!bySession || !waiters) {
    return;
  }
  waiters.delete(waiter);
  if (waiters.size === 0) {
    bySession.delete(sessionId);
  }
  if (bySession.size === 0) {
    turnClaimReleaseWaiters.delete(path);
  }
}

export function registerWorkerTurnClaimClosedHandler(
  path: string,
  handler: (claim: WorkerSessionTurnClaim) => void,
): () => void {
  const handlers = workerTurnClaimClosedHandlers.get(path) ?? new Set();
  handlers.add(handler);
  workerTurnClaimClosedHandlers.set(path, handlers);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) {
      workerTurnClaimClosedHandlers.delete(path);
    }
  };
}

export function signalWorkerTurnClaimClosed(path: string, claim: WorkerSessionTurnClaim): void {
  signalTurnClaimRelease(path, claim.sessionId);
  const owners = workerTurnOwners.get(path);
  const owner = owners?.get(claim.sessionId);
  if (owner?.claimKey === claimKey(claim)) {
    owner.runtime?.scope?.release();
    owners?.delete(claim.sessionId);
    if (owners?.size === 0) {
      workerTurnOwners.delete(path);
    }
  }
  for (const handler of workerTurnClaimClosedHandlers.get(path) ?? []) {
    try {
      handler(claim);
    } catch {
      // Settlement observation cannot roll back the authoritative store transition.
    }
  }
}
