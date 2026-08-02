// Lifecycle owner for durable, restart-safe Memory Core dreaming phase execution.
import type { PluginStateLeaseRunner } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  listDreamingCyclePhaseStates,
  type PlanDreamingCyclePhase,
  planDreamingCyclePhase,
  readDreamingCyclePhaseState,
  type DreamingCyclePhaseState,
  writeDreamingCyclePhaseState,
} from "./dreaming-cycle-state.js";

const DEFAULT_LEASE_MS = 10 * 60_000;
const DREAMING_CYCLE_LEASE_NAMESPACE = "memory-core-dreaming-cycle";

export type DreamingCyclePhaseResult =
  | { status: "completed" }
  | { status: "model_wait"; notBefore: number; error?: string }
  | { status: "retry_wait"; notBefore: number; error: string }
  | { status: "terminal_failed"; error: string };

export type DreamingCycleController = ReturnType<typeof createDreamingCycleController>;

export function createDreamingCycleController(params: {
  withLease: PluginStateLeaseRunner;
  ownerId: string;
  leaseMs?: number;
  now?: () => number;
}) {
  const leaseMs = params.leaseMs ?? DEFAULT_LEASE_MS;
  const now = params.now ?? Date.now;

  const persist = async (
    current: DreamingCyclePhaseState,
    patch: Partial<DreamingCyclePhaseState>,
  ): Promise<DreamingCyclePhaseState> => {
    const next = { ...current, ...patch, updatedAt: now() };
    // Plugin state accepts plain JSON only. Clearing lifecycle metadata must remove
    // the fields rather than persist `undefined`, or recovery cannot checkpoint.
    if (next.leaseOwner === undefined) {
      delete next.leaseOwner;
    }
    if (next.leaseExpiresAt === undefined) {
      delete next.leaseExpiresAt;
    }
    if (next.lastError === undefined) {
      delete next.lastError;
    }
    await writeDreamingCyclePhaseState(next);
    return next;
  };

  const recoverWorkspace = async (workspaceDir: string): Promise<DreamingCyclePhaseState[]> => {
    const recovered: DreamingCyclePhaseState[] = [];
    for (const state of await listDreamingCyclePhaseStates(workspaceDir)) {
      if (
        (state.status === "prepared" || state.status === "model_wait") &&
        state.leaseExpiresAt !== undefined &&
        state.leaseExpiresAt <= now()
      ) {
        recovered.push(
          await persist(state, {
            status: "retry_wait",
            notBefore: now(),
            leaseOwner: undefined,
            leaseExpiresAt: undefined,
            lastError: "dreaming phase lease expired before completion",
          }),
        );
      }
    }
    return recovered;
  };

  const runPhase = async (runParams: {
    workspaceDir: string;
    cycleId: string;
    phaseId: string;
    execute: (state: DreamingCyclePhaseState, signal: AbortSignal) => Promise<DreamingCyclePhaseResult>;
  }): Promise<DreamingCyclePhaseState | undefined> =>
    await params.withLease(
      {
        namespace: DREAMING_CYCLE_LEASE_NAMESPACE,
        key: `${runParams.cycleId}:${runParams.phaseId}`,
        database: { scope: "shared" },
        leaseMs,
        waitMs: 0,
      },
      async (lease) => {
        const current = await readDreamingCyclePhaseState(runParams);
        if (!current || current.status === "completed" || current.status === "terminal_failed") {
          return current;
        }
        const currentNow = now();
        if (current.notBefore > currentNow) {
          return current;
        }
        lease.assertOwned();
        const prepared = await persist(current, {
          status: "prepared",
          attempts: current.attempts + 1,
          leaseOwner: params.ownerId,
          leaseExpiresAt: currentNow + leaseMs,
          lastError: undefined,
        });
        const result = await runParams.execute(prepared, lease.signal);
        lease.assertOwned();
        if (result.status === "completed") {
          return await persist(prepared, {
            status: "completed",
            leaseOwner: undefined,
            leaseExpiresAt: undefined,
            lastError: undefined,
          });
        }
        return await persist(prepared, {
          status: result.status,
          notBefore: result.status === "terminal_failed" ? prepared.notBefore : result.notBefore,
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          lastError: result.error,
        });
      },
    );

  return {
    planPhase: (phase: PlanDreamingCyclePhase & { nowMs?: number }) => planDreamingCyclePhase(phase),
    listWorkspace: listDreamingCyclePhaseStates,
    recoverWorkspace,
    runPhase,
  };
}

