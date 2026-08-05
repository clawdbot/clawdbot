// Receipt-backed guarded replacement for one already-installed archive plugin.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { encodePluginInstallDirName } from "../plugins/install-paths.js";
import { installPluginFromArchive } from "../plugins/install.js";
import { hashJson } from "../plugins/installed-plugin-index-hash.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { resolveInstalledPluginIndexStateDatabaseOptions } from "../plugins/installed-plugin-index-store-path.js";
import { compareAndSwapPersistedInstalledPluginIndexInstallRecord } from "../plugins/installed-plugin-index-store.js";
import { buildGuardedReplaceInstallRecord } from "../plugins/installed-plugin-index.js";
import {
  acquirePluginLifecycleLease,
  PluginLifecycleLeaseUnavailableError,
} from "../plugins/plugin-lifecycle-lease.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveUserPath } from "../utils.js";
import type { FileLockHandle } from "./file-lock.js";
import { pathExists } from "./fs-safe.js";
import { resolveCanonicalInstallTarget } from "./install-target.js";
import { resolveOpenClawPackageRootSync } from "./openclaw-root.js";
import { movePathWithCopyFallback, replaceFileAtomic } from "./replace-file.js";

const RECEIPT_SCHEMA_VERSION = "openclaw.plugins.replace-guarded.v1" as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const TRUST_ANCHOR_PLUGIN_ID = "openclaw-core";
const TRUST_ANCHOR_NAMESPACE = "guarded-plugin-replace";

export const GUARDED_REPLACE_FAILURE_CODE = {
  INVALID_INPUT: "guarded_replace_invalid_input",
  IDENTITY_MISMATCH: "guarded_replace_identity_mismatch",
  TARGET_NOT_INSTALLED: "guarded_replace_target_not_installed",
  INSTALLED_STATE_MISMATCH: "guarded_replace_installed_state_mismatch",
  RECEIPT_RESERVATION_FAILED: "guarded_replace_receipt_reservation_failed",
  LEASE_UNAVAILABLE: "guarded_replace_lease_unavailable",
  STAGING_FAILED: "guarded_replace_staging_failed",
  GUARD_FAILED: "guarded_replace_guard_failed",
  PREDECESSOR_CAPTURE_FAILED: "guarded_replace_predecessor_capture_failed",
  SWAP_FAILED: "guarded_replace_swap_failed",
  STATE_FINALIZE_FAILED: "guarded_replace_state_finalize_failed",
  RECEIPT_FINALIZE_FAILED: "guarded_replace_receipt_finalize_failed",
  RECOVERY_INCOMPLETE: "guarded_replace_recovery_incomplete",
  FAULT_INJECTED: "guarded_replace_fault_injected",
} as const;

export type GuardedReplaceFailureCode =
  (typeof GUARDED_REPLACE_FAILURE_CODE)[keyof typeof GUARDED_REPLACE_FAILURE_CODE];

export class GuardedReplaceError extends Error {
  constructor(
    readonly code: GuardedReplaceFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GuardedReplaceError";
  }
}

type GuardOutcome = {
  name: "manifest" | "package" | "policy" | "security_scan" | "installed_state";
  outcome: "PASS" | "FAIL";
  evidence: Record<string, unknown>;
};

export type GuardedReplaceStageName =
  | "IDENTITY_VERIFIED"
  | "RECEIPT_RESERVED"
  | "LEASE_HELD"
  | "STAGED"
  | "GUARDS_RAN"
  | "PREDECESSOR_CAPTURED"
  | "SWAP_PUBLISHED"
  | "STATE_FINALIZED"
  | "RECEIPT_FINALIZED";

type ReceiptOutcome = "SUCCESS" | "ROLLED_BACK" | "ABORTED" | "INCOMPLETE";
type ReceiptStatus = "RESERVED" | "ACTIVE" | "COMPLETED" | "ROLLED_BACK" | "ABORTED" | "INCOMPLETE";

type GuardedReplaceTrustAnchor = {
  schemaVersion: 1;
  transactionId: string;
  receiptPath: string;
  pluginId: string;
  leaseId: string;
  canonicalTarget: string;
  transactionRoot: string;
  predecessorBackup: string;
  predecessorPayloadSha256: string;
  candidateArchivePath: string;
  candidateArchiveSha256: string;
  rollbackArchivePath: string;
  rollbackArchiveSha256: string;
  previousRecord: PluginInstallRecord;
  previousRecordSha256: string;
  candidateRecord: PluginInstallRecord | null;
  candidateRecordSha256: string | null;
  stagedPayloadSha256: string | null;
  createdAtMs: number;
};

export type GuardedReplaceReceipt = {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  transactionId: string;
  leaseId: string;
  pluginId: string;
  status: ReceiptStatus;
  canonicalTarget: {
    realPath: string;
    boundaryLabel: "extensions directory";
    nameEncoder: "encodePluginInstallDirName";
  };
  predecessor: {
    payloadSha256: string;
    capturedBackup: string;
    capturedAtMs: number | null;
  };
  candidate: {
    archivePath: string;
    archiveSha256: string;
    stagedPayloadSha256: string | null;
    manifest: { id: string; name?: string; version?: string } | null;
  };
  rollback: { archivePath: string; archiveSha256: string };
  installedIndex: {
    previousRecordSha256: string;
    candidateRecordSha256: string | null;
  };
  transactionRoot: string;
  stages: Array<{ name: GuardedReplaceStageName; atMs: number; evidence: Record<string, unknown> }>;
  guards: GuardOutcome[];
  finalInstalledSha256: string | null;
  outcome: ReceiptOutcome | null;
  failure_code: GuardedReplaceFailureCode | null;
  failure_message: string | null;
  recovery_status: "RESUMABLE" | "FINALIZED" | "REQUIRES_OPERATOR";
};

export type GuardedReplaceFault =
  | "before-swap"
  | "after-swap"
  | "after-state-finalize"
  | "cleanup-failure"
  | "after-lease-release";

