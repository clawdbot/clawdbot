import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { stableStringify } from "../agents/stable-stringify.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { ensureAbsoluteDirectory, FsSafeError, root } from "../infra/fs-safe.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import { syncDirectoryBestEffort } from "../infra/sqlite-snapshot.js";
import { isValidAgentId, normalizeAgentId } from "../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createLocalSqliteSnapshotProvider } from "./local-repository.js";
import {
  createRecoveryPointManifest,
  verifyRecoveryPoint,
  type RecoveryPointAcceptance,
  type RecoveryPointManifest,
  type RecoveryPointSqliteSnapshot,
} from "./recovery-point.js";

export const FINAL_RECOVERY_POINT_REQUEST_VERSION = "openclaw-final-recovery-point-request/v1";
const FINAL_RECOVERY_POINT_RESULT_VERSION = "openclaw-final-recovery-point-result/v1";

const MAX_RECORD_BYTES = 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,254}$/u;

const finalRecoveryPointRequestSchema = z
  .object({
    version: z.literal(FINAL_RECOVERY_POINT_REQUEST_VERSION),
    runtimeLineage: z.string().regex(SAFE_ID_PATTERN),
    handoffId: z.string().regex(SAFE_ID_PATTERN),
    sourceGeneration: z.string().regex(SAFE_ID_PATTERN),
    capturedAt: z.string(),
    repositoryPath: z.string().min(1),
    expectedAgentIds: z.array(z.string().min(1).max(64)).min(1),
    closure: z
      .object({
        gateway: z.literal("cleanly-stopped"),
        authoritativeWriters: z.literal("stopped"),
        evidenceId: z.string().regex(SAFE_ID_PATTERN),
      })
      .strict(),
  })
  .strict();

