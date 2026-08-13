import { isDeepStrictEqual } from "node:util";
import { stableStringify } from "@openclaw/normalization-core";
import { z } from "zod";
import type { GatewayRestoreStatusResult } from "../../packages/gateway-protocol/src/index.js";
import { sha256File, sha256Hex } from "../infra/crypto-digest.js";
import {
  readRecoveryJournalRecord,
  writeRecoveryJournalRecord,
} from "../snapshot/recovery-journal.js";
import {
  loadRestoredAdmissionDescriptor,
  type RestoredAdmissionDescriptor,
} from "../snapshot/restored-recovery-point.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

const RESTORED_ADMISSION_READY_VERSION = "openclaw-restored-admission-ready/v1";
const SCHEDULER_RECONCILIATION_EVIDENCE_VERSION =
  "openclaw-restored-scheduler-reconciliation-evidence/v1";
const OWNER_READINESS_EVIDENCE_VERSION = "openclaw-restored-owner-readiness-evidence/v1";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const readyRecordSchema = z
  .object({
    version: z.literal(RESTORED_ADMISSION_READY_VERSION),
    runtimeLineage: z.string(),
    lifecycleOwnerGeneration: z.string(),
    destinationRuntimeGeneration: z.string(),
    restoreOperationId: z.string(),
    destinationOwner: z.string(),
    admissionIdentity: z.string(),
    restoreReceiptIdentity: z.string().regex(SHA256_PATTERN),
    schedulerIdentity: z.string().regex(SHA256_PATTERN),
    ownerReadinessIdentity: z.string().regex(SHA256_PATTERN),
    readinessIdentity: z.string().regex(SHA256_PATTERN),
  })
  .strict();

type RestoredAdmissionReadyRecord = z.infer<typeof readyRecordSchema>;

type RestoredAdmissionHeldReason = "scheduler-reconciliation" | "owner-readiness" | "ready-commit";

type RestoredAdmissionStatus = {
  get: () => GatewayRestoreStatusResult;
  setHeldReason: (reason: RestoredAdmissionHeldReason) => void;
  markReady: (record: RestoredAdmissionReadyRecord) => void;
};

export type RestoredAdmissionStartup = {
  descriptor: RestoredAdmissionDescriptor;
  release: () => boolean;
  complete: typeof completeRestoredAdmission;
  status: RestoredAdmissionStatus;
};

class RestoredAdmissionCompletionError extends Error {
  constructor(
    public readonly code:
      | "restored-admission.target-conflict"
      | "restored-admission.scheduler-hold"
      | "restored-admission.owner-readiness-hold"
      | "restored-admission.ready-conflict",
    public readonly disposition: "hold" | "quarantine",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RestoredAdmissionCompletionError";
  }
}

export async function completeRestoredAdmission(params: {
  descriptorPath?: string;
  descriptor?: RestoredAdmissionDescriptor;
  env?: NodeJS.ProcessEnv;
  startScheduler: () => Promise<void>;
  getOwnerReadiness: () => { ready: boolean; failing: string[]; suppressed?: string[] };
  setHeldReason?: (reason: RestoredAdmissionHeldReason) => void;
}): Promise<{ record: RestoredAdmissionReadyRecord; replayed: boolean }> {
  const env = params.env ?? process.env;
  const descriptor =
    params.descriptor ??
    (params.descriptorPath
      ? await prepareRestoredAdmission(params.descriptorPath, env)
      : undefined);
  if (!descriptor) {
    throw targetConflict("Restored-admission startup descriptor is required.");
  }

  try {
    await params.startScheduler();
  } catch (error) {
    throw new RestoredAdmissionCompletionError(
      "restored-admission.scheduler-hold",
      "hold",
      "Restored scheduler reconciliation did not complete.",
      { cause: error },
    );
  }
  params.setHeldReason?.("owner-readiness");
  const ownerReadiness = params.getOwnerReadiness();
  if (!ownerReadiness.ready) {
    throw new RestoredAdmissionCompletionError(
      "restored-admission.owner-readiness-hold",
      "hold",
      `Restored owners are not ready: ${ownerReadiness.failing.join(", ") || "unknown"}.`,
    );
  }

  const recordWithoutIdentity = {
    version: RESTORED_ADMISSION_READY_VERSION,
    runtimeLineage: descriptor.result.runtimeLineage,
    lifecycleOwnerGeneration: descriptor.result.lifecycleOwnerGeneration,
    destinationRuntimeGeneration: descriptor.result.destinationRuntimeGeneration,
    restoreOperationId: descriptor.result.restoreOperationId,
    destinationOwner: descriptor.result.destinationOwner,
    admissionIdentity: descriptor.result.admissionIdentity,
    restoreReceiptIdentity: descriptor.result.restoreReceiptIdentity,
    schedulerIdentity: sha256Hex(
      stableStringify({
        version: SCHEDULER_RECONCILIATION_EVIDENCE_VERSION,
        restoreReceiptIdentity: descriptor.result.restoreReceiptIdentity,
        recoveryPointId: descriptor.result.recoveryPointId,
        acceptanceSetId: descriptor.result.acceptanceSetId,
        destinationRuntimeGeneration: descriptor.result.destinationRuntimeGeneration,
        owner: "cron",
        outcome: "reconciled",
      }),
    ),
    ownerReadinessIdentity: sha256Hex(
      stableStringify({
        version: OWNER_READINESS_EVIDENCE_VERSION,
        restoreReceiptIdentity: descriptor.result.restoreReceiptIdentity,
        recoveryPointId: descriptor.result.recoveryPointId,
        acceptanceSetId: descriptor.result.acceptanceSetId,
        destinationRuntimeGeneration: descriptor.result.destinationRuntimeGeneration,
        ready: ownerReadiness.ready,
        failing: ownerReadiness.failing.toSorted(),
        suppressed: (ownerReadiness.suppressed ?? []).toSorted(),
      }),
    ),
  };
  params.setHeldReason?.("ready-commit");
  const record = readyRecordSchema.parse({
    ...recordWithoutIdentity,
    readinessIdentity: sha256Hex(stableStringify(recordWithoutIdentity)),
  });
  const existing = await readReadyRecord(descriptor.journalPath);
  if (existing !== undefined) {
    const parsed = readyRecordSchema.safeParse(existing);
    if (!parsed.success || !isDeepStrictEqual(parsed.data, record)) {
      throw new RestoredAdmissionCompletionError(
        "restored-admission.ready-conflict",
        "quarantine",
        "Restored-admission readiness evidence conflicts with the current owner state.",
      );
    }
    return { record, replayed: true };
  }
  try {
    await writeRecoveryJournalRecord(descriptor.journalPath, "ready", record);
  } catch (error) {
    throw new RestoredAdmissionCompletionError(
      "restored-admission.ready-conflict",
      "quarantine",
      "Restored-admission readiness evidence could not be committed.",
      { cause: error },
    );
  }
  return { record, replayed: false };
}