export type InstallGuardedReplaceParams = {
  candidateArchive: string;
  candidateSha256: string;
  expectedPredecessorSha256: string;
  pluginId: string;
  receiptPath: string;
  rollbackArchive: string;
  rollbackSha256: string;
  config: OpenClawConfig;
  extensionsDir: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  fault?: GuardedReplaceFault;
  now?: () => number;
  createId?: (nowMs: number) => string;
};

export type ReconcileGuardedReplaceParams = {
  receiptPath: string;
  extensionsDir: string;
  config: OpenClawConfig;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

const ReceiptSchema = z.object({
  schemaVersion: z.literal(RECEIPT_SCHEMA_VERSION),
  transactionId: z.string().regex(UUID_PATTERN),
  leaseId: z.string().regex(UUID_PATTERN),
  pluginId: z.string().min(1),
  status: z.enum(["RESERVED", "ACTIVE", "COMPLETED", "ROLLED_BACK", "ABORTED", "INCOMPLETE"]),
  canonicalTarget: z.object({
    realPath: z.string().min(1),
    boundaryLabel: z.literal("extensions directory"),
    nameEncoder: z.literal("encodePluginInstallDirName"),
  }),
  predecessor: z.object({
    payloadSha256: z.string().regex(SHA256_PATTERN),
    capturedBackup: z.string().min(1),
    capturedAtMs: z.number().nullable(),
  }),
  candidate: z.object({
    archivePath: z.string().min(1),
    archiveSha256: z.string().regex(SHA256_PATTERN),
    stagedPayloadSha256: z.string().regex(SHA256_PATTERN).nullable(),
    manifest: z
      .object({ id: z.string(), name: z.string().optional(), version: z.string().optional() })
      .nullable(),
  }),
  rollback: z.object({
    archivePath: z.string().min(1),
    archiveSha256: z.string().regex(SHA256_PATTERN),
  }),
  installedIndex: z.object({
    previousRecordSha256: z.string().regex(SHA256_PATTERN),
    candidateRecordSha256: z.string().regex(SHA256_PATTERN).nullable(),
  }),
  transactionRoot: z.string().min(1),
  stages: z.array(
    z.object({ name: z.string(), atMs: z.number(), evidence: z.record(z.string(), z.unknown()) }),
  ),
  guards: z.array(
    z.object({
      name: z.enum(["manifest", "package", "policy", "security_scan", "installed_state"]),
      outcome: z.enum(["PASS", "FAIL"]),
      evidence: z.record(z.string(), z.unknown()),
    }),
  ),
  finalInstalledSha256: z.string().regex(SHA256_PATTERN).nullable(),
  outcome: z.enum(["SUCCESS", "ROLLED_BACK", "ABORTED", "INCOMPLETE"]).nullable(),
  failure_code: z.string().nullable(),
  failure_message: z.string().nullable(),
  recovery_status: z.enum(["RESUMABLE", "FINALIZED", "REQUIRES_OPERATOR"]),
});

const TrustAnchorInstallRecordSchema = z
  .record(z.string(), z.unknown())
  .refine((record) => typeof record.source === "string");
const TrustAnchorSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: z.string().regex(UUID_PATTERN),
  receiptPath: z.string().min(1),
  pluginId: z.string().min(1),
  leaseId: z.string().regex(UUID_PATTERN),
  canonicalTarget: z.string().min(1),
  transactionRoot: z.string().min(1),
  predecessorBackup: z.string().min(1),
  predecessorPayloadSha256: z.string().regex(SHA256_PATTERN),
  candidateArchivePath: z.string().min(1),
  candidateArchiveSha256: z.string().regex(SHA256_PATTERN),
  rollbackArchivePath: z.string().min(1),
  rollbackArchiveSha256: z.string().regex(SHA256_PATTERN),
  previousRecord: TrustAnchorInstallRecordSchema,
  previousRecordSha256: z.string().regex(SHA256_PATTERN),
  candidateRecord: TrustAnchorInstallRecordSchema.nullable(),
  candidateRecordSha256: z.string().regex(SHA256_PATTERN).nullable(),
  stagedPayloadSha256: z.string().regex(SHA256_PATTERN).nullable(),
  createdAtMs: z.number(),
});

function guardedError(code: GuardedReplaceFailureCode, message: string, cause?: unknown) {
  return new GuardedReplaceError(code, message, cause === undefined ? undefined : { cause });
}

function assertSha256(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.INVALID_INPUT,
      `${label} must be lowercase SHA-256 hex`,
    );
  }
  return value;
}

function createUuidV7(nowMs: number): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Math.max(0, Math.trunc(nowMs)));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function hashFile(filePath: string): Promise<string> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("not a regular file");
    }
    return createHash("sha256")
      .update(await fs.readFile(filePath))
      .digest("hex");
  } catch (error) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.INVALID_INPUT,
      "archive must exist as a regular file",
      error,
    );
  }
}

function isPathWithinBoundary(candidate: string, boundary: string): boolean {
  const relative = path.relative(boundary, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function resolveGuardedPayloadRoot(params: {
  rootDir: string;
  boundaryDir?: string;
}): Promise<string> {
  const rootPath = path.resolve(params.rootDir);
  const stat = await fs.lstat(rootPath).catch((error) => {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.GUARD_FAILED,
      "payload root is missing or unreadable",
      error,
    );
  });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.GUARD_FAILED,
      "payload root must be a real directory",
    );
  }
  const root = await fs.realpath(rootPath);
  if (params.boundaryDir) {
    const boundary = await fs.realpath(params.boundaryDir);
    if (!isPathWithinBoundary(root, boundary)) {
      throw guardedError(
        GUARDED_REPLACE_FAILURE_CODE.GUARD_FAILED,
        "payload root escapes the managed extensions directory",
      );
    }
  }
  return root;
}

