import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { summarizeSpawnError } from "./spawn-error.js";
import { safeRemoveAttachmentsPath } from "./subagent-registry-helpers.js";
import {
  getLatestSubagentRunByChildSessionKey,
  hasSubagentRunIdentity,
  quarantineFailedSubagentSpawn,
} from "./subagent-registry.js";
import type { SubagentProgressOrigin } from "./subagent-registry.types.js";
import type { ProvisionalSessionCleanupIdentity } from "./subagent-spawn-cleanup-types.js";
import {
  cleanupProvisionalSession,
  resolveProvisionalSessionCleanupProof,
} from "./subagent-spawn-cleanup.js";
import {
  getRuntimeConfig,
  loadSessionEntry,
  resolveGatewaySessionStoreTarget,
} from "./subagent-spawn.runtime.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

const RETAINED_FAILED_SPAWN_ADMISSION_KEY: unique symbol = Symbol.for(
  "openclaw.retainedFailedSpawnAdmissionSlots",
);
const RETAINED_FAILED_SPAWN_ADMISSION_RETRY_MS = 1_000;
const RETAINED_FAILED_SPAWN_ADMISSION_MAX_ATTEMPTS = 30;

type RetainedFailedSpawnAdmissionStatus = "retrying" | "retained";
type RetainableAdmissionSlot = {
  id: string;
  release: () => void;
};

type RetainedFailedSpawnAdmission = {
  slot: RetainableAdmissionSlot;
  childSessionKey: string;
  retryTimer?: ReturnType<typeof setTimeout>;
  inFlight: boolean;
  attempts: number;
  maxAttempts: number;
  status: RetainedFailedSpawnAdmissionStatus;
  sessionIdentity?: ProvisionalSessionCleanupIdentity;
  attachments?: {
    attachmentsDir: string;
    attachmentsRootDir: string;
  };
};

type RetainedFailedSpawnAdmissionState = {
  holders: Map<string, RetainedFailedSpawnAdmission>;
};

type RetainedFailedSpawnAdmissionInspection = {
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
  if (holder.retryTimer) {
    return;
  }
  holder.retryTimer = setTimeout(() => {
    holder.retryTimer = undefined;
    void reconcileRetainedFailedSpawnAdmission(holder);
  }, RETAINED_FAILED_SPAWN_ADMISSION_RETRY_MS);
  holder.retryTimer.unref?.();
}

function retainedFailedSpawnAdmissionOriginalGone(holder: RetainedFailedSpawnAdmission): boolean {
  try {
    const target = resolveGatewaySessionStoreTarget({
      cfg: getRuntimeConfig(),
      key: holder.childSessionKey,
      clone: false,
    });
    const sessionEntry = loadSessionEntry({
      storePath: target.storePath,
      sessionKey: target.canonicalKey,
      clone: false,
    });
    const proof = resolveProvisionalSessionCleanupProof(sessionEntry, holder.sessionIdentity);
    return proof === "missing" || proof === "replacement";
  } catch {
    return false;
  }
}

async function releaseRetainedFailedSpawnAdmission(
  state: RetainedFailedSpawnAdmissionState,
  holder: RetainedFailedSpawnAdmission,
): Promise<boolean> {
  if (state.holders.get(holder.slot.id) !== holder) {
    return true;
  }
  if (holder.attachments && !(await safeRemoveAttachmentsPath(holder.attachments))) {
    return false;
  }
  clearRetainedFailedSpawnAdmissionTimer(holder);
  state.holders.delete(holder.slot.id);
  holder.slot.release();
  return true;
}

async function reconcileRetainedFailedSpawnAdmission(
  holder: RetainedFailedSpawnAdmission,
): Promise<void> {
  const state = getRetainedFailedSpawnAdmissionState();
  if (state.holders.get(holder.slot.id) !== holder || holder.inFlight) {
    return;
  }
  holder.inFlight = true;
  holder.attempts += 1;
  try {
    if (
      await cleanupProvisionalSession(holder.childSessionKey, {
        deleteTranscript: true,
        ...(holder.sessionIdentity ? { expectedIdentity: holder.sessionIdentity } : {}),
      })
    ) {
      if (await releaseRetainedFailedSpawnAdmission(state, holder)) {
        return;
      }
    }
    if (retainedFailedSpawnAdmissionOriginalGone(holder)) {
      if (await releaseRetainedFailedSpawnAdmission(state, holder)) {
        return;
      }
    }
  } finally {
    holder.inFlight = false;
  }
  if (state.holders.get(holder.slot.id) === holder) {
    if (holder.attempts >= holder.maxAttempts) {
      // Persistence failed, so there is no durable cleanup owner to take over.
      // Keep the slot retained and scheduled until storage proves release-safe.
      holder.status = "retained";
    }
    scheduleRetainedFailedSpawnAdmission(holder);
  }
}