export function createRestoredAdmissionStatus(
  descriptor: RestoredAdmissionDescriptor,
): RestoredAdmissionStatus {
  let heldReason: RestoredAdmissionHeldReason = "scheduler-reconciliation";
  let readyRecord: RestoredAdmissionReadyRecord | undefined;
  const identityFields = {
    runtimeLineage: descriptor.result.runtimeLineage,
    lifecycleOwnerGeneration: descriptor.result.lifecycleOwnerGeneration,
    destinationRuntimeGeneration: descriptor.result.destinationRuntimeGeneration,
    restoreOperationId: descriptor.result.restoreOperationId,
    destinationOwner: descriptor.result.destinationOwner,
    admissionIdentity: descriptor.result.admissionIdentity,
    recoveryPointId: descriptor.result.recoveryPointId,
    acceptanceSetId: descriptor.result.acceptanceSetId,
    restoreReceiptIdentity: descriptor.result.restoreReceiptIdentity,
  };
  return {
    get: () =>
      readyRecord
        ? {
            status: "ready",
            ...identityFields,
            schedulerIdentity: readyRecord.schedulerIdentity,
            ownerReadinessIdentity: readyRecord.ownerReadinessIdentity,
            readinessIdentity: readyRecord.readinessIdentity,
          }
        : {
            status: "held",
            reason: heldReason,
            retryAfterMs: 1_000,
            ...identityFields,
          },
    setHeldReason: (reason) => {
      if (!readyRecord) {
        heldReason = reason;
      }
    },
    markReady: (record) => {
      readyRecord = record;
    },
  };
}

export async function prepareRestoredAdmission(
  descriptorPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestoredAdmissionDescriptor> {
  const descriptor = await loadRestoredAdmissionDescriptor(descriptorPath);
  await verifyRestoreReceipt(descriptor, env);
  return descriptor;
}

async function verifyRestoreReceipt(
  descriptor: RestoredAdmissionDescriptor,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const { restoreReceiptIdentity, ...resultWithoutReceipt } = descriptor.result;
  if (sha256Hex(stableStringify(resultWithoutReceipt)) !== restoreReceiptIdentity) {
    throw targetConflict("Restored recovery-point receipt identity is invalid.");
  }
  for (const component of descriptor.result.components) {
    const targetPath = resolveComponentTarget(component.componentId, env);
    let artifactSha256: string;
    try {
      artifactSha256 = await sha256File(targetPath);
    } catch (error) {
      throw targetConflict(`Restored component is unavailable: ${component.componentId}.`, error);
    }
    const targetIdentity = sha256Hex(
      stableStringify({
        componentId: component.componentId,
        destinationRuntimeGeneration: descriptor.result.destinationRuntimeGeneration,
        artifactSha256,
      }),
    );
    if (
      artifactSha256 !== component.artifactSha256 ||
      targetIdentity !== component.targetIdentity
    ) {
      throw targetConflict(
        `Restored component conflicts with its receipt: ${component.componentId}.`,
      );
    }
  }
}

function resolveComponentTarget(componentId: string, env: NodeJS.ProcessEnv): string {
  if (componentId === "sqlite/global") {
    return resolveOpenClawStateSqlitePath(env);
  }
  const prefix = "sqlite/agent/";
  if (!componentId.startsWith(prefix)) {
    throw targetConflict(`Unsupported restored component: ${componentId}.`);
  }
  return resolveOpenClawAgentSqlitePath({ agentId: componentId.slice(prefix.length), env });
}

async function readReadyRecord(databasePath: string): Promise<unknown> {
  try {
    return await readRecoveryJournalRecord(databasePath, "ready");
  } catch (error) {
    throw targetConflict("Persisted admission record is unreadable: ready.", error);
  }
}

function targetConflict(message: string, cause?: unknown): RestoredAdmissionCompletionError {
  return new RestoredAdmissionCompletionError(
    "restored-admission.target-conflict",
    "quarantine",
    message,
    cause === undefined ? undefined : { cause },
  );
}