async function isValidOpenClawHostPeerLink(params: {
  root: string;
  entryPath: string;
  relative: string;
}): Promise<boolean> {
  if (params.relative !== "node_modules/openclaw") {
    return false;
  }
  const packageJson = JSON.parse(
    await fs.readFile(path.join(params.root, "package.json"), "utf8"),
  ) as { peerDependencies?: Record<string, unknown> };
  if (typeof packageJson.peerDependencies?.openclaw !== "string") {
    return false;
  }
  const hostRoot = resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
    cwd: process.cwd(),
  });
  if (!hostRoot) {
    return false;
  }
  const [actualTarget, expectedTarget] = await Promise.all([
    fs.realpath(params.entryPath).catch(() => ""),
    fs.realpath(hostRoot).catch(() => path.resolve(hostRoot)),
  ]);
  return actualTarget !== "" && actualTarget === expectedTarget;
}

/** Deterministically hashes names, kinds, safe link identities, and file bytes in one plugin tree. */
export async function hashGuardedPluginPayload(
  rootDir: string,
  options: { boundaryDir?: string } = {},
): Promise<string> {
  const root = await resolveGuardedPayloadRoot({ rootDir, boundaryDir: options.boundaryDir });
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(root, entryPath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        await visit(entryPath);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(await fs.readFile(entryPath));
        hash.update("\0");
      } else if (entry.isSymbolicLink()) {
        const target = await fs.readlink(entryPath);
        if (await isValidOpenClawHostPeerLink({ root, entryPath, relative })) {
          hash.update(`l\0${relative}\0@openclaw-host-peer\0`);
          continue;
        }
        if (path.isAbsolute(target)) {
          throw guardedError(
            GUARDED_REPLACE_FAILURE_CODE.GUARD_FAILED,
            "absolute payload symlink rejected",
          );
        }
        const resolvedTarget = path.resolve(path.dirname(entryPath), target);
        if (!isPathWithinBoundary(resolvedTarget, root)) {
          throw guardedError(
            GUARDED_REPLACE_FAILURE_CODE.GUARD_FAILED,
            "payload symlink escapes the payload root",
          );
        }
        hash.update(`l\0${relative}\0${target}\0`);
      } else {
        throw guardedError(
          GUARDED_REPLACE_FAILURE_CODE.GUARD_FAILED,
          "unsupported payload entry rejected",
        );
      }
    }
  };
  await visit(root);
  return hash.digest("hex");
}

function receiptText(receipt: GuardedReplaceReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some supported filesystems.
  } finally {
    await handle.close();
  }
}

async function reserveReceipt(receiptPath: string, receipt: GuardedReplaceReceipt): Promise<void> {
  const parent = path.dirname(receiptPath);
  const parentStat = await fs.stat(parent).catch(() => null);
  if (!parentStat?.isDirectory()) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.RECEIPT_RESERVATION_FAILED,
      "receipt parent directory must already exist",
    );
  }
  try {
    const handle = await fs.open(receiptPath, "wx", 0o600);
    try {
      await handle.writeFile(receiptText(receipt), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(parent);
  } catch (error) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.RECEIPT_RESERVATION_FAILED,
      "create-only receipt reservation failed",
      error,
    );
  }
}

async function persistReceipt(receiptPath: string, receipt: GuardedReplaceReceipt): Promise<void> {
  await replaceFileAtomic({
    filePath: receiptPath,
    content: receiptText(receipt),
    mode: 0o600,
    syncTempFile: true,
    syncParentDir: true,
  });
}

function appendStage(
  receipt: GuardedReplaceReceipt,
  name: GuardedReplaceStageName,
  now: () => number,
  evidence: Record<string, unknown> = {},
): void {
  receipt.stages.push({ name, atMs: now(), evidence });
}

function recordHash(record: PluginInstallRecord | undefined): string {
  return hashJson(record ?? null);
}

function stateOptions(params: { stateDir?: string; env?: NodeJS.ProcessEnv }) {
  return {
    ...(params.stateDir ? { stateDir: params.stateDir } : {}),
    ...(params.env ? { env: params.env } : {}),
  };
}

function stateDatabaseOptions(params: { stateDir?: string; env?: NodeJS.ProcessEnv }) {
  return resolveInstalledPluginIndexStateDatabaseOptions(stateOptions(params));
}

function parseTrustAnchor(raw: string): GuardedReplaceTrustAnchor {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.RECOVERY_INCOMPLETE,
      "guarded replacement trust anchor is corrupt",
      error,
    );
  }
  const parsed = TrustAnchorSchema.safeParse(value);
  if (!parsed.success) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.RECOVERY_INCOMPLETE,
      "guarded replacement trust anchor is invalid",
    );
  }
  return parsed.data as GuardedReplaceTrustAnchor;
}

function reserveTrustAnchor(
  anchor: GuardedReplaceTrustAnchor,
  params: { stateDir?: string; env?: NodeJS.ProcessEnv },
): void {
  const inserted = runOpenClawStateWriteTransaction(({ db }) => {
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO plugin_state_entries
           (plugin_id, namespace, entry_key, value_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        TRUST_ANCHOR_PLUGIN_ID,
        TRUST_ANCHOR_NAMESPACE,
        anchor.transactionId,
        JSON.stringify(anchor),
        anchor.createdAtMs,
      );
    return Number(result.changes) === 1;
  }, stateDatabaseOptions(params));
  if (!inserted) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.RECEIPT_RESERVATION_FAILED,
      "create-only guarded replacement trust anchor reservation failed",
    );
  }
}

function updateTrustAnchor(
  anchor: GuardedReplaceTrustAnchor,
  expectedPreviousHash: string,
  params: { stateDir?: string; env?: NodeJS.ProcessEnv },
): void {
  const changed = runOpenClawStateWriteTransaction(({ db }) => {
    const row = db
      .prepare(
        `SELECT value_json FROM plugin_state_entries
         WHERE plugin_id = ? AND namespace = ? AND entry_key = ?`,
      )
      .get(TRUST_ANCHOR_PLUGIN_ID, TRUST_ANCHOR_NAMESPACE, anchor.transactionId) as
      | { value_json: string }
      | undefined;
    if (!row || hashJson(parseTrustAnchor(row.value_json)) !== expectedPreviousHash) {
      return false;
    }
    const result = db
      .prepare(
        `UPDATE plugin_state_entries SET value_json = ?
         WHERE plugin_id = ? AND namespace = ? AND entry_key = ?`,
      )
      .run(
        JSON.stringify(anchor),
        TRUST_ANCHOR_PLUGIN_ID,
        TRUST_ANCHOR_NAMESPACE,
        anchor.transactionId,
      );
    return Number(result.changes) === 1;
  }, stateDatabaseOptions(params));
  if (!changed) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.STATE_FINALIZE_FAILED,
      "guarded replacement trust anchor compare-and-swap failed",
    );
  }
}

