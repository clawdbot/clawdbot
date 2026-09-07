import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";
import { registerSubagentRun } from "./subagents/registry/subagent-registry.js";

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
  | { ok: true; state: TState; runId: string }
  | {
      ok: false;
      phase: SpawnPipelinePhase;
      error: unknown;
      state?: TState;
      runId?: string;
    };

export function summarizeSpawnError(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "error";
}

type SpawnPipelineParams<TState> = {
  adapter: SpawnBackendAdapter<TState>;
  assertActive?: () => void;
  admissionReservation?: { release: () => void };
  buildRegistration: (state: TState, runId: string) => RegisterSubagentRunInput;
  hookRunner?: SubagentLifecycleHookRunner | null;
  progressOrigin?: SpawnProgressOrigin;
  /** Session key the started-progress hook fires against. Backends differ on
      purpose: native passes the controller-side requester key, ACP its
      historical completion-owner key; do not collapse them. */
  progressSessionKey: string;
};

export async function runSpawnPipeline<TState>(
  params: SpawnPipelineParams<TState>,
): Promise<SpawnPipelineResult<TState>> {
  let phase: SpawnPipelinePhase = "initialize";
  let state: TState | undefined;
  let runId: string | undefined;
  try {
    let registration: RegisterSubagentRunInput;
    try {
      params.assertActive?.();
      state = await params.adapter.initialize();
      // Retain initialization's rollback handle before checking a parent that
      // may have closed while the backend was preparing its child.
      phase = "dispatch";
      params.assertActive?.();
      ({ runId } = await params.adapter.dispatchTurn(state));
      phase = "register";
      params.assertActive?.();
      // Construction and registration transfer ownership without an interleaving await.
      registration = params.buildRegistration(state, runId);
      registerSubagentRun(registration);
      // Registry insertion takes ownership synchronously; keeping the slot would double-count it.
      params.admissionReservation?.release();
    } catch (error) {
      await params.adapter.cleanupOnFailure({ phase, state, error });
      return { ok: false, phase, state, runId, error };
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
    }
    return { ok: true, state, runId };
  } finally {
    params.admissionReservation?.release();
  }
}
