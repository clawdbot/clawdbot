import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";
import type {
  SubagentRegistrationIdentity,
  SubagentRegistrationOwnership,
} from "./subagents/registry/subagent-registry-run-launch.js";
import { registerSubagentRun } from "./subagents/registry/subagent-registry.js";
export { summarizeSpawnError } from "./spawn-error.js";

type SpawnPipelinePhase = "initialize" | "dispatch" | "register";

export type SpawnBackendAdapter<TState> = {
  initialize(): Promise<TState>;
  dispatchTurn(state: TState): Promise<{ runId: string }>;
  cleanupOnFailure(params: {
    phase: SpawnPipelinePhase;
    state?: TState;
    error: unknown;
  }): Promise<void>;
};

type RegisterSubagentRunInput = Parameters<typeof registerSubagentRun>[0];
type OwnedSubagentRegistration = RegisterSubagentRunInput & {
  expectedRegistration: SubagentRegistrationIdentity;
};

type SpawnProgressOrigin = {
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
  channelId?: string;
  messageId?: string | number;
};

type SpawnPipelineResult<TState> =
  | {
      ok: true;
      state: TState;
      runId: string;
      rollbackAccepted: () => Promise<void>;
    }
  | {
      ok: false;
      phase: SpawnPipelinePhase;
      error: unknown;
      state?: TState;
      runId?: string;
    };

function combineSpawnRollbackError(error: unknown, rollbackError: unknown, message: string): Error {
  const aggregate = new AggregateError([error, rollbackError], message);
  aggregate.cause = error;
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    Object.assign(aggregate, { code: error.code });
  }
  return aggregate;
}

function readRegistrationOwnership(error: unknown): SubagentRegistrationOwnership | undefined {
  if (!isRecord(error) || !isRegistrationOwnership(error.registrationOwnership)) {
    return undefined;
  }
  return error.registrationOwnership;
}

function isRegistrationIdentity(value: unknown): value is SubagentRegistrationIdentity {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    typeof value.childSessionKey === "string" &&
    typeof value.generation === "number" &&
    typeof value.createdAt === "number"
  );
}

function isRegistrationOwnership(value: unknown): value is SubagentRegistrationOwnership {
  if (!isRecord(value) || !isRegistrationIdentity(value.attempted)) {
    return false;
  }
  if (
    value.status === "new-row-committed" ||
    value.status === "new-row-survived" ||
    value.status === "no-new-row" ||
    value.status === "unknown"
  ) {
    return true;
  }
  return value.status === "predecessor-restored" && isRegistrationIdentity(value.predecessor);
}

class SpawnRegistrationOwnershipError extends Error {
  constructor(
    readonly registrationOwnership: Exclude<
      SubagentRegistrationOwnership,
      { status: "new-row-committed" }
    >,
  ) {
    super(
      `Subagent registration did not commit a new row: ${registrationOwnership.attempted.runId}`,
    );
  }
}

type SpawnPipelineParams<TState> = {
  adapter: SpawnBackendAdapter<TState>;
  admissionReservation?: { release: () => void };
  buildRegistration: (state: TState, runId: string) => RegisterSubagentRunInput;
  hookRunner?: SubagentLifecycleHookRunner | null;
  progressOrigin?: SpawnProgressOrigin;
  /** Session key the started-progress hook fires against. Backends differ on
      purpose: native passes the controller-side requester key, ACP its
      historical completion-owner key; do not collapse them. */
  progressSessionKey: string;
  assertRegistrationAdmission?: () => void;
  assertPostPublicationAdmission?: () => void;
  publishRegistration?: (registration: RegisterSubagentRunInput) => void;
  afterRegistration?: (state: TState, runId: string) => Promise<void>;
  recordAcceptedRollback?: (
    registration: OwnedSubagentRegistration,
    error: unknown,
  ) =>
    | { status: "persisted" }
    | { status: "pending-persistence"; error: unknown }
    | { status: "rejected" };
  rollbackRegistration?: (registration: OwnedSubagentRegistration) => boolean;
};

export async function runSpawnPipeline<TState>(
  params: SpawnPipelineParams<TState>,
): Promise<SpawnPipelineResult<TState>> {
  try {
    return await executeSpawnPipeline(params);
  } finally {
    params.admissionReservation?.release();
  }
}

