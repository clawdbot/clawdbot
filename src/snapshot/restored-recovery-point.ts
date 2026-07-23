import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { stableStringify } from "../agents/stable-stringify.js";
import { sha256File, sha256Hex } from "../infra/crypto-digest.js";
import { ensureAbsoluteDirectory, FsSafeError, root } from "../infra/fs-safe.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import { syncDirectoryBestEffort } from "../infra/sqlite-snapshot.js";
import { isValidAgentId, normalizeAgentId } from "../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createLocalSqliteSnapshotProvider } from "./local-repository.js";
import {
  verifyRecoveryPoint,
  type RecoveryPointManifest,
  type RecoveryPointSqliteSnapshot,
} from "./recovery-point.js";

export const RESTORED_RECOVERY_POINT_REQUEST_VERSION =
  "openclaw-restored-recovery-point-request/v1";
export const RESTORED_RECOVERY_POINT_RESULT_VERSION = "openclaw-restored-recovery-point-result/v1";
export const RESTORED_ADMISSION_DESCRIPTOR_VERSION = "openclaw-restored-admission/v1";

const MAX_RECORD_BYTES = 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,254}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const requestSchema = z
  .object({
    version: z.literal(RESTORED_RECOVERY_POINT_REQUEST_VERSION),
    runtimeLineage: z.string().regex(SAFE_ID_PATTERN),
    lifecycleOwnerGeneration: z.string().regex(SAFE_ID_PATTERN),
    destinationRuntimeGeneration: z.string().regex(SAFE_ID_PATTERN),
    restoreOperationId: z.string().regex(SAFE_ID_PATTERN),
    destinationOwner: z.string().regex(SAFE_ID_PATTERN),
    admissionIdentity: z.string().regex(SAFE_ID_PATTERN),
    recoveryPointPath: z.string().min(1),
    recoveryPointId: z.string().regex(SHA256_PATTERN),
    acceptanceSetId: z.string().regex(SHA256_PATTERN),
    expectedAgentIds: z.array(z.string().min(1).max(64)).min(1),
    journalRoot: z.string().min(1),
  })
  .strict();

const componentReceiptSchema = z
  .object({
    componentId: z.string().regex(SAFE_ID_PATTERN),
    artifactSha256: z.string().regex(SHA256_PATTERN),
    targetIdentity: z.string().regex(SHA256_PATTERN),
  })
  .strict();

const resultSchema = z
  .object({
    version: z.literal(RESTORED_RECOVERY_POINT_RESULT_VERSION),
    ok: z.literal(true),
    runtimeLineage: z.string().regex(SAFE_ID_PATTERN),
    lifecycleOwnerGeneration: z.string().regex(SAFE_ID_PATTERN),
    destinationRuntimeGeneration: z.string().regex(SAFE_ID_PATTERN),
    restoreOperationId: z.string().regex(SAFE_ID_PATTERN),
    destinationOwner: z.string().regex(SAFE_ID_PATTERN),
    admissionIdentity: z.string().regex(SAFE_ID_PATTERN),
    recoveryPointId: z.string().regex(SHA256_PATTERN),
    acceptanceSetId: z.string().regex(SHA256_PATTERN),
    restoreReceiptIdentity: z.string().regex(SHA256_PATTERN),
    startupDescriptorPath: z.string().min(1),
    components: z.array(componentReceiptSchema).min(2),
  })
  .strict();

const descriptorSchema = z
  .object({
    version: z.literal(RESTORED_ADMISSION_DESCRIPTOR_VERSION),
    journalPath: z.string().min(1),
    result: resultSchema,
  })
  .strict();

export type RestoredRecoveryPointRequest = z.infer<typeof requestSchema>;
export type RestoredRecoveryPointResult = z.infer<typeof resultSchema>;
export type RestoredAdmissionDescriptor = z.infer<typeof descriptorSchema>;

export type RestoredRecoveryPointFailureCode =
  | "restored-admission.request-invalid"
  | "restored-admission.operation-conflict"
  | "restored-admission.dependency-hold"
  | "restored-admission.verification-failed"
  | "restored-admission.restore-failed";

export class RestoredRecoveryPointError extends Error {
  constructor(
    public readonly code: RestoredRecoveryPointFailureCode,
    public readonly disposition: "hold" | "quarantine",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RestoredRecoveryPointError";
  }
}