function loadTrustAnchor(
  transactionId: string,
  params: { stateDir?: string; env?: NodeJS.ProcessEnv },
): GuardedReplaceTrustAnchor {
  const { db } = openOpenClawStateDatabase(stateDatabaseOptions(params));
  const row = db
    .prepare(
      `SELECT value_json FROM plugin_state_entries
       WHERE plugin_id = ? AND namespace = ? AND entry_key = ?`,
    )
    .get(TRUST_ANCHOR_PLUGIN_ID, TRUST_ANCHOR_NAMESPACE, transactionId) as
    | { value_json: string }
    | undefined;
  if (!row) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.RECOVERY_INCOMPLETE,
      "guarded replacement trust anchor is missing",
    );
  }
  return parseTrustAnchor(row.value_json);
}

async function loadInstallRecords(params: { stateDir?: string; env?: NodeJS.ProcessEnv }) {
  return await loadInstalledPluginIndexInstallRecords(stateOptions(params));
}

async function compareAndSwapInstallRecord(params: {
  pluginId: string;
  expectedRecordSha256: string;
  nextRecord: PluginInstallRecord;
  config: OpenClawConfig;
  extensionsDir: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const committed = await compareAndSwapPersistedInstalledPluginIndexInstallRecord({
    ...stateOptions(params),
    pluginId: params.pluginId,
    expectedRecordSha256: params.expectedRecordSha256,
    nextRecord: params.nextRecord,
    config: params.config,
  });
  if (!committed) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.STATE_FINALIZE_FAILED,
      "installed plugin index compare-and-swap rejected stale state",
    );
  }
}

function assertExpectedHash(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw guardedError(GUARDED_REPLACE_FAILURE_CODE.IDENTITY_MISMATCH, `${label} SHA-256 mismatch`);
  }
}

async function acquireLifecycleLease(
  extensionsDir: string,
  _pluginId: string,
): Promise<FileLockHandle> {
  try {
    return await acquirePluginLifecycleLease(extensionsDir);
  } catch (error) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.LEASE_UNAVAILABLE,
      "exclusive plugin lifecycle lease unavailable",
      error instanceof PluginLifecycleLeaseUnavailableError ? error : undefined,
    );
  }
}

function injectFault(actual: GuardedReplaceFault | undefined, expected: GuardedReplaceFault): void {
  if (actual === expected) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.FAULT_INJECTED,
      `fault injected at ${expected}`,
    );
  }
}

async function readReceipt(receiptPath: string): Promise<GuardedReplaceReceipt> {
  const stat = await fs.lstat(receiptPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.INVALID_INPUT,
      "receipt must be a regular file",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  } catch (error) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.INVALID_INPUT,
      "receipt is not valid JSON",
      error,
    );
  }
  const result = ReceiptSchema.safeParse(parsed);
  if (!result.success) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.INVALID_INPUT,
      "receipt schema validation failed",
    );
  }
  return result.data as GuardedReplaceReceipt;
}

async function resolveBoundTarget(params: {
  extensionsDir: string;
  pluginId: string;
}): Promise<{ extensionsRealPath: string; targetDir: string }> {
  const extensionsRealPath = await fs.realpath(params.extensionsDir).catch(() => "");
  if (!extensionsRealPath) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.TARGET_NOT_INSTALLED,
      "extensions directory missing",
    );
  }
  const target = await resolveCanonicalInstallTarget({
    baseDir: extensionsRealPath,
    id: params.pluginId,
    invalidNameMessage: "invalid plugin name: path traversal detected",
    boundaryLabel: "extensions directory",
    nameEncoder: encodePluginInstallDirName,
  });
  if (!target.ok) {
    throw guardedError(GUARDED_REPLACE_FAILURE_CODE.INVALID_INPUT, target.error);
  }
  if (!(await pathExists(target.targetDir))) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.TARGET_NOT_INSTALLED,
      "plugin target is not installed",
    );
  }
  const targetStat = await fs.lstat(target.targetDir);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.TARGET_NOT_INSTALLED,
      "plugin target is not a directory",
    );
  }
  return { extensionsRealPath, targetDir: target.targetDir };
}

function plannedTransactionRoot(extensionsDir: string, transactionId: string): string {
  return path.join(extensionsDir, `.openclaw-guarded-replace-${transactionId}`);
}

async function cleanupTransactionRoot(receipt: GuardedReplaceReceipt): Promise<void> {
  await fs.rm(receipt.transactionRoot, { recursive: true, force: true });
}

async function restorePredecessor(
  receipt: GuardedReplaceReceipt,
  extensionsRealPath: string,
): Promise<boolean> {
  const target = receipt.canonicalTarget.realPath;
  const backup = receipt.predecessor.capturedBackup;
  const backupExists = await pathExists(backup);
  const targetExists = await pathExists(target);
  if (!backupExists) {
    return (
      targetExists &&
      (await hashGuardedPluginPayload(target, { boundaryDir: extensionsRealPath })) ===
        receipt.predecessor.payloadSha256
    );
  }
  assertExpectedHash(
    await hashGuardedPluginPayload(backup, { boundaryDir: extensionsRealPath }),
    receipt.predecessor.payloadSha256,
    "captured predecessor",
  );
  if (targetExists) {
    const targetHash = await hashGuardedPluginPayload(target, {
      boundaryDir: extensionsRealPath,
    });
    if (targetHash === receipt.predecessor.payloadSha256) {
      await fs.rm(backup, { recursive: true, force: true });
      return true;
    }
    if (targetHash !== receipt.candidate.stagedPayloadSha256) {
      return false;
    }
    await fs.rm(target, { recursive: true, force: true });
  }
  await movePathWithCopyFallback({ from: backup, to: target, sourceHardlinks: "reject" });
  return (
    (await hashGuardedPluginPayload(target, { boundaryDir: extensionsRealPath })) ===
    receipt.predecessor.payloadSha256
  );
}

