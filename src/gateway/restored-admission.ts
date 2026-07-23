import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { stableStringify } from "../agents/stable-stringify.js";
import { sha256File, sha256Hex } from "../infra/crypto-digest.js";
import { FsSafeError, root } from "../infra/fs-safe.js";
import { syncDirectoryBestEffort } from "../infra/sqlite-snapshot.js";
import {
  loadRestoredAdmissionDescriptor,
  type RestoredAdmissionDescriptor,
} from "../snapshot/restored-recovery-point.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

export const RESTORED_ADMISSION_FILE_ENV = "OPENCLAW_RFC0013_RESTORED_ADMISSION_FILE";
export const RESTORED_ADMISSION_READY_VERSION = "openclaw-restored-admission-ready/v1";

const MAX_RECORD_BYTES = 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;
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

export type RestoredAdmissionReadyRecord = z.infer<typeof readyRecordSchema>;

export class RestoredAdmissionCompletionError extends Error {
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
  startScheduler: () => Promise<unknown>;
  getOwnerReadiness: () => { ready: boolean; failing: string[]; suppressed?: string[] };
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

  let schedulerStatus: unknown;
  try {
    schedulerStatus = await params.startScheduler();
  } catch (error) {
    throw new RestoredAdmissionCompletionError(
      "restored-admission.scheduler-hold",
      "hold",
      "Restored scheduler reconciliation did not complete.",
      { cause: error },
    );
  }
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
    schedulerIdentity: sha256Hex(stableStringify(schedulerStatus)),
    ownerReadinessIdentity: sha256Hex(
      stableStringify({
        ready: ownerReadiness.ready,
        failing: ownerReadiness.failing.toSorted(),
        suppressed: (ownerReadiness.suppressed ?? []).toSorted(),
      }),
    ),
  };
  const record = readyRecordSchema.parse({
    ...recordWithoutIdentity,
    readinessIdentity: sha256Hex(stableStringify(recordWithoutIdentity)),
  });
  const existing = await readRecordIfPresent(descriptor.journalPath, "ready.json");
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
  await writeRecord(path.join(descriptor.journalPath, "ready.json"), record);
  return { record, replayed: false };
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

async function writeRecord(filePath: string, value: RestoredAdmissionReadyRecord): Promise<void> {
  const handle = await fs.open(filePath, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(`${stableStringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectoryBestEffort(path.dirname(filePath));
}

async function readRecordIfPresent(
  rootPath: string,
  relativePath: string,
): Promise<unknown | undefined> {
  try {
    const read = await (
      await root(rootPath)
    ).read(relativePath, {
      hardlinks: "reject",
      maxBytes: MAX_RECORD_BYTES,
      symlinks: "reject",
    });
    return JSON.parse(read.buffer.toString("utf8")) as unknown;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error instanceof FsSafeError && error.code === "not-found")
    ) {
      return undefined;
    }
    throw error;
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