export function parseRestoredRecoveryPointRequest(raw: string): RestoredRecoveryPointRequest {
  if (Buffer.byteLength(raw) > MAX_RECORD_BYTES) {
    throw invalidRequest("Restored recovery-point request is too large.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw invalidRequest("Restored recovery-point request is not valid JSON.", error);
  }
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidRequest(`Restored recovery-point request is invalid: ${parsed.error.message}`);
  }
  const request = parsed.data;
  for (const [label, candidate] of [
    ["recoveryPointPath", request.recoveryPointPath],
    ["journalRoot", request.journalRoot],
  ] as const) {
    if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) {
      throw invalidRequest(`${label} must be a normalized absolute path.`);
    }
  }
  assertAgentInventory(request.expectedAgentIds);
  return request;
}

export function parseRestoredAdmissionDescriptor(value: unknown): RestoredAdmissionDescriptor {
  const parsed = descriptorSchema.safeParse(value);
  if (!parsed.success) {
    throw conflict(`Restored-admission startup descriptor is invalid: ${parsed.error.message}`);
  }
  const descriptor = parsed.data;
  if (
    !path.isAbsolute(descriptor.journalPath) ||
    path.normalize(descriptor.journalPath) !== descriptor.journalPath
  ) {
    throw conflict("Restored-admission journal path must be a normalized absolute path.");
  }
  if (
    !path.isAbsolute(descriptor.result.startupDescriptorPath) ||
    path.normalize(descriptor.result.startupDescriptorPath) !==
      descriptor.result.startupDescriptorPath ||
    path.dirname(descriptor.result.startupDescriptorPath) !== descriptor.journalPath
  ) {
    throw conflict("Restored-admission descriptor path is outside its private journal.");
  }
  return descriptor;
}

export async function loadRestoredAdmissionDescriptor(
  descriptorPath: string,
): Promise<RestoredAdmissionDescriptor> {
  if (!path.isAbsolute(descriptorPath) || path.normalize(descriptorPath) !== descriptorPath) {
    throw conflict("Restored-admission descriptor path must be a normalized absolute path.");
  }
  const value = await readJson(path.dirname(descriptorPath), path.basename(descriptorPath));
  const descriptor = parseRestoredAdmissionDescriptor(value);
  if (descriptor.result.startupDescriptorPath !== descriptorPath) {
    throw conflict("Restored-admission descriptor does not identify its loaded path.");
  }
  return descriptor;
}

