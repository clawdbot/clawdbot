/** Exact original identity and no-copy publication for migration recovery artifacts. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import {
  publishFileExclusive,
  requireDirectorySync,
  syncDirectory,
} from "../infra/directory-durability.js";

const IdentitySchema = z.object({
  dev: z.string(),
  ino: z.string(),
  mtimeNs: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const MigrationArtifactSchema = z.object({
  identity: IdentitySchema,
  classification: z.enum(["imported", "repair-original", "protected"]),
  reason: z.string(),
  dependencies: z.array(z.string()).default([]),
  disposal: z.discriminatedUnion("state", [
    z.object({ state: z.literal("retained") }),
    z.object({
      state: z.literal("pending-disposal"),
      claimPath: z.string(),
      intendedAt: z.string(),
      phase: z.enum(["intent", "unlink-pending"]),
    }),
    z.object({ state: z.literal("disposed"), disposedAt: z.string() }),
  ]),
});
export type MigrationArtifact = z.infer<typeof MigrationArtifactSchema>;
export type MigrationArtifactIdentity = MigrationArtifact["identity"];

export function statMigrationPath(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((isRecord(error) ? error.code : undefined) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function isPendingMigrationArtifactClaim(
  archivePath: string,
  artifact: MigrationArtifact | undefined,
): boolean {
  if (artifact?.disposal.state !== "pending-disposal") {
    return false;
  }
  const original = statMigrationPath(archivePath);
  const claim = statMigrationPath(artifact.disposal.claimPath);
  return Boolean(
    original?.isFile() &&
    claim?.isFile() &&
    original.nlink === 2 &&
    claim.nlink === 2 &&
    original.dev === claim.dev &&
    original.ino === claim.ino &&
    String(original.ino) === artifact.identity.ino,
  );
}

/** Descriptor reads are bounded; identity and content are checked before and after hashing. */
export function readMigrationArtifactIdentity(
  filePath: string,
  expectedLinks = 1n,
  importedFingerprint?: Pick<fs.BigIntStats, "ctimeNs" | "dev" | "ino" | "mtimeNs" | "size">,
): MigrationArtifactIdentity {
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.nlink !== expectedLinks) {
    throw new Error("artifact is not an unaliased regular file");
  }
  if (
    importedFingerprint &&
    (["ctimeNs", "dev", "ino", "mtimeNs", "size"] as const).some(
      (key) => before[key] !== importedFingerprint[key],
    )
  ) {
    throw new Error("Transcript changed after import; retaining the unverified original");
  }
  const fd = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("artifact identity changed");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) {
        break;
      }
      digest.update(buffer.subarray(0, count));
      bytes += count;
    }
    const after = fs.lstatSync(filePath, { bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      after.size !== before.size ||
      BigInt(bytes) !== before.size
    ) {
      throw new Error("artifact changed while hashing");
    }
    return {
      dev: String(before.dev),
      ino: String(before.ino),
      mtimeNs: String(before.mtimeNs),
      size: bytes,
      sha256: digest.digest("hex"),
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function sameMigrationArtifact(
  left: MigrationArtifactIdentity,
  right: MigrationArtifactIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size &&
    left.sha256 === right.sha256
  );
}

/** Exclusive same-filesystem link publication, then unlink; never copies raw history. */
export async function moveMigrationArtifact(
  sourcePath: string,
  targetPath: string,
  expected: MigrationArtifactIdentity,
  onPublished?: () => undefined,
): Promise<void> {
  if (!fs.lstatSync(targetPath, { bigint: true, throwIfNoEntry: false })) {
    if (!sameMigrationArtifact(readMigrationArtifactIdentity(sourcePath), expected)) {
      throw new Error("artifact changed before publication");
    }
    const published = await publishFileExclusive({
      sourcePath,
      targetPath,
      expectedSourceIdentity: { dev: BigInt(expected.dev), ino: BigInt(expected.ino) },
      strategy: "link-required",
      onSyncFailure: "preserve",
    });
    requireDirectorySync(published.directorySync, "Recovery artifact publication");
  } else {
    // A preserved link may have outlived a failed directory sync. Make its name durable
    // before an interrupted move can remove the original name.
    requireDirectorySync(
      await syncDirectory(path.dirname(targetPath)),
      "Recovery artifact publication",
    );
  }
  assertMigrationArtifactPublication(sourcePath, targetPath, expected);
  if (onPublished) {
    onPublished();
    assertMigrationArtifactPublication(sourcePath, targetPath, expected);
  }
  fs.unlinkSync(sourcePath);
  requireDirectorySync(await syncDirectory(path.dirname(sourcePath)), "Recovery artifact source");
  if (!sameMigrationArtifact(readMigrationArtifactIdentity(targetPath), expected)) {
    throw new Error("artifact changed during publication");
  }
}

/** Only the recorded exact two-name inode can finish or undo an interrupted publication. */
function assertMigrationArtifactPublication(
  sourcePath: string,
  targetPath: string,
  expected: MigrationArtifactIdentity,
): void {
  // A crash can leave both names. Only this exact two-link original can complete the move.
  const target = fs.lstatSync(targetPath, { bigint: true });
  const source = fs.lstatSync(sourcePath, { bigint: true });
  if (
    !target.isFile() ||
    !source.isFile() ||
    target.dev !== source.dev ||
    target.ino !== source.ino ||
    source.nlink !== 2n ||
    !sameMigrationArtifact(readMigrationArtifactIdentity(sourcePath, 2n), expected) ||
    !sameMigrationArtifact(readMigrationArtifactIdentity(targetPath, 2n), expected)
  ) {
    throw new Error("publication paths changed or have unexpected aliases");
  }
}