const finalRecoveryPointResultSchema = z
  .object({
    version: z.literal(FINAL_RECOVERY_POINT_RESULT_VERSION),
    ok: z.literal(true),
    runtimeLineage: z.string().regex(SAFE_ID_PATTERN),
    handoffId: z.string().regex(SAFE_ID_PATTERN),
    sourceGeneration: z.string().regex(SAFE_ID_PATTERN),
    closureEvidenceId: z.string().regex(SAFE_ID_PATTERN),
    recoveryPointPath: z.string().min(1),
    aggregateManifestPath: z.string().min(1),
    recoveryPointId: z.string().regex(/^[a-f0-9]{64}$/u),
    acceptanceSetId: z.string().regex(/^[a-f0-9]{64}$/u),
    aggregateManifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    aggregateManifestSizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    components: z.array(
      z
        .object({
          componentId: z.string().min(1),
          snapshotPath: z.string().min(1),
          ownerManifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
          ownerManifestSizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
          artifactSizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
    ),
  })
  .strict();

export type FinalRecoveryPointRequest = z.infer<typeof finalRecoveryPointRequestSchema>;
export type FinalRecoveryPointResult = z.infer<typeof finalRecoveryPointResultSchema>;

export type FinalRecoveryPointFailureCode =
  | "final-capture.request-invalid"
  | "final-capture.operation-conflict"
  | "final-capture.snapshot-failed"
  | "final-capture.verification-failed";

export class FinalRecoveryPointError extends Error {
  constructor(
    public readonly code: FinalRecoveryPointFailureCode,
    public readonly disposition: "hold" | "quarantine",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FinalRecoveryPointError";
  }
}

export function parseFinalRecoveryPointRequest(raw: string): FinalRecoveryPointRequest {
  if (Buffer.byteLength(raw) > MAX_RECORD_BYTES) {
    throw new FinalRecoveryPointError(
      "final-capture.request-invalid",
      "quarantine",
      "Final recovery-point request is too large.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new FinalRecoveryPointError(
      "final-capture.request-invalid",
      "quarantine",
      "Final recovery-point request is not valid JSON.",
      { cause: error },
    );
  }
  const parsed = finalRecoveryPointRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new FinalRecoveryPointError(
      "final-capture.request-invalid",
      "quarantine",
      `Final recovery-point request is invalid: ${parsed.error.message}`,
    );
  }
  const request = parsed.data;
  if (
    !path.isAbsolute(request.repositoryPath) ||
    path.normalize(request.repositoryPath) !== request.repositoryPath
  ) {
    throw new FinalRecoveryPointError(
      "final-capture.request-invalid",
      "quarantine",
      "Final recovery-point repositoryPath must be a normalized absolute path.",
    );
  }
  assertCanonicalTimestamp(request.capturedAt);
  assertAgentInventory(request.expectedAgentIds);
  return request;
}

export async function captureFinalRecoveryPoint(
  requestValue: FinalRecoveryPointRequest,
): Promise<FinalRecoveryPointResult> {
  const request = parseFinalRecoveryPointRequest(stableStringify(requestValue));
  const operationId = sha256Hex(
    stableStringify({
      runtimeLineage: request.runtimeLineage,
      handoffId: request.handoffId,
      sourceGeneration: request.sourceGeneration,
    }),
  );
  const recoveryPointPath = path.join(request.repositoryPath, operationId);
  try {
    await ensurePrivateDirectory(recoveryPointPath);
  } catch (error) {
    if (error instanceof FinalRecoveryPointError) {
      throw error;
    }
    throw new FinalRecoveryPointError(
      "final-capture.snapshot-failed",
      "hold",
      "Final recovery-point repository could not be prepared.",
      { cause: error },
    );
  }

  const intentPath = path.join(recoveryPointPath, "intent.json");
  const resultPath = path.join(recoveryPointPath, "result.json");
  const existingResult = await readJsonIfPresent(recoveryPointPath, "result.json");
  const existingIntent = await readJsonIfPresent(recoveryPointPath, "intent.json");
  if (existingResult !== undefined) {
    if (!isDeepStrictEqual(existingIntent, request)) {
      throw operationConflict("Committed final recovery point has conflicting intent evidence.");
    }
    return await verifyCommittedResult(request, recoveryPointPath, existingResult);
  }
  if (existingIntent !== undefined) {
    throw operationConflict(
      "Final recovery-point capture has durable intent without a committed result.",
    );
  }
  await writeCaptureRecord(intentPath, request, "intent");

  let snapshots: RecoveryPointSqliteSnapshot[];
  try {
    snapshots = await captureSqliteInventory(request, recoveryPointPath);
  } catch (error) {
    if (error instanceof FinalRecoveryPointError) {
      throw error;
    }
    throw new FinalRecoveryPointError(
      "final-capture.snapshot-failed",
      "hold",
      "Final recovery-point SQLite capture failed after durable intent.",
      { cause: error },
    );
  }

  let manifest: RecoveryPointManifest;
  let acceptance: RecoveryPointAcceptance;
  try {
    manifest = await createRecoveryPointManifest({
      snapshots,
      expectedAgentIds: request.expectedAgentIds,
      now: () => new Date(request.capturedAt),
    });
    ({ acceptance } = await verifyRecoveryPoint({
      manifest,
      snapshots,
      expectedAgentIds: request.expectedAgentIds,
    }));
  } catch (error) {
    throw new FinalRecoveryPointError(
      "final-capture.verification-failed",
      "hold",
      "Final recovery-point aggregate verification failed after durable intent.",
      { cause: error },
    );
  }

  const aggregateManifestPath = path.join(recoveryPointPath, "manifest.json");
  await writeCaptureBytes(
    aggregateManifestPath,
    Buffer.from(stableStringify(manifest), "utf8"),
    "aggregate manifest",
  );
  const result = buildResult({
    request,
    recoveryPointPath,
    aggregateManifestPath,
    manifest,
    acceptance,
    snapshots,
  });
  await writeCaptureRecord(resultPath, result, "committed result");
  return result;
}

async function captureSqliteInventory(
  request: FinalRecoveryPointRequest,
  recoveryPointPath: string,
): Promise<RecoveryPointSqliteSnapshot[]> {
  const capturedAt = () => new Date(request.capturedAt);
  const componentsRoot = path.join(recoveryPointPath, "components");
  const captures = [
    {
      repositoryPath: path.join(componentsRoot, "global"),
      databasePath: await fs.realpath(resolveOpenClawStateSqlitePath()),
      identity: { role: "global" as const },
    },
    ...(await Promise.all(
      request.expectedAgentIds.map(async (agentId) => ({
        repositoryPath: path.join(componentsRoot, "agents", agentId),
        databasePath: await fs.realpath(resolveOpenClawAgentSqlitePath({ agentId })),
        identity: { role: "agent" as const, agentId },
      })),
    )),
  ];
  const snapshots: RecoveryPointSqliteSnapshot[] = [];
  for (const capture of captures) {
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath: capture.repositoryPath,
      allowedDatabaseRoles: [capture.identity.role],
      now: capturedAt,
    });
    if ((await provider.list()).length !== 0) {
      throw operationConflict("Final recovery-point component repository is not empty.");
    }
    const created = await provider.create({
      path: capture.databasePath,
      identity: capture.identity,
    });
    snapshots.push({ provider, ref: created.ref });
  }
  return snapshots;
}