export async function restoreAcceptedRecoveryPoint(
  requestValue: RestoredRecoveryPointRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestoredRecoveryPointResult> {
  const request = parseRestoredRecoveryPointRequest(stableStringify(requestValue));
  const journalPath = path.join(
    request.journalRoot,
    sha256Hex(
      stableStringify({
        runtimeLineage: request.runtimeLineage,
        destinationRuntimeGeneration: request.destinationRuntimeGeneration,
        restoreOperationId: request.restoreOperationId,
      }),
    ),
  );
  const startupDescriptorPath = path.join(journalPath, "startup.json");
  await ensurePrivateDirectory(journalPath);
  const existingIntent = await readJsonIfPresent(journalPath, "intent.json");
  const existingResult = await readJsonIfPresent(journalPath, "result.json");
  if (existingResult !== undefined) {
    if (!isDeepStrictEqual(existingIntent, request)) {
      throw conflict("Committed restore has conflicting intent evidence.");
    }
    const replayed = resultSchema.safeParse(existingResult);
    if (!replayed.success) {
      throw conflict("Committed restore result is invalid.");
    }
    await verifyCommittedRestore(request, replayed.data, startupDescriptorPath, env);
    await writeStartupDescriptor(startupDescriptorPath, journalPath, replayed.data);
    return replayed.data;
  }
  if (existingIntent !== undefined) {
    throw conflict("Restore has durable intent without a committed result.");
  }

  const verified = await verifyAcceptedRecoveryPoint(request);
  assertNoRequiredObligations(verified.manifest);
  await writeRecord(path.join(journalPath, "intent.json"), request);

  const componentReceipts: Array<z.infer<typeof componentReceiptSchema>> = [];
  try {
    for (const [index, component] of verified.manifest.components.entries()) {
      const snapshot = verified.snapshots[index]!;
      const targetPath = targetPathForComponent(component, env);
      await snapshot.provider.restoreFresh(snapshot.ref, targetPath);
      const artifactSha256 = await sha256File(targetPath);
      if (artifactSha256 !== component.artifactSha256) {
        throw new Error(`Restored component digest mismatch: ${component.id}`);
      }
      componentReceipts.push({
        componentId: component.id,
        artifactSha256,
        targetIdentity: sha256Hex(
          stableStringify({
            componentId: component.id,
            destinationRuntimeGeneration: request.destinationRuntimeGeneration,
            artifactSha256,
          }),
        ),
      });
    }
  } catch (error) {
    throw new RestoredRecoveryPointError(
      "restored-admission.restore-failed",
      "quarantine",
      "Recovery point could not be restored after durable intent.",
      { cause: error },
    );
  }

  const result = createRestoreResult({
    request,
    recoveryPointId: verified.manifest.recoveryPointId,
    acceptanceSetId: verified.acceptanceSetId,
    startupDescriptorPath,
    components: componentReceipts,
  });
  await writeRecord(path.join(journalPath, "result.json"), result);
  await writeStartupDescriptor(startupDescriptorPath, journalPath, result);
  return result;
}

async function verifyAcceptedRecoveryPoint(request: RestoredRecoveryPointRequest): Promise<{
  manifest: RecoveryPointManifest;
  acceptanceSetId: string;
  snapshots: RecoveryPointSqliteSnapshot[];
}> {
  try {
    const manifest = (await readJson(request.recoveryPointPath, "manifest.json")) as unknown;
    const snapshots = await resolveSnapshots(request.recoveryPointPath, request.expectedAgentIds);
    const verified = await verifyRecoveryPoint({
      manifest,
      snapshots,
      expectedAgentIds: request.expectedAgentIds,
    });
    if (
      verified.manifest.recoveryPointId !== request.recoveryPointId ||
      verified.acceptance.acceptanceSetId !== request.acceptanceSetId
    ) {
      throw new Error("Accepted recovery-point identity does not match verified bytes.");
    }
    return {
      manifest: verified.manifest,
      acceptanceSetId: verified.acceptance.acceptanceSetId,
      snapshots,
    };
  } catch (error) {
    if (error instanceof RestoredRecoveryPointError) {
      throw error;
    }
    throw new RestoredRecoveryPointError(
      "restored-admission.verification-failed",
      "quarantine",
      "Accepted recovery point did not verify before target mutation.",
      { cause: error },
    );
  }
}

async function resolveSnapshots(
  recoveryPointPath: string,
  expectedAgentIds: readonly string[],
): Promise<RecoveryPointSqliteSnapshot[]> {
  const repositories = [
    { path: path.join(recoveryPointPath, "components", "global"), role: "global" as const },
    ...expectedAgentIds.map((agentId) => ({
      path: path.join(recoveryPointPath, "components", "agents", agentId),
      role: "agent" as const,
    })),
  ];
  const snapshots: RecoveryPointSqliteSnapshot[] = [];
  for (const repository of repositories) {
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath: repository.path,
      allowedDatabaseRoles: [repository.role],
    });
    const entries = await provider.list();
    if (entries.length !== 1) {
      throw new Error("Recovery point has an invalid snapshot component set.");
    }
    snapshots.push({ provider, ref: entries[0]!.ref });
  }
  return snapshots;
}

function assertNoRequiredObligations(manifest: RecoveryPointManifest): void {
  const required = [...manifest.obligations.external, ...manifest.obligations.reconstructed].filter(
    (obligation) => obligation.readinessRequired,
  );
  if (required.length > 0) {
    throw new RestoredRecoveryPointError(
      "restored-admission.dependency-hold",
      "hold",
      "Required owner obligations have no accepted evidence in this V1 slice.",
    );
  }
}

function targetPathForComponent(
  component: RecoveryPointManifest["components"][number],
  env: NodeJS.ProcessEnv,
): string {
  return component.kind === "sqlite-global"
    ? resolveOpenClawStateSqlitePath(env)
    : resolveOpenClawAgentSqlitePath({ agentId: component.agentId, env });
}

async function verifyCommittedRestore(
  request: RestoredRecoveryPointRequest,
  result: RestoredRecoveryPointResult,
  startupDescriptorPath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const verified = await verifyAcceptedRecoveryPoint(request);
  const expectedComponents = [];
  for (const component of verified.manifest.components) {
    const artifactSha256 = await sha256File(targetPathForComponent(component, env));
    expectedComponents.push({
      componentId: component.id,
      artifactSha256,
      targetIdentity: sha256Hex(
        stableStringify({
          componentId: component.id,
          destinationRuntimeGeneration: request.destinationRuntimeGeneration,
          artifactSha256,
        }),
      ),
    });
  }
  const expected = createRestoreResult({
    request,
    recoveryPointId: verified.manifest.recoveryPointId,
    acceptanceSetId: verified.acceptanceSetId,
    startupDescriptorPath,
    components: expectedComponents,
  });
  if (!isDeepStrictEqual(result, expected)) {
    throw conflict("Committed restore result conflicts with restored bytes.");
  }
}

