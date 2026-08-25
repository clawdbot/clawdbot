import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { stableStringify } from "@openclaw/normalization-core";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import {
  ensureDurableDirectory,
  pinDirectory,
  requireDirectorySync,
  type PinnedDirectory,
} from "../infra/directory-durability.js";
import { ensureAbsoluteDirectory, root } from "../infra/fs-safe.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import { listOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createLocalSqliteSnapshotProvider } from "./local-repository.js";
import {
  readRecoveryJournalRecord,
  resolveRecoveryJournalPath,
  writeRecoveryJournalRecord,
} from "./recovery-journal.js";
import {
  createRecoveryPointManifest,
  verifyRecoveryPoint,
  verifyRecoveryPointOwnerInventory,
  type RecoveryPointAcceptance,
  type RecoveryPointManifest,
  type RecoveryPointSqliteSnapshot,
} from "./recovery-point.js";

const recoveryPointOwnerInventoryInputSchema = z.custom<
  ReturnType<typeof verifyRecoveryPointOwnerInventory>
>((value) => {
  try {
    verifyRecoveryPointOwnerInventory(value);
    return true;
  } catch {
    return false;
  }
}, "inventory is invalid");

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
    ownerInventory: recoveryPointOwnerInventoryInputSchema,
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
  try {
    verifyRecoveryPointOwnerInventory(request.ownerInventory);
  } catch (error) {
    throw new FinalRecoveryPointError(
      "final-capture.request-invalid",
      "quarantine",
      "Final recovery-point owner inventory is invalid.",
      { cause: error },
    );
  }
  if (request.ownerInventory.sourceRuntimeGeneration !== request.sourceGeneration) {
    throw new FinalRecoveryPointError(
      "final-capture.request-invalid",
      "quarantine",
      "Final recovery-point owner inventory must match sourceGeneration.",
    );
  }
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
  const journalDirectory = path.join(resolveStateDir(), "recovery", "final-capture", operationId);
  const recoveryPointPath = path.join(request.repositoryPath, operationId);
  await prepareOperationDirectory(journalDirectory, "operation journal");
  const journalPath = resolveRecoveryJournalPath(journalDirectory);
  const existingResult = await readJournalRecord(journalPath, "result");
  const existingIntent = await readJournalRecord(journalPath, "intent");
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
  await prepareOperationDirectory(recoveryPointPath, "repository");
  const recoveryPointDirectory = await pinRecoveryPointDirectory(recoveryPointPath);
  try {
    await writeJournalRecord(journalPath, "intent", request);

    let snapshots: RecoveryPointSqliteSnapshot[];
    try {
      snapshots = await captureSqliteInventory(request, recoveryPointPath, recoveryPointDirectory);
    } catch (error) {
      if (error instanceof FinalRecoveryPointError) {
        throw error;
      }
      throw new FinalRecoveryPointError(
        "final-capture.snapshot-failed",
        "quarantine",
        "Final recovery-point SQLite capture failed after durable intent.",
        { cause: error },
      );
    }

    let manifest: RecoveryPointManifest;
    let acceptance: RecoveryPointAcceptance;
    try {
      manifest = await createRecoveryPointManifest({
        snapshots,
        ownerInventory: request.ownerInventory,
        now: () => new Date(request.capturedAt),
      });
      ({ acceptance } = await verifyRecoveryPoint({
        manifest,
        snapshots,
        ownerInventory: request.ownerInventory,
      }));
    } catch (error) {
      throw new FinalRecoveryPointError(
        "final-capture.verification-failed",
        "quarantine",
        "Final recovery-point aggregate verification failed after durable intent.",
        { cause: error },
      );
    }

    const aggregateManifestPath = path.join(recoveryPointPath, "manifest.json");
    await recoveryPointDirectory.assertCurrent();
    await writeCaptureBytes(
      aggregateManifestPath,
      Buffer.from(stableStringify(manifest), "utf8"),
      "aggregate manifest",
      recoveryPointDirectory,
    );
    const result = buildResult({
      request,
      recoveryPointPath,
      aggregateManifestPath,
      manifest,
      acceptance,
      snapshots,
    });
    await writeJournalRecord(journalPath, "result", result);
    return result;
  } finally {
    await recoveryPointDirectory.close().catch(() => undefined);
  }
}

