import { createHash } from "node:crypto";
import type { BigIntStats, Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "../infra/fs-safe-advanced.js";
import { root } from "../infra/fs-safe.js";
import { isValidAgentId, normalizeAgentId } from "../routing/session-key.js";
import {
  SNAPSHOT_MANIFEST_FILENAME,
  SNAPSHOT_SQLITE_FILENAME,
  type SnapshotDatabaseManifest,
  type SnapshotManifest,
} from "./snapshot-provider.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SQLITE_USER_VERSION = 2_147_483_647;
const MIN_SQLITE_USER_VERSION = -2_147_483_648;
const SNAPSHOT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type SnapshotArtifactDigest = {
  sha256: string;
  sizeBytes: number;
  stat: Stats;
};

type OpenFileHandle = Awaited<ReturnType<typeof fs.open>>;

export function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export async function hashSnapshotArtifact(snapshotDir: string): Promise<SnapshotArtifactDigest> {
  const snapshotRoot = await root(snapshotDir);
  const opened = await snapshotRoot.open(SNAPSHOT_SQLITE_FILENAME, {
    hardlinks: "reject",
    symlinks: "reject",
  });
  try {
    return { ...(await hashFileHandle(opened.handle)), stat: opened.stat };
  } finally {
    await opened.handle.close();
  }
}

export async function copySnapshotArtifact(
  snapshotDir: string,
  targetPath: string,
): Promise<SnapshotArtifactDigest> {
  const snapshotRoot = await root(snapshotDir);
  const source = await snapshotRoot.open(SNAPSHOT_SQLITE_FILENAME, {
    hardlinks: "reject",
    symlinks: "reject",
  });
  let target: OpenFileHandle | undefined;
  let targetIdentity: Stats | undefined;
  try {
    target = await fs.open(targetPath, "wx+", 0o600);
    targetIdentity = await target.stat();
    const digest = await hashFileHandle(source.handle, target);
    await target.sync();
    const finalIdentity = await target.stat();
    const currentIdentity = await fs.lstat(targetPath);
    if (
      !sameFileIdentity(targetIdentity, finalIdentity) ||
      !sameFileIdentity(targetIdentity, currentIdentity)
    ) {
      throw new Error(`Snapshot restore staging file changed during copy: ${targetPath}`);
    }
    return { ...digest, stat: finalIdentity };
  } catch (error) {
    await target?.close().catch(() => undefined);
    target = undefined;
    if (targetIdentity) {
      const currentIdentity = await fs.lstat(targetPath).catch(() => undefined);
      if (currentIdentity && sameFileIdentity(targetIdentity, currentIdentity)) {
        await fs.unlink(targetPath).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await target?.close().catch(() => undefined);
    await source.handle.close().catch(() => undefined);
  }
}

async function hashFileHandle(
  source: OpenFileHandle,
  target?: OpenFileHandle,
): Promise<Omit<SnapshotArtifactDigest, "stat">> {
  const initialStat = await source.stat({ bigint: true });
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let sizeBytes = 0;
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, sizeBytes);
    if (bytesRead === 0) {
      break;
    }
    hash.update(buffer.subarray(0, bytesRead));
    let bytesWritten = 0;
    if (target) {
      while (bytesWritten < bytesRead) {
        const result = await target.write(
          buffer,
          bytesWritten,
          bytesRead - bytesWritten,
          sizeBytes + bytesWritten,
        );
        if (result.bytesWritten === 0) {
          throw new Error("Snapshot restore staging copy made no progress.");
        }
        bytesWritten += result.bytesWritten;
      }
    }
    sizeBytes += bytesRead;
  }
  const finalStat = await source.stat({ bigint: true });
  if (!sameMutationFingerprint(initialStat, finalStat)) {
    throw new Error("Snapshot artifact changed while being read.");
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

function sameMutationFingerprint(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size
  );
}

export async function writeSnapshotManifest(
  snapshotDir: string,
  manifest: SnapshotManifest,
): Promise<void> {
  const manifestPath = path.join(snapshotDir, SNAPSHOT_MANIFEST_FILENAME);
  const handle = await fs.open(manifestPath, "wx+", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readSnapshotManifest(
  snapshotDir: string,
  expectedSnapshotId = path.basename(snapshotDir),
): Promise<SnapshotManifest> {
  const snapshotRoot = await root(snapshotDir);
  const manifestPath = path.join(snapshotDir, SNAPSHOT_MANIFEST_FILENAME);
  const result = await snapshotRoot.read(SNAPSHOT_MANIFEST_FILENAME, {
    hardlinks: "reject",
    maxBytes: MAX_MANIFEST_BYTES,
    symlinks: "reject",
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.buffer.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Snapshot manifest is not valid JSON: ${manifestPath}`, { cause: error });
  }
  return parseSnapshotManifest(parsed, manifestPath, expectedSnapshotId);
}

function parseSnapshotManifest(
  value: unknown,
  manifestPath: string,
  expectedSnapshotId: string,
): SnapshotManifest {
  const record = requireRecord(value, "manifest", manifestPath);
  requireExactKeys(record, ["schemaVersion", "snapshotId", "createdAt", "database", "artifact"]);
  if (record.schemaVersion !== 1) {
    throw new Error(
      `Unsupported snapshot manifest schemaVersion ${String(record.schemaVersion)}: ${manifestPath}`,
    );
  }
  const snapshotId = requireSnapshotId(record.snapshotId, manifestPath);
  if (snapshotId !== expectedSnapshotId) {
    throw new Error(
      `Snapshot manifest id ${snapshotId} does not match directory ${expectedSnapshotId}: ${manifestPath}`,
    );
  }
  const createdAt = requireCanonicalTimestamp(record.createdAt, manifestPath);
  const database = parseSnapshotDatabase(record.database, manifestPath);
  const artifactRecord = requireRecord(record.artifact, "artifact", manifestPath);
  requireExactKeys(artifactRecord, ["path", "sha256", "sizeBytes"]);
  if (artifactRecord.path !== SNAPSHOT_SQLITE_FILENAME) {
    throw new Error(
      `Snapshot manifest artifact.path must be ${SNAPSHOT_SQLITE_FILENAME}: ${manifestPath}`,
    );
  }
  if (typeof artifactRecord.sha256 !== "string" || !SHA256_PATTERN.test(artifactRecord.sha256)) {
    throw new Error(`Snapshot manifest artifact.sha256 is invalid: ${manifestPath}`);
  }
  if (!Number.isSafeInteger(artifactRecord.sizeBytes) || Number(artifactRecord.sizeBytes) <= 0) {
    throw new Error(`Snapshot manifest artifact.sizeBytes is invalid: ${manifestPath}`);
  }
  return {
    schemaVersion: 1,
    snapshotId,
    createdAt,
    database,
    artifact: {
      path: SNAPSHOT_SQLITE_FILENAME,
      sha256: artifactRecord.sha256,
      sizeBytes: Number(artifactRecord.sizeBytes),
    },
  };
}

function parseSnapshotDatabase(value: unknown, manifestPath: string): SnapshotDatabaseManifest {
  const database = requireRecord(value, "database", manifestPath);
  const role = database.role;
  const basename = requireSafeText(database.basename, "database.basename", manifestPath, 255);
  if (path.basename(basename) !== basename || basename === "." || basename === "..") {
    throw new Error(`Snapshot manifest database.basename is invalid: ${manifestPath}`);
  }
  const userVersion = requireSqliteUserVersion(database.userVersion, manifestPath);
  if (role === "global") {
    requireExactKeys(database, ["role", "basename", "userVersion"]);
    return { role, basename, userVersion };
  }
  if (role === "agent") {
    requireExactKeys(database, ["role", "agentId", "basename", "userVersion"]);
    const agentId = requireSafeText(database.agentId, "database.agentId", manifestPath, 64);
    if (!isValidAgentId(agentId) || normalizeAgentId(agentId) !== agentId) {
      throw new Error(`Snapshot manifest database.agentId is invalid: ${manifestPath}`);
    }
    return { role, agentId, basename, userVersion };
  }
  if (role === "generic") {
    requireExactKeys(database, ["role", "id", "basename", "userVersion"]);
    const id = requireSafeText(database.id, "database.id", manifestPath, 256);
    return { role, id, basename, userVersion };
  }
  throw new Error(`Snapshot manifest database.role is invalid: ${manifestPath}`);
}

function requireRecord(
  value: unknown,
  field: string,
  manifestPath: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Snapshot manifest ${field} must be an object: ${manifestPath}`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, expectedKeys: readonly string[]): void {
  const actual = Object.keys(record).toSorted();
  const expected = [...expectedKeys].toSorted();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(
      `Snapshot manifest fields must be exactly ${expectedKeys.join(", ")}; got ${actual.join(", ")}`,
    );
  }
}

function requireSnapshotId(value: unknown, manifestPath: string): string {
  if (typeof value !== "string" || !SNAPSHOT_ID_PATTERN.test(value)) {
    throw new Error(`Snapshot manifest snapshotId is invalid: ${manifestPath}`);
  }
  return value;
}

function requireCanonicalTimestamp(value: unknown, manifestPath: string): string {
  if (typeof value !== "string") {
    throw new Error(`Snapshot manifest createdAt is invalid: ${manifestPath}`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`Snapshot manifest createdAt is not canonical ISO 8601: ${manifestPath}`);
  }
  return value;
}

function requireSafeText(
  value: unknown,
  field: string,
  manifestPath: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    containsAsciiControlCharacter(value)
  ) {
    throw new Error(`Snapshot manifest ${field} is invalid: ${manifestPath}`);
  }
  return value;
}

function requireSqliteUserVersion(value: unknown, manifestPath: string): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < MIN_SQLITE_USER_VERSION ||
    Number(value) > MAX_SQLITE_USER_VERSION
  ) {
    throw new Error(`Snapshot manifest database.userVersion is invalid: ${manifestPath}`);
  }
  return Number(value);
}