async function executeSpawnPipeline<TState>(
  params: SpawnPipelineParams<TState>,
): Promise<SpawnPipelineResult<TState>> {
  let state: TState;
  try {
    state = await params.adapter.initialize();
  } catch (error) {
    await params.adapter.cleanupOnFailure({ phase: "initialize", error });
    return { ok: false, phase: "initialize", error };
  }

  let runId: string;
  try {
    ({ runId } = await params.adapter.dispatchTurn(state));
  } catch (error) {
    await params.adapter.cleanupOnFailure({ phase: "dispatch", state, error });
    return { ok: false, phase: "dispatch", state, error };
  }

  let registration!: RegisterSubagentRunInput;
  let registrationOwnership: SubagentRegistrationIdentity | undefined;
  let rollbackPromise: Promise<void> | undefined;
  const rollbackAccepted = (
    error: unknown = new Error("Accepted subagent registration rolled back."),
  ): Promise<void> => {
    if (!registrationOwnership) {
      return rollbackPromise ?? Promise.resolve();
    }
    if (rollbackPromise) {
      return rollbackPromise;
    }
    rollbackPromise = (async () => {
      const failures: unknown[] = [];
      const ownership = registrationOwnership;
      const ownedRegistration = { ...registration, expectedRegistration: ownership };
      const rollbackOwner = params.recordAcceptedRollback?.(ownedRegistration, error);
      if (rollbackOwner?.status === "rejected") {
        failures.push(new Error(`Accepted subagent rollback owner was rejected: ${runId}`));
      } else if (rollbackOwner?.status === "pending-persistence") {
        failures.push(rollbackOwner.error);
      }
      let cleanupComplete = false;
      try {
        await params.adapter.cleanupOnFailure({
          phase: "register",
          state,
          error,
        });
        cleanupComplete = true;
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (cleanupComplete) {
        try {
          if (params.rollbackRegistration?.(ownedRegistration) === false) {
            throw new Error(`Accepted subagent registration rollback lost ownership: ${runId}`);
          }
          registrationOwnership = undefined;
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      if (failures.length > 0) {
        const aggregate = new AggregateError(
          failures,
          `Accepted subagent rollback incomplete: ${runId}`,
        );
        aggregate.cause = failures[0];
        throw aggregate;
      }
    })().finally(() => {
      rollbackPromise = undefined;
    });
    return rollbackPromise;
  };
  try {
    // Keep construction and registration in one synchronous section so callers
    // can revalidate shared admission state without an interleaving await.
    registration = params.buildRegistration(state, runId);
    params.assertRegistrationAdmission?.();
    const registrationResult = registerSubagentRun(registration);
    if (registrationResult.status !== "new-row-committed") {
      throw new SpawnRegistrationOwnershipError(registrationResult);
    }
    registrationOwnership = registrationResult.attempted;
    params.publishRegistration?.(registration);
    // Registry insertion takes ownership synchronously; keeping the slot would double-count it.
    params.admissionReservation?.release();
  } catch (error) {
    const failedOwnership = readRegistrationOwnership(error);
    if (failedOwnership?.status === "new-row-survived") {
      registrationOwnership = failedOwnership.attempted;
    }
    if (registrationOwnership) {
      try {
        await rollbackAccepted(error);
      } catch (rollbackError) {
        throw combineSpawnRollbackError(
          error,
          rollbackError,
          `Subagent registration and accepted-run rollback both failed: ${runId}`,
        );
      }
      return { ok: false, phase: "register", state, runId, error };
    }
    try {
      await params.adapter.cleanupOnFailure({ phase: "register", state, error });
    } catch (cleanupError) {
      const aggregate = new AggregateError(
        [error, cleanupError],
        `Subagent registration and cleanup both failed: ${runId}`,
      );
      aggregate.cause = error;
      throw aggregate;
    }
    return { ok: false, phase: "register", state, runId, error };
  }

  if (params.hookRunner?.hasHooks("subagent_progress")) {
    try {
      await params.hookRunner.runSubagentProgress(
        {
          phase: "started",
          runId,
          childSessionKey: registration.childSessionKey,
          requester: params.progressOrigin,
        },
        {
          runId,
          childSessionKey: registration.childSessionKey,
          requesterSessionKey: params.progressSessionKey,
        },
      );
    } catch {
      // Presentation hooks are best-effort after the run is durably registered.
    }
    try {
      params.assertPostPublicationAdmission?.();
    } catch (error) {
      try {
        await rollbackAccepted(error);
        return { ok: false, phase: "register", state, runId, error };
      } catch (rollbackError) {
        return {
          ok: false,
          phase: "register",
          state,
          runId,
          error: combineSpawnRollbackError(
            error,
            rollbackError,
            `Subagent post-publication rollback incomplete: ${runId}`,
          ),
        };
      }
    }
  }

  if (params.afterRegistration) {
    try {
      await params.afterRegistration(state, runId);
      params.assertPostPublicationAdmission?.();
    } catch (error) {
      try {
        await rollbackAccepted(error);
        return { ok: false, phase: "register", state, runId, error };
      } catch (rollbackError) {
        return {
          ok: false,
          phase: "register",
          state,
          runId,
          error: combineSpawnRollbackError(
            error,
            rollbackError,
            `Subagent post-registration rollback incomplete: ${runId}`,
          ),
        };
      }
    }
  }

  return { ok: true, state, runId, rollbackAccepted: () => rollbackAccepted() };
}