async function verifyCommittedResult(
  request: FinalRecoveryPointRequest,
  recoveryPointPath: string,
  value: unknown,
): Promise<FinalRecoveryPointResult> {
  const parsedResult = finalRecoveryPointResultSchema.safeParse(value);
  if (!parsedResult.success) {
    throw operationConflict("Committed final recovery-point result is invalid.");
  }
  let manifest: RecoveryPointManifest;
  let snapshots: RecoveryPointSqliteSnapshot[];
  let verified: Awaited<ReturnType<typeof verifyRecoveryPoint>>;
  try {
    manifest = (await readJson(recoveryPointPath, "manifest.json")) as RecoveryPointManifest;
    snapshots = await resolveCommittedSnapshots(recoveryPointPath, request.expectedAgentIds);
    verified = await verifyRecoveryPoint({
      manifest,
      snapshots,
      expectedAgentIds: request.expectedAgentIds,
    });
  } catch (error) {
    throw new FinalRecoveryPointError(
      "final-capture.verification-failed",
      "quarantine",
      "Committed final recovery point no longer verifies.",
      { cause: error },
    );
  }
  const expected = buildResult({
    request,
    recoveryPointPath,
    aggregateManifestPath: path.join(recoveryPointPath, "manifest.json"),
    manifest: verified.manifest,
    acceptance: verified.acceptance,
    snapshots,
  });
  if (!isDeepStrictEqual(parsedResult.data, expected)) {
    throw operationConflict("Committed final recovery-point result conflicts with verified bytes.");
  }
  return parsedResult.data;
}

async function resolveCommittedSnapshots(
  recoveryPointPath: string,
  expectedAgentIds: readonly string[],
): Promise<RecoveryPointSqliteSnapshot[]> {
  const repositories = [
    {
      repositoryPath: path.join(recoveryPointPath, "components", "global"),
      role: "global" as const,
    },
    ...expectedAgentIds.map((agentId) => ({
      repositoryPath: path.join(recoveryPointPath, "components", "agents", agentId),
      role: "agent" as const,
    })),
  ];
  const snapshots: RecoveryPointSqliteSnapshot[] = [];
  for (const repository of repositories) {
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath: repository.repositoryPath,
      allowedDatabaseRoles: [repository.role],
    });
    const entries = await provider.list();
    if (entries.length !== 1) {
      throw operationConflict("Committed final recovery point has an invalid component set.");
    }
    snapshots.push({ provider, ref: entries[0]!.ref });
  }
  return snapshots;
}