function retainFailedSpawnAdmissionSlotUntilDeletion(params: {
  slot: RetainableAdmissionSlot;
  childSessionKey: string;
  sessionIdentity?: ProvisionalSessionCleanupIdentity;
  attachmentsDir?: string;
  attachmentsRootDir?: string;
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
    ...(params.sessionIdentity ? { sessionIdentity: params.sessionIdentity } : {}),
    ...(params.attachmentsDir && params.attachmentsRootDir
      ? {
          attachments: {
            attachmentsDir: params.attachmentsDir,
            attachmentsRootDir: params.attachmentsRootDir,
          },
        }
      : {}),
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

export function resolveSpawnPipelineFailure(error: unknown, phase: string) {
  const spawnStatus =
    error && typeof error === "object"
      ? (error as { spawnStatus?: unknown }).spawnStatus
      : undefined;
  const summary = summarizeSpawnError(error);
  const forbidden = spawnStatus === "forbidden";
  return {
    status: forbidden ? ("forbidden" as const) : ("error" as const),
    summary,
    message:
      phase === "register" && !forbidden ? `Failed to register subagent run: ${summary}` : summary,
  };
}

function recordIndeterminateFailedSubagentSpawn(
  admissionSlot: RetainableAdmissionSlot | undefined,
  params: {
    runId: string;
    childSessionKey: string;
    controllerSessionKey?: string | undefined;
    requesterSessionKey: string;
    requesterOrigin?: DeliveryContext | undefined;
    progressOrigin?: SubagentProgressOrigin | undefined;
    requesterDisplayKey: string;
    requesterAgentId: string;
    task: string;
    taskName?: string | undefined;
    agentId: string;
    cleanup: "delete" | "keep";
    label?: string | undefined;
    model?: string | undefined;
    agentDir?: string | undefined;
    workspaceDir?: string | undefined;
    runTimeoutSeconds: number;
    spawnMode: SpawnSubagentMode;
    reason: string;
    sessionIdentity?: ProvisionalSessionCleanupIdentity | undefined;
    attachmentsDir?: string | undefined;
    attachmentsRootDir?: string | undefined;
    retainAttachmentsOnKeep?: boolean | undefined;
    deleteCleanupDispatchedAt?: number | undefined;
    createdAt?: number | undefined;
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
        ...(params.sessionIdentity ? { sessionIdentity: params.sessionIdentity } : {}),
        ...(params.attachmentsDir ? { attachmentsDir: params.attachmentsDir } : {}),
        ...(params.attachmentsRootDir ? { attachmentsRootDir: params.attachmentsRootDir } : {}),
      });
    }
    return false;
  }
}

export function recordSpawnPipelineIndeterminateFailedSubagentSpawn(
  admissionSlot: RetainableAdmissionSlot | undefined,
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
    sessionIdentity?: ProvisionalSessionCleanupIdentity;
    attachmentsDir?: string;
    attachmentsRootDir?: string;
    retainAttachmentsOnKeep?: boolean;
    deleteCleanupDispatchedAt?: number | undefined;
    createdAt?: number;
  },
): boolean {
  return recordIndeterminateFailedSubagentSpawn(admissionSlot, {
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    ...(params.controllerSessionKey ? { controllerSessionKey: params.controllerSessionKey } : {}),
    requesterSessionKey: params.requesterSessionKey,
    ...(params.requesterOrigin ? { requesterOrigin: params.requesterOrigin } : {}),
    ...(params.progressOrigin ? { progressOrigin: params.progressOrigin } : {}),
    requesterDisplayKey: params.requesterDisplayKey,
    requesterAgentId: params.requesterAgentId,
    task: params.task,
    ...(params.taskName ? { taskName: params.taskName } : {}),
    agentId: params.agentId,
    cleanup: params.cleanup,
    ...(params.label ? { label: params.label } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    runTimeoutSeconds: params.runTimeoutSeconds,
    spawnMode: params.spawnMode,
    reason: params.reason,
    ...(params.sessionIdentity ? { sessionIdentity: params.sessionIdentity } : {}),
    ...(params.attachmentsDir ? { attachmentsDir: params.attachmentsDir } : {}),
    ...(params.attachmentsRootDir ? { attachmentsRootDir: params.attachmentsRootDir } : {}),
    ...(params.retainAttachmentsOnKeep !== undefined
      ? { retainAttachmentsOnKeep: params.retainAttachmentsOnKeep }
      : {}),
    ...(params.deleteCleanupDispatchedAt !== undefined
      ? { deleteCleanupDispatchedAt: params.deleteCleanupDispatchedAt }
      : {}),
    ...(params.createdAt !== undefined ? { createdAt: params.createdAt } : {}),
  });
}