async function finalizeFailure(params: {
  receipt: GuardedReplaceReceipt;
  receiptPath: string;
  code: GuardedReplaceFailureCode;
  now: () => number;
  incomplete: boolean;
}): Promise<void> {
  params.receipt.status = params.incomplete ? "INCOMPLETE" : "ROLLED_BACK";
  params.receipt.outcome = params.incomplete ? "INCOMPLETE" : "ROLLED_BACK";
  params.receipt.failure_code = params.code;
  params.receipt.failure_message = params.incomplete
    ? "automatic recovery could not prove a safe predecessor and index state"
    : "guarded replacement rolled back before completion";
  params.receipt.recovery_status = params.incomplete ? "REQUIRES_OPERATOR" : "FINALIZED";
  appendStage(params.receipt, "RECEIPT_FINALIZED", params.now, {
    outcome: params.receipt.outcome,
  });
  await persistReceipt(params.receiptPath, params.receipt);
}

/** Runs the bounded guarded archive replacement transaction. */
export async function installGuardedReplace(
  params: InstallGuardedReplaceParams,
): Promise<GuardedReplaceReceipt> {
  const now = params.now ?? Date.now;
  const createId = params.createId ?? createUuidV7;
  const candidateSha256 = assertSha256(params.candidateSha256, "candidate identity");
  const predecessorSha256 = assertSha256(params.expectedPredecessorSha256, "predecessor identity");
  const rollbackSha256 = assertSha256(params.rollbackSha256, "rollback identity");
  const candidatePath = resolveUserPath(params.candidateArchive);
  const rollbackPath = resolveUserPath(params.rollbackArchive);
  const receiptPath = path.resolve(resolveUserPath(params.receiptPath));
  assertExpectedHash(await hashFile(candidatePath), candidateSha256, "candidate archive");
  assertExpectedHash(await hashFile(rollbackPath), rollbackSha256, "rollback archive");

  const { extensionsRealPath, targetDir } = await resolveBoundTarget(params);
  assertExpectedHash(
    await hashGuardedPluginPayload(targetDir, { boundaryDir: extensionsRealPath }),
    predecessorSha256,
    "installed predecessor",
  );
  const previousRecords = await loadInstallRecords(params);
  const previousRecord = previousRecords[params.pluginId];
  const previousInstallRealPath = previousRecord?.installPath
    ? await fs.realpath(resolveUserPath(previousRecord.installPath)).catch(() => null)
    : null;
  if (
    !previousRecord ||
    previousRecord.source !== "archive" ||
    !previousInstallRealPath ||
    path.resolve(previousInstallRealPath) !== path.resolve(targetDir)
  ) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.INSTALLED_STATE_MISMATCH,
      "guarded replacement requires a tracked local-archive install at the canonical target",
    );
  }

  const transactionId = createId(now());
  const leaseId = createId(now());
  if (!UUID_PATTERN.test(transactionId) || !UUID_PATTERN.test(leaseId)) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.INVALID_INPUT,
      "transaction ids must be UUIDv7",
    );
  }
  const transactionRoot = plannedTransactionRoot(extensionsRealPath, transactionId);
  const backupDir = path.join(transactionRoot, "predecessor");
  const stagingExtensionsDir = path.join(transactionRoot, "staged");
  const receipt: GuardedReplaceReceipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    transactionId,
    leaseId,
    pluginId: params.pluginId,
    status: "RESERVED",
    canonicalTarget: {
      realPath: targetDir,
      boundaryLabel: "extensions directory",
      nameEncoder: "encodePluginInstallDirName",
    },
    predecessor: {
      payloadSha256: predecessorSha256,
      capturedBackup: backupDir,
      capturedAtMs: null,
    },
    candidate: {
      archivePath: candidatePath,
      archiveSha256: candidateSha256,
      stagedPayloadSha256: null,
      manifest: null,
    },
    rollback: { archivePath: rollbackPath, archiveSha256: rollbackSha256 },
    installedIndex: {
      previousRecordSha256: recordHash(previousRecord),
      candidateRecordSha256: null,
    },
    transactionRoot,
    stages: [],
    guards: [],
    finalInstalledSha256: null,
    outcome: null,
    failure_code: null,
    failure_message: null,
    recovery_status: "RESUMABLE",
  };
  let trustAnchor: GuardedReplaceTrustAnchor = {
    schemaVersion: 1,
    transactionId,
    receiptPath,
    pluginId: params.pluginId,
    leaseId,
    canonicalTarget: targetDir,
    transactionRoot,
    predecessorBackup: backupDir,
    predecessorPayloadSha256: predecessorSha256,
    candidateArchivePath: candidatePath,
    candidateArchiveSha256: candidateSha256,
    rollbackArchivePath: rollbackPath,
    rollbackArchiveSha256: rollbackSha256,
    previousRecord,
    previousRecordSha256: recordHash(previousRecord),
    candidateRecord: null,
    candidateRecordSha256: null,
    stagedPayloadSha256: null,
    createdAtMs: now(),
  };
  appendStage(receipt, "IDENTITY_VERIFIED", now, {
    candidateArchiveSha256: candidateSha256,
    predecessorPayloadSha256: predecessorSha256,
    rollbackArchiveSha256: rollbackSha256,
  });
  reserveTrustAnchor(trustAnchor, params);
  await reserveReceipt(receiptPath, receipt);
  appendStage(receipt, "RECEIPT_RESERVED", now, { createOnly: true });
  await persistReceipt(receiptPath, receipt);

  let lease: FileLockHandle | null = null;
  let stateCommitted = false;
  let receiptFinalized = false;
  let candidateRecord: PluginInstallRecord | undefined;
  try {
    lease = await acquireLifecycleLease(extensionsRealPath, params.pluginId);
    receipt.status = "ACTIVE";
    appendStage(receipt, "LEASE_HELD", now, { leaseId });
    await persistReceipt(receiptPath, receipt);

    await fs.mkdir(stagingExtensionsDir, { recursive: true, mode: 0o700 });
    const staged = await installPluginFromArchive({
      archivePath: candidatePath,
      config: params.config,
      expectedPluginId: params.pluginId,
      extensionsDir: stagingExtensionsDir,
      mode: "install",
      timeoutMs: params.timeoutMs,
    });
    if (!staged.ok) {
      throw guardedError(
        staged.code
          ? GUARDED_REPLACE_FAILURE_CODE.GUARD_FAILED
          : GUARDED_REPLACE_FAILURE_CODE.STAGING_FAILED,
        staged.error,
      );
    }
    const expectedStagedTarget = path.join(
      stagingExtensionsDir,
      encodePluginInstallDirName(params.pluginId),
    );
    if (path.resolve(staged.targetDir) !== path.resolve(expectedStagedTarget)) {
      throw guardedError(
        GUARDED_REPLACE_FAILURE_CODE.GUARD_FAILED,
        "staged target identity drifted",
      );
    }
    const stagedPayloadSha256 = await hashGuardedPluginPayload(staged.targetDir, {
      boundaryDir: extensionsRealPath,
    });
    receipt.candidate.stagedPayloadSha256 = stagedPayloadSha256;
    receipt.candidate.manifest = {
      id: staged.pluginId,
      ...(staged.manifestName ? { name: staged.manifestName } : {}),
      ...(staged.version ? { version: staged.version } : {}),
    };
    candidateRecord = buildGuardedReplaceInstallRecord({
      previous: previousRecord,
      candidateArchivePath: candidatePath,
      targetDir,
      version: staged.version,
      installedAt: new Date(now()).toISOString(),
    });
    receipt.installedIndex.candidateRecordSha256 = recordHash(candidateRecord);
    const previousAnchorHash = hashJson(trustAnchor);
    trustAnchor = {
      ...trustAnchor,
      candidateRecord,
      candidateRecordSha256: receipt.installedIndex.candidateRecordSha256,
      stagedPayloadSha256,
    };
    // The independently persisted anchor becomes authoritative before any
    // predecessor or target mutation can occur.
    updateTrustAnchor(trustAnchor, previousAnchorHash, params);
    appendStage(receipt, "STAGED", now, { stagedPayloadSha256 });
    receipt.guards = [
      { name: "manifest", outcome: "PASS", evidence: { pluginId: staged.pluginId } },
      { name: "package", outcome: "PASS", evidence: { version: staged.version ?? null } },
      { name: "policy", outcome: "PASS", evidence: { mode: "update" } },
      { name: "security_scan", outcome: "PASS", evidence: { source: "archive" } },
      { name: "installed_state", outcome: "PASS", evidence: { source: "archive" } },
    ];
    appendStage(receipt, "GUARDS_RAN", now, { outcome: "PASS" });
    await persistReceipt(receiptPath, receipt);

    assertExpectedHash(await hashFile(candidatePath), candidateSha256, "candidate archive");
    assertExpectedHash(await hashFile(rollbackPath), rollbackSha256, "rollback archive");
    assertExpectedHash(
      await hashGuardedPluginPayload(targetDir, { boundaryDir: extensionsRealPath }),
      predecessorSha256,
      "installed predecessor",
    );
    injectFault(params.fault, "before-swap");

    await movePathWithCopyFallback({
      from: targetDir,
      to: backupDir,
      sourceHardlinks: "reject",
    }).catch((error) => {
      throw guardedError(
        GUARDED_REPLACE_FAILURE_CODE.PREDECESSOR_CAPTURE_FAILED,
        "failed to capture recoverable predecessor",
        error,
      );
    });
    assertExpectedHash(
      await hashGuardedPluginPayload(backupDir, { boundaryDir: extensionsRealPath }),
      predecessorSha256,
      "captured predecessor",
    );
    receipt.predecessor.capturedAtMs = now();
    appendStage(receipt, "PREDECESSOR_CAPTURED", now, { payloadSha256: predecessorSha256 });
    await persistReceipt(receiptPath, receipt);

    await movePathWithCopyFallback({
      from: staged.targetDir,
      to: targetDir,
      sourceHardlinks: "reject",
    }).catch((error) => {
      throw guardedError(GUARDED_REPLACE_FAILURE_CODE.SWAP_FAILED, "candidate swap failed", error);
    });
    const finalInstalledSha256 = await hashGuardedPluginPayload(targetDir, {
      boundaryDir: extensionsRealPath,
    });
    assertExpectedHash(finalInstalledSha256, stagedPayloadSha256, "published candidate");
    receipt.finalInstalledSha256 = finalInstalledSha256;
    appendStage(receipt, "SWAP_PUBLISHED", now, { finalInstalledSha256 });
    await persistReceipt(receiptPath, receipt);
    injectFault(params.fault, "after-swap");

    await compareAndSwapInstallRecord({
      ...params,
      expectedRecordSha256: trustAnchor.previousRecordSha256,
      nextRecord: candidateRecord,
    }).catch((error) => {
      throw guardedError(
        GUARDED_REPLACE_FAILURE_CODE.STATE_FINALIZE_FAILED,
        "installed plugin index transaction failed",
        error,
      );
    });
    stateCommitted = true;
    injectFault(params.fault, "after-state-finalize");

    appendStage(receipt, "STATE_FINALIZED", now, {
      installRecordSha256: receipt.installedIndex.candidateRecordSha256,
    });
    receipt.status = "COMPLETED";
    receipt.outcome = "SUCCESS";
    receipt.recovery_status = "FINALIZED";
    appendStage(receipt, "RECEIPT_FINALIZED", now, { outcome: "SUCCESS" });
    await persistReceipt(receiptPath, receipt).catch((error) => {
      throw guardedError(
        GUARDED_REPLACE_FAILURE_CODE.RECEIPT_FINALIZE_FAILED,
        "receipt finalization failed after state commit",
        error,
      );
    });
    receiptFinalized = true;
    if (params.fault === "cleanup-failure") {
      throw guardedError(
        GUARDED_REPLACE_FAILURE_CODE.GUARD_FAILED,
        "post-finalization cleanup failure injected",
      );
    }
    await cleanupTransactionRoot(receipt);
    await lease.release();
    lease = null;
    injectFault(params.fault, "after-lease-release");
    return receipt;
  } catch (error) {
    const failure =
      error instanceof GuardedReplaceError
        ? error
        : guardedError(
            GUARDED_REPLACE_FAILURE_CODE.GUARD_FAILED,
            "guarded replacement failed",
            error,
          );
    // A durable success receipt is the transaction commit point. Cleanup and
    // lease-release errors after it must never enter rollback compensation.
    if (receiptFinalized) {
      throw failure;
    }
    // Fault injection models abrupt process loss: leave the receipt and planned
    // recovery artifacts exactly at that boundary for the reconciler.
    if (
      failure.code === GUARDED_REPLACE_FAILURE_CODE.FAULT_INJECTED ||
      (stateCommitted && failure.code === GUARDED_REPLACE_FAILURE_CODE.RECEIPT_FINALIZE_FAILED)
    ) {
      throw failure;
    }
    // Once state commit succeeded and the physical lease was released, no
    // subsequent error may relabel the durable success receipt as an abort.
    if (!lease && stateCommitted) {
      throw failure;
    }
    if (!lease) {
      receipt.status = "ABORTED";
      receipt.outcome = "ABORTED";
      receipt.failure_code = failure.code;
      receipt.failure_message = "guarded replacement aborted before acquiring the lifecycle lease";
      receipt.recovery_status = "FINALIZED";
      appendStage(receipt, "RECEIPT_FINALIZED", now, { outcome: "ABORTED" });
      await cleanupTransactionRoot(receipt).catch(() => undefined);
      await persistReceipt(receiptPath, receipt).catch(() => undefined);
      throw failure;
    }
    let incomplete = false;
    try {
      incomplete = !(await restorePredecessor(receipt, extensionsRealPath));
      if (!incomplete && stateCommitted) {
        await compareAndSwapInstallRecord({
          ...params,
          expectedRecordSha256: trustAnchor.candidateRecordSha256 ?? recordHash(undefined),
          nextRecord: trustAnchor.previousRecord,
        });
      }
      if (!incomplete) {
        await cleanupTransactionRoot(receipt);
      }
    } catch {
      incomplete = true;
    }
    await finalizeFailure({
      receipt,
      receiptPath,
      code: incomplete ? GUARDED_REPLACE_FAILURE_CODE.RECOVERY_INCOMPLETE : failure.code,
      now,
      incomplete,
    }).catch(() => undefined);
    throw failure;
  } finally {
    await lease?.release().catch(() => undefined);
  }
}