function buildResult(params: {
  request: FinalRecoveryPointRequest;
  recoveryPointPath: string;
  aggregateManifestPath: string;
  manifest: RecoveryPointManifest;
  acceptance: RecoveryPointAcceptance;
  snapshots: readonly RecoveryPointSqliteSnapshot[];
}): FinalRecoveryPointResult {
  return finalRecoveryPointResultSchema.parse({
    version: FINAL_RECOVERY_POINT_RESULT_VERSION,
    ok: true,
    runtimeLineage: params.request.runtimeLineage,
    handoffId: params.request.handoffId,
    sourceGeneration: params.request.sourceGeneration,
    closureEvidenceId: params.request.closure.evidenceId,
    recoveryPointPath: params.recoveryPointPath,
    aggregateManifestPath: params.aggregateManifestPath,
    recoveryPointId: params.manifest.recoveryPointId,
    acceptanceSetId: params.acceptance.acceptanceSetId,
    aggregateManifestSha256: params.acceptance.aggregateManifestSha256,
    aggregateManifestSizeBytes: params.acceptance.aggregateManifestSizeBytes,
    components: params.manifest.components.map((component, index) => ({
      componentId: component.id,
      snapshotPath: params.snapshots[index]!.ref.path,
      ownerManifestSha256: params.acceptance.components[index]!.ownerManifestSha256,
      ownerManifestSizeBytes: params.acceptance.components[index]!.ownerManifestSizeBytes,
      artifactSha256: params.acceptance.components[index]!.artifactSha256,
      artifactSizeBytes: params.acceptance.components[index]!.artifactSizeBytes,
    })),
  });
}

async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  const result = await ensureAbsoluteDirectory(directoryPath, {
    mode: PRIVATE_DIRECTORY_MODE,
    scopeLabel: "final recovery-point repository",
  });
  if (!result.ok) {
    throw result.error;
  }
  const stat = await fs.lstat(result.path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw operationConflict("Final recovery-point path is not a trusted directory.");
  }
  applyPrivateModeSync(result.path, PRIVATE_DIRECTORY_MODE);
}

async function writeCaptureRecord(filePath: string, value: unknown, label: string): Promise<void> {
  await writeCaptureBytes(filePath, Buffer.from(`${stableStringify(value)}\n`, "utf8"), label);
}

async function writeCaptureBytes(filePath: string, value: Buffer, label: string): Promise<void> {
  try {
    await writeNewBytes(filePath, value);
  } catch (error) {
    throw operationConflict(`Final recovery-point ${label} could not be committed.`, error);
  }
}

async function writeNewBytes(filePath: string, value: Buffer): Promise<void> {
  const handle = await fs.open(filePath, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectoryBestEffort(path.dirname(filePath));
}

async function readJsonIfPresent(
  rootPath: string,
  relativePath: string,
): Promise<unknown> {
  try {
    return await readJson(rootPath, relativePath);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error instanceof FsSafeError && error.code === "not-found")
    ) {
      return undefined;
    }
    throw operationConflict(`Final recovery-point ${relativePath} is unreadable.`, error);
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
  try {
    return JSON.parse(read.buffer.toString("utf8")) as unknown;
  } catch (error) {
    throw operationConflict(`Final recovery-point ${relativePath} is not valid JSON.`, error);
  }
}

function assertCanonicalTimestamp(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new FinalRecoveryPointError(
      "final-capture.request-invalid",
      "quarantine",
      "Final recovery-point capturedAt must be a canonical timestamp.",
    );
  }
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
    throw new FinalRecoveryPointError(
      "final-capture.request-invalid",
      "quarantine",
      "Final recovery-point expectedAgentIds must be unique, normalized, and sorted.",
    );
  }
}

function operationConflict(message: string, cause?: unknown): FinalRecoveryPointError {
  return new FinalRecoveryPointError(
    "final-capture.operation-conflict",
    "quarantine",
    message,
    cause === undefined ? undefined : { cause },
  );
}
