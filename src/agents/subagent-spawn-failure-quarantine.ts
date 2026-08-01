import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import {
  getLatestSubagentRunByChildSessionKey,
  hasSubagentRunIdentity,
  quarantineFailedSubagentSpawn,
} from "./subagent-registry.js";
import type { SubagentProgressOrigin } from "./subagent-registry.types.js";
import type { SubagentSpawnAdmissionSlot } from "./subagent-spawn-admission.js";
import { cleanupProvisionalSession } from "./subagent-spawn-cleanup.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

const RETAINED_FAILED_SPAWN_ADMISSION_KEY: unique symbol = Symbol.for(
  "openclaw.retainedFailedSpawnAdmissionSlots",
);
const RETAINED_FAILED_SPAWN_ADMISSION_RETRY_MS = 1_000;
const RETAINED_FAILED_SPAWN_ADMISSION_MAX_ATTEMPTS = 30;

type RetainedFailedSpawnAdmissionStatus = "retrying" | "exhausted";

type RetainedFailedSpawnAdmission = {
  slot: SubagentSpawnAdmissionSlot;
  childSessionKey: string;
  retryTimer?: ReturnType<typeof setTimeout>;
  inFlight: boolean;
  attempts: number;
  maxAttempts: number;
  status: RetainedFailedSpawnAdmissionStatus;
};

type RetainedFailedSpawnAdmissionState = {
  holders: Map<string, RetainedFailedSpawnAdmission>;
};

export type RetainedFailedSpawnAdmissionInspection = {
  slotId: string;
  childSessionKey: string;
  attempts: number;
  maxAttempts: number;
  status: RetainedFailedSpawnAdmissionStatus;
  inFlight: boolean;
  retryScheduled: boolean;
};

function getRetainedFailedSpawnAdmissionState(): RetainedFailedSpawnAdmissionState {
  return resolveGlobalSingleton<RetainedFailedSpawnAdmissionState>(
    RETAINED_FAILED_SPAWN_ADMISSION_KEY,
    () => ({ holders: new Map() }),
  );
}

function clearRetainedFailedSpawnAdmissionTimer(holder: RetainedFailedSpawnAdmission): void {
  if (!holder.retryTimer) {
    return;
  }
  clearTimeout(holder.retryTimer);
  holder.retryTimer = undefined;
}

function scheduleRetainedFailedSpawnAdmission(holder: RetainedFailedSpawnAdmission): void {
  if (holder.retryTimer || holder.status === "exhausted") {
    return;
  }
  holder.retryTimer = setTimeout(() => {
    holder.retryTimer = undefined;
    void reconcileRetainedFailedSpawnAdmission(holder);
  }, RETAINED_FAILED_SPAWN_ADMISSION_RETRY_MS);
  holder.retryTimer.unref?.();
}

async function reconcileRetainedFailedSpawnAdmission(
  holder: RetainedFailedSpawnAdmission,
): Promise<void> {
  const state = getRetainedFailedSpawnAdmissionState();
  if (
    state.holders.get(holder.slot.id) !== holder ||
    holder.inFlight ||
    holder.status === "exhausted"
  ) {
    return;
  }
  holder.inFlight = true;
  holder.attempts += 1;
  try {
    if (
      await cleanupProvisionalSession(holder.childSessionKey, {
        deleteTranscript: true,
      })
    ) {
      clearRetainedFailedSpawnAdmissionTimer(holder);
      state.holders.delete(holder.slot.id);
      holder.slot.release();
      return;
    }
  } finally {
    holder.inFlight = false;
  }
  if (state.holders.get(holder.slot.id) === holder) {
    if (holder.attempts >= holder.maxAttempts) {
      holder.status = "exhausted";
      clearRetainedFailedSpawnAdmissionTimer(holder);
      return;
    }
    scheduleRetainedFailedSpawnAdmission(holder);
  }
}

export function retainFailedSpawnAdmissionSlotUntilDeletion(params: {
  slot: SubagentSpawnAdmissionSlot;
  childSessionKey: string;
}): void {
  const state = getRetainedFailedSpawnAdmissionState();
  const existing = state.holders.get(params.slot.id);
  if (existing) {
    return;
  }
  const holder: RetainedFailedSpawnAdmission = {
    slot: params.slot,
    childSessionKey: params.childSessionKey,
    inFlight: false,
    attempts: 0,
    maxAttempts: RETAINED_FAILED_SPAWN_ADMISSION_MAX_ATTEMPTS,
    status: "retrying",
  };
  state.holders.set(params.slot.id, holder);
  scheduleRetainedFailedSpawnAdmission(holder);
}

export async function reconcileRetainedFailedSpawnAdmissionsForTests(): Promise<void> {
  const state = getRetainedFailedSpawnAdmissionState();
  await Promise.all([...state.holders.values()].map(reconcileRetainedFailedSpawnAdmission));
}

export function inspectRetainedFailedSpawnAdmissions(): RetainedFailedSpawnAdmissionInspection[] {
  const state = getRetainedFailedSpawnAdmissionState();
  return [...state.holders.values()].map((holder) => ({
    slotId: holder.slot.id,
    childSessionKey: holder.childSessionKey,
    attempts: holder.attempts,
    maxAttempts: holder.maxAttempts,
    status: holder.status,
    inFlight: holder.inFlight,
    retryScheduled: Boolean(holder.retryTimer),
  }));
}

export function snapshotRetainedFailedSpawnAdmissionsForTests(): RetainedFailedSpawnAdmissionInspection[] {
  return inspectRetainedFailedSpawnAdmissions();
}

export function resetRetainedFailedSpawnAdmissionsForTests(): void {
  const state = getRetainedFailedSpawnAdmissionState();
  for (const holder of state.holders.values()) {
    clearRetainedFailedSpawnAdmissionTimer(holder);
    holder.slot.release();
  }
  state.holders.clear();
}

export function hasDurableReservedSubagentIdentity(params: {
  runId: string;
  childSessionKey: string;
}): boolean {
  return (
    hasSubagentRunIdentity(params.runId) ||
    Boolean(getLatestSubagentRunByChildSessionKey(params.childSessionKey))
  );
}

export function recordIndeterminateFailedSubagentSpawn(
  admissionSlot: SubagentSpawnAdmissionSlot | undefined,
  params: {
    runId: string;
    childSessionKey: string;
    controllerSessionKey?: string;
    requesterSessionKey: string;
    requesterOrigin?: DeliveryContext;
    progressOrigin?: SubagentProgressOrigin;
    requesterDisplayKey: string;
    requesterAgentId: string;
    task: string;
    taskName?: string;
    agentId: string;
    cleanup: "delete" | "keep";
    label?: string;
    model?: string;
    agentDir?: string;
    workspaceDir?: string;
    runTimeoutSeconds: number;
    spawnMode: SpawnSubagentMode;
    reason: string;
  },
): boolean {
  try {
    quarantineFailedSubagentSpawn(params);
    return true;
  } catch {
    if (admissionSlot) {
      retainFailedSpawnAdmissionSlotUntilDeletion({
        slot: admissionSlot,
        childSessionKey: params.childSessionKey,
      });
    }
    return false;
  }
}