function assertReceiptPathsBound(
  receipt: GuardedReplaceReceipt,
  extensionsRealPath: string,
  targetDir: string,
): void {
  const expectedRoot = plannedTransactionRoot(extensionsRealPath, receipt.transactionId);
  if (
    path.resolve(receipt.canonicalTarget.realPath) !== path.resolve(targetDir) ||
    path.resolve(receipt.transactionRoot) !== path.resolve(expectedRoot) ||
    path.resolve(receipt.predecessor.capturedBackup) !==
      path.resolve(path.join(expectedRoot, "predecessor"))
  ) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.INVALID_INPUT,
      "receipt paths are not canonical",
    );
  }
}

function assertReceiptMatchesTrustAnchor(params: {
  receipt: GuardedReplaceReceipt;
  receiptPath: string;
  anchor: GuardedReplaceTrustAnchor;
}): void {
  const { receipt, receiptPath, anchor } = params;
  const matches =
    anchor.schemaVersion === 1 &&
    anchor.transactionId === receipt.transactionId &&
    path.resolve(anchor.receiptPath) === path.resolve(receiptPath) &&
    anchor.pluginId === receipt.pluginId &&
    anchor.leaseId === receipt.leaseId &&
    path.resolve(anchor.canonicalTarget) === path.resolve(receipt.canonicalTarget.realPath) &&
    path.resolve(anchor.transactionRoot) === path.resolve(receipt.transactionRoot) &&
    path.resolve(anchor.predecessorBackup) === path.resolve(receipt.predecessor.capturedBackup) &&
    anchor.predecessorPayloadSha256 === receipt.predecessor.payloadSha256 &&
    path.resolve(anchor.candidateArchivePath) === path.resolve(receipt.candidate.archivePath) &&
    anchor.candidateArchiveSha256 === receipt.candidate.archiveSha256 &&
    path.resolve(anchor.rollbackArchivePath) === path.resolve(receipt.rollback.archivePath) &&
    anchor.rollbackArchiveSha256 === receipt.rollback.archiveSha256 &&
    anchor.previousRecordSha256 === receipt.installedIndex.previousRecordSha256 &&
    anchor.candidateRecordSha256 === receipt.installedIndex.candidateRecordSha256 &&
    anchor.stagedPayloadSha256 === receipt.candidate.stagedPayloadSha256 &&
    recordHash(anchor.previousRecord) === anchor.previousRecordSha256 &&
    recordHash(anchor.candidateRecord ?? undefined) ===
      (anchor.candidateRecordSha256 ?? recordHash(undefined));
  if (!matches) {
    throw guardedError(
      GUARDED_REPLACE_FAILURE_CODE.RECOVERY_INCOMPLETE,
      "receipt does not match the independently persisted trust anchor",
    );
  }
}