async function captureSqliteInventory(
  request: FinalRecoveryPointRequest,
  recoveryPointPath: string,
  recoveryPointDirectory: PinnedDirectory,
): Promise<RecoveryPointSqliteSnapshot[]> {
  const capturedAt = () => new Date(request.capturedAt);
  const componentsRoot = path.join(recoveryPointPath, "components");
  const agentDatabases = resolveOwnerAgentDatabases(request);
  const captures = [
    {
      repositoryPath: path.join(componentsRoot, "global"),
      databasePath: await fs.realpath(resolveOpenClawStateSqlitePath()),
      identity: { role: "global" as const },
    },
    ...(await Promise.all(
      agentDatabases.map(async ({ agentId, path: databasePath }) => ({
        repositoryPath: path.join(componentsRoot, "agents", agentId),
        databasePath: await fs.realpath(databasePath),
        identity: { role: "agent" as const, agentId },
      })),
    )),
  ];
  const snapshots: RecoveryPointSqliteSnapshot[] = [];
  for (const capture of captures) {
    await recoveryPointDirectory.assertCurrent();
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
    await recoveryPointDirectory.assertCurrent();
    snapshots.push({ provider, ref: created.ref });
  }
  requireDirectorySync(await recoveryPointDirectory.sync(), "Final recovery-point repository");
  return snapshots;
}

