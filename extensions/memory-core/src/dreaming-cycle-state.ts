// Durable Memory Core dreaming-cycle checkpoints stored in shared plugin-state SQLite.
import { createHash } from "node:crypto";
import {
  readMemoryCoreWorkspaceEntries,
  readMemoryCoreWorkspaceEntry,
  writeMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";

export const DREAMING_CYCLE_STATE_NAMESPACE = "dreaming-cycle-runs";

export type DreamingCyclePhaseStatus =
  | "planned"
  | "prepared"
  | "model_wait"
  | "retry_wait"
  | "completed"
  | "terminal_failed";

export type DreamingCyclePhaseState = {
  version: 1;
  cycleId: string;
  phaseId: string;
  workspaceDir: string;
  phase: string;
  status: DreamingCyclePhaseStatus;
  notBefore: number;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  lastError?: string;
};

export type PlanDreamingCyclePhase = {
  workspaceDir: string;
  cycleKey: string;
  phase: string;
  notBefore: number;
};

function stableId(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

export function resolveDreamingCycleId(params: Pick<PlanDreamingCyclePhase, "workspaceDir" | "cycleKey">): string {
  return stableId([params.workspaceDir, params.cycleKey]);
}

export function resolveDreamingPhaseId(params: PlanDreamingCyclePhase): string {
  return stableId([resolveDreamingCycleId(params), params.phase]);
}

function stateKey(cycleId: string, phaseId: string): string {
  return `${cycleId}:${phaseId}`;
}

export async function readDreamingCyclePhaseState(params: {
  workspaceDir: string;
  cycleId: string;
  phaseId: string;
}): Promise<DreamingCyclePhaseState | undefined> {
  return await readMemoryCoreWorkspaceEntry<DreamingCyclePhaseState>({
    namespace: DREAMING_CYCLE_STATE_NAMESPACE,
    workspaceDir: params.workspaceDir,
    key: stateKey(params.cycleId, params.phaseId),
  });
}

export async function listDreamingCyclePhaseStates(
  workspaceDir: string,
): Promise<DreamingCyclePhaseState[]> {
  const entries = await readMemoryCoreWorkspaceEntries<DreamingCyclePhaseState>({
    namespace: DREAMING_CYCLE_STATE_NAMESPACE,
    workspaceDir,
  });
  return entries.map((entry) => entry.value).toSorted((a, b) => {
    const byStart = a.notBefore - b.notBefore;
    return byStart !== 0 ? byStart : a.phaseId.localeCompare(b.phaseId);
  });
}

export async function writeDreamingCyclePhaseState(state: DreamingCyclePhaseState): Promise<void> {
  await writeMemoryCoreWorkspaceEntry({
    namespace: DREAMING_CYCLE_STATE_NAMESPACE,
    workspaceDir: state.workspaceDir,
    key: stateKey(state.cycleId, state.phaseId),
    value: state,
  });
}

export async function planDreamingCyclePhase(
  params: PlanDreamingCyclePhase & { nowMs?: number },
): Promise<DreamingCyclePhaseState> {
  const cycleId = resolveDreamingCycleId(params);
  const phaseId = resolveDreamingPhaseId(params);
  const existing = await readDreamingCyclePhaseState({
    workspaceDir: params.workspaceDir,
    cycleId,
    phaseId,
  });
  if (existing) {
    return existing;
  }
  const now = params.nowMs ?? Date.now();
  const state: DreamingCyclePhaseState = {
    version: 1,
    cycleId,
    phaseId,
    workspaceDir: params.workspaceDir,
    phase: params.phase,
    status: "planned",
    notBefore: params.notBefore,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  await writeDreamingCyclePhaseState(state);
  return state;
}

