import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";
import { registerSubagentRun } from "./subagent-registry.js";

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

export async function runSpawnPipeline<TState>(params: {
  adapter: SpawnBackendAdapter<TState>;
  buildRegistration: (state: TState, runId: string) => RegisterSubagentRunInput;
  hookRunner?: SubagentLifecycleHookRunner | null;
  progressOrigin?: SpawnProgressOrigin;
  /** Session key the started-progress hook fires against. Backends differ on
      purpose: native passes the controller-side requester key, ACP its
      historical completion-owner key; do not collapse them. */
  progressSessionKey: string;
}): Promise<SpawnPipelineResult<TState>> {
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

  let registration: RegisterSubagentRunInput;
  try {
    // Keep construction and registration in one synchronous section so callers
    // can revalidate shared admission state without an interleaving await.
    registration = params.buildRegistration(state, runId);
    registerSubagentRun(registration);
  } catch (error) {
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
  }

  return { ok: true, state, runId };
}