function resolveOwnerAgentDatabases(request: FinalRecoveryPointRequest): Array<{
  agentId: string;
  path: string;
}> {
  const expectedAgentIds = request.ownerInventory.agentIds;
  const expected = new Set(expectedAgentIds);
  const registered = listOpenClawRegisteredAgentDatabases({
    includeIncompatibleSchemaVersions: true,
  });
  const byAgentId = new Map<string, string>();
  for (const entry of registered) {
    if (!expected.has(entry.agentId)) {
      throw operationConflict(
        `Final recovery-point inventory omitted registered agent database: ${entry.agentId}.`,
      );
    }
    if (entry.schemaVersion !== OPENCLAW_AGENT_SCHEMA_VERSION) {
      throw operationConflict(
        `Final recovery-point inventory cannot capture incompatible registered agent database: ${entry.agentId}.`,
      );
    }
    const existing = byAgentId.get(entry.agentId);
    if (existing !== undefined && existing !== entry.path) {
      throw operationConflict(
        `Final recovery-point inventory cannot represent multiple registered databases for agent: ${entry.agentId}.`,
      );
    }
    byAgentId.set(entry.agentId, entry.path);
  }
  return expectedAgentIds.map((agentId) => {
    const databasePath = byAgentId.get(agentId);
    if (!databasePath) {
      throw operationConflict(
        `Final recovery-point inventory includes unregistered agent database: ${agentId}.`,
      );
    }
    return { agentId, path: databasePath };
  });
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
  let snapshots: RecoveryPointSqliteSnapshot[];
  let verified: Awaited<ReturnType<typeof verifyRecoveryPoint>>;
  try {
    const manifestRead = await readAggregateManifest(recoveryPointPath, "manifest.json");
    if (
      manifestRead.sha256 !== parsedResult.data.aggregateManifestSha256 ||
      manifestRead.sizeBytes !== parsedResult.data.aggregateManifestSizeBytes
    ) {
      throw operationConflict("Committed final recovery-point manifest bytes changed.");
    }
    snapshots = await resolveCommittedSnapshots(recoveryPointPath, request.ownerInventory.agentIds);
    verified = await verifyRecoveryPoint({
      manifest: manifestRead.parsed,
      snapshots,
      ownerInventory: request.ownerInventory,
    });
  } catch (error) {
    if (error instanceof FinalRecoveryPointError) {
      throw error;
    }
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
  agentIds: readonly string[],
): Promise<RecoveryPointSqliteSnapshot[]> {
  const repositories = [
    {
      repositoryPath: path.join(recoveryPointPath, "components", "global"),
      role: "global" as const,
    },
    ...agentIds.map((agentId) => ({
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

async function prepareOperationDirectory(directoryPath: string, label: string): Promise<void> {
  try {
    await ensurePrivateDirectory(directoryPath);
  } catch (error) {
    if (error instanceof FinalRecoveryPointError) {
      throw error;
    }
    throw new FinalRecoveryPointError(
      "final-capture.snapshot-failed",
      "hold",
      `Final recovery-point ${label} could not be prepared.`,
      { cause: error },
    );
  }
}

async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  const receipt = await ensureDurableDirectory({
    directoryPath,
    label: "final recovery-point repository",
    create: async (targetPath) => {
      const result = await ensureAbsoluteDirectory(targetPath, {
        mode: PRIVATE_DIRECTORY_MODE,
        scopeLabel: "final recovery-point repository",
      });
      if (!result.ok) {
        throw result.error;
      }
      applyPrivateModeSync(result.path, PRIVATE_DIRECTORY_MODE);
    },
  });
  requireDirectorySync(receipt.parentSync, "final recovery-point repository");
  const stat = await fs.lstat(receipt.path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw operationConflict("Final recovery-point path is not a trusted directory.");
  }
  applyPrivateModeSync(receipt.path, PRIVATE_DIRECTORY_MODE);
}

async function pinRecoveryPointDirectory(directoryPath: string): Promise<PinnedDirectory> {
  try {
    const pinned = await pinDirectory(directoryPath, { label: "Final recovery-point repository" });
    await pinned.assertCurrent();
    requireDirectorySync(await pinned.sync(), "Final recovery-point repository");
    return pinned;
  } catch (error) {
    throw new FinalRecoveryPointError(
      "final-capture.snapshot-failed",
      "hold",
      "Final recovery-point repository could not be pinned.",
      { cause: error },
    );
  }
}

async function writeCaptureBytes(
  filePath: string,
  value: Buffer,
  label: string,
  parentDirectory: PinnedDirectory,
): Promise<void> {
  try {
    await writeNewBytes(filePath, value, parentDirectory);
  } catch (error) {
    throw operationConflict(`Final recovery-point ${label} could not be committed.`, error);
  }
}

async function writeNewBytes(
  filePath: string,
  value: Buffer,
  parentDirectory: PinnedDirectory,
): Promise<void> {
  await parentDirectory.assertCurrent();
  const handle = await fs.open(filePath, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await parentDirectory.assertCurrent();
  requireDirectorySync(await parentDirectory.sync(), "Final recovery-point repository");
}

async function readJournalRecord(databasePath: string, recordType: string): Promise<unknown> {
  try {
    return await readRecoveryJournalRecord(databasePath, recordType);
  } catch (error) {
    throw operationConflict(`Final recovery-point ${recordType} is unreadable.`, error);
  }
}

async function writeJournalRecord(
  databasePath: string,
  recordType: string,
  value: unknown,
): Promise<void> {
  try {
    await writeRecoveryJournalRecord(databasePath, recordType, value);
  } catch (error) {
    throw operationConflict(`Final recovery-point ${recordType} could not be committed.`, error);
  }
}

async function readAggregateManifest(
  rootPath: string,
  relativePath: string,
): Promise<{ parsed: unknown; sha256: string; sizeBytes: number }> {
  const read = await (
    await root(rootPath)
  ).read(relativePath, {
    hardlinks: "reject",
    maxBytes: MAX_RECORD_BYTES,
    symlinks: "reject",
  });
  try {
    return {
      parsed: JSON.parse(read.buffer.toString("utf8")) as unknown,
      sha256: sha256Hex(read.buffer),
      sizeBytes: read.buffer.byteLength,
    };
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

function operationConflict(message: string, cause?: unknown): FinalRecoveryPointError {
  return new FinalRecoveryPointError(
    "final-capture.operation-conflict",
    "quarantine",
    message,
    cause === undefined ? undefined : { cause },
  );
}
