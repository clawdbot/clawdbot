import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";
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
  rollbackRegistration?: (registration: RegisterSubagentRunInput) => void;
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
  let registrationActive = false;
  let rollbackPromise: Promise<void> | undefined;
  const rollbackAccepted = (
    error: unknown = new Error("Accepted subagent registration rolled back."),
  ): Promise<void> => {
    if (!registrationActive) {
      return rollbackPromise ?? Promise.resolve();
    }
    registrationActive = false;
    params.rollbackRegistration?.(registration);
    rollbackPromise = params.adapter.cleanupOnFailure({
      phase: "register",
      state,
      error,
    });
    return rollbackPromise;
  };
  try {
    // Keep construction and registration in one synchronous section so callers
    // can revalidate shared admission state without an interleaving await.
    registration = params.buildRegistration(state, runId);
    params.assertRegistrationAdmission?.();
    registerSubagentRun(registration);
    registrationActive = true;
    params.publishRegistration?.(registration);
    // Registry insertion takes ownership synchronously; keeping the slot would double-count it.
    params.admissionReservation?.release();
  } catch (error) {
    if (registrationActive) {
      registrationActive = false;
      params.rollbackRegistration?.(registration);
    }
    await params.adapter.cleanupOnFailure({ phase: "register", state, error });
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
      await rollbackAccepted(error);
      return { ok: false, phase: "register", state, runId, error };
    }
  }

  if (params.afterRegistration) {
    try {
      await params.afterRegistration(state, runId);
      params.assertPostPublicationAdmission?.();
    } catch (error) {
      await rollbackAccepted(error);
      return { ok: false, phase: "register", state, runId, error };
    }
  }

  return { ok: true, state, runId, rollbackAccepted: () => rollbackAccepted() };
}