function createRestoreResult(params: {
  request: RestoredRecoveryPointRequest;
  recoveryPointId: string;
  acceptanceSetId: string;
  startupDescriptorPath: string;
  components: Array<z.infer<typeof componentReceiptSchema>>;
}): RestoredRecoveryPointResult {
  const resultWithoutReceipt = {
    version: RESTORED_RECOVERY_POINT_RESULT_VERSION,
    ok: true as const,
    runtimeLineage: params.request.runtimeLineage,
    lifecycleOwnerGeneration: params.request.lifecycleOwnerGeneration,
    destinationRuntimeGeneration: params.request.destinationRuntimeGeneration,
    restoreOperationId: params.request.restoreOperationId,
    destinationOwner: params.request.destinationOwner,
    admissionIdentity: params.request.admissionIdentity,
    recoveryPointId: params.recoveryPointId,
    acceptanceSetId: params.acceptanceSetId,
    startupDescriptorPath: params.startupDescriptorPath,
    components: params.components,
  };
  return resultSchema.parse({
    ...resultWithoutReceipt,
    restoreReceiptIdentity: sha256Hex(stableStringify(resultWithoutReceipt)),
  });
}

async function writeStartupDescriptor(
  startupDescriptorPath: string,
  journalPath: string,
  result: RestoredRecoveryPointResult,
): Promise<void> {
  const descriptor = descriptorSchema.parse({
    version: RESTORED_ADMISSION_DESCRIPTOR_VERSION,
    journalPath,
    result,
  });
  const existing = await readJsonIfPresent(journalPath, path.basename(startupDescriptorPath));
  if (existing !== undefined) {
    if (!isDeepStrictEqual(existing, descriptor)) {
      throw conflict("Restored-admission startup descriptor conflicts with committed restore.");
    }
    return;
  }
  await writeRecord(startupDescriptorPath, descriptor);
}

async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  const result = await ensureAbsoluteDirectory(directoryPath, {
    mode: PRIVATE_DIRECTORY_MODE,
    scopeLabel: "restored recovery-point journal",
  });
  if (!result.ok) {
    throw result.error;
  }
  const stat = await fs.lstat(result.path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw conflict("Restored recovery-point journal is not a trusted directory.");
  }
  applyPrivateModeSync(result.path, PRIVATE_DIRECTORY_MODE);
}

async function writeRecord(filePath: string, value: unknown): Promise<void> {
  const handle = await fs.open(filePath, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(`${stableStringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectoryBestEffort(path.dirname(filePath));
}

async function readJsonIfPresent(
  rootPath: string,
  relativePath: string,
): Promise<unknown | undefined> {
  try {
    return await readJson(rootPath, relativePath);
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

async function readJson(rootPath: string, relativePath: string): Promise<unknown> {
  const read = await (
    await root(rootPath)
  ).read(relativePath, {
    hardlinks: "reject",
    maxBytes: MAX_RECORD_BYTES,
    symlinks: "reject",
  });
  return JSON.parse(read.buffer.toString("utf8")) as unknown;
}

function assertAgentInventory(agentIds: readonly string[]): void {
  const normalized = agentIds.map((agentId) => normalizeAgentId(agentId));
  if (
    normalized.some(
      (agentId, index) => !isValidAgentId(agentIds[index]!) || agentId !== agentIds[index],
    ) ||
    new Set(normalized).size !== normalized.length ||
    !isDeepStrictEqual(normalized, normalized.toSorted())
  ) {
    throw invalidRequest("expectedAgentIds must be unique, normalized, and sorted.");
  }
}

function invalidRequest(message: string, cause?: unknown): RestoredRecoveryPointError {
  return new RestoredRecoveryPointError(
    "restored-admission.request-invalid",
    "quarantine",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function conflict(message: string, cause?: unknown): RestoredRecoveryPointError {
  return new RestoredRecoveryPointError(
    "restored-admission.operation-conflict",
    "quarantine",
    message,
    cause === undefined ? undefined : { cause },
  );
}