async function markReconciled(params: {
  receipt: GuardedReplaceReceipt;
  receiptPath: string;
  now: () => number;
  outcome: ReceiptOutcome;
  incomplete?: boolean;
}): Promise<GuardedReplaceReceipt> {
  params.receipt.status = params.incomplete
    ? "INCOMPLETE"
    : params.outcome === "SUCCESS"
      ? "COMPLETED"
      : params.outcome === "ROLLED_BACK"
        ? "ROLLED_BACK"
        : "ABORTED";
  params.receipt.outcome = params.outcome;
  params.receipt.failure_code = params.incomplete
    ? GUARDED_REPLACE_FAILURE_CODE.RECOVERY_INCOMPLETE
    : null;
  params.receipt.failure_message = params.incomplete
    ? "automatic recovery requires operator authorization"
    : null;
  params.receipt.recovery_status = params.incomplete ? "REQUIRES_OPERATOR" : "FINALIZED";
  appendStage(params.receipt, "RECEIPT_FINALIZED", params.now, {
    reconciled: true,
    outcome: params.outcome,
  });
  await persistReceipt(params.receiptPath, params.receipt);
  return params.receipt;
}

/** Reconciles one create-only receipt without accepting any replacement arguments. */
export async function installGuardedReplaceReconcile(
  params: ReconcileGuardedReplaceParams,
): Promise<GuardedReplaceReceipt> {
  const now = params.now ?? Date.now;
  const receiptPath = resolveUserPath(params.receiptPath);
  const receipt = await readReceipt(receiptPath);
  const trustAnchor = loadTrustAnchor(receipt.transactionId, params);
  assertReceiptMatchesTrustAnchor({ receipt, receiptPath, anchor: trustAnchor });
  const { extensionsRealPath, targetDir } = await resolveBoundTarget({
    extensionsDir: params.extensionsDir,
    pluginId: trustAnchor.pluginId,
  }).catch(async (error) => {
    const extensionsRealPath = await fs.realpath(params.extensionsDir);
    const target = await resolveCanonicalInstallTarget({
      baseDir: extensionsRealPath,
      id: trustAnchor.pluginId,
      invalidNameMessage: "invalid plugin name: path traversal detected",
      boundaryLabel: "extensions directory",
      nameEncoder: encodePluginInstallDirName,
    });
    if (!target.ok) {
      throw error;
    }
    return { extensionsRealPath, targetDir: target.targetDir };
  });
  assertReceiptPathsBound(receipt, extensionsRealPath, targetDir);

  const lease = await acquireLifecycleLease(extensionsRealPath, trustAnchor.pluginId);
  try {
    const records = await loadInstallRecords(params);
    const currentRecordSha256 = recordHash(records[trustAnchor.pluginId]);
    const targetExists = await pathExists(targetDir);
    const targetSha256 = targetExists
      ? await hashGuardedPluginPayload(targetDir, { boundaryDir: extensionsRealPath })
      : null;
    const backupExists = await pathExists(receipt.predecessor.capturedBackup);
    const candidateRecordPresent =
      trustAnchor.candidateRecordSha256 !== null &&
      currentRecordSha256 === trustAnchor.candidateRecordSha256;
    const previousRecordPresent = currentRecordSha256 === trustAnchor.previousRecordSha256;

    if (
      candidateRecordPresent &&
      targetSha256 !== null &&
      targetSha256 === trustAnchor.stagedPayloadSha256
    ) {
      receipt.finalInstalledSha256 = targetSha256;
      if (receipt.status === "COMPLETED" && receipt.outcome === "SUCCESS") {
        await cleanupTransactionRoot(receipt);
        return receipt;
      }
      if (!receipt.stages.some((stage) => stage.name === "STATE_FINALIZED")) {
        appendStage(receipt, "STATE_FINALIZED", now, {
          installRecordSha256: currentRecordSha256,
          reconciled: true,
        });
      }
      const completed = await markReconciled({
        receipt,
        receiptPath,
        now,
        outcome: "SUCCESS",
      });
      await cleanupTransactionRoot(receipt);
      return completed;
    }

    if (previousRecordPresent) {
      if (
        receipt.predecessor.capturedAtMs !== null &&
        !backupExists &&
        targetSha256 !== receipt.predecessor.payloadSha256
      ) {
        return await markReconciled({
          receipt,
          receiptPath,
          now,
          outcome: "INCOMPLETE",
          incomplete: true,
        });
      }
      const restored = await restorePredecessor(receipt, extensionsRealPath);
      if (!restored) {
        return await markReconciled({
          receipt,
          receiptPath,
          now,
          outcome: "INCOMPLETE",
          incomplete: true,
        });
      }
      await cleanupTransactionRoot(receipt);
      if (
        (receipt.status === "ROLLED_BACK" && receipt.outcome === "ROLLED_BACK") ||
        (receipt.status === "ABORTED" && receipt.outcome === "ABORTED")
      ) {
        return receipt;
      }
      return await markReconciled({
        receipt,
        receiptPath,
        now,
        outcome: receipt.predecessor.capturedAtMs === null ? "ABORTED" : "ROLLED_BACK",
      });
    }

    if (candidateRecordPresent) {
      const restored = await restorePredecessor(receipt, extensionsRealPath);
      if (!restored) {
        return await markReconciled({
          receipt,
          receiptPath,
          now,
          outcome: "INCOMPLETE",
          incomplete: true,
        });
      }
      await compareAndSwapInstallRecord({
        ...params,
        pluginId: trustAnchor.pluginId,
        expectedRecordSha256: trustAnchor.candidateRecordSha256!,
        nextRecord: trustAnchor.previousRecord,
      });
      await cleanupTransactionRoot(receipt);
      return await markReconciled({
        receipt,
        receiptPath,
        now,
        outcome: "ROLLED_BACK",
      });
    }

    return await markReconciled({
      receipt,
      receiptPath,
      now,
      outcome: "INCOMPLETE",
      incomplete: true,
    });
  } finally {
    await lease.release();
  }
}
