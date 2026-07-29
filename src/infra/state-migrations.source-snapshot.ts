import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Root } from "@openclaw/fs-safe";

/** The stable source identity every doctor-owned import verifies before cleanup. */
export type LegacyMigrationSourceSnapshot = {
  buffer: Buffer;
  dev: number;
  ino: number;
  mtimeMs: number;
  raw: string;
  sha256: string;
  size: number;
  sourcePath: string;
};

/** A source may be inaccessible; only a proven absence permits skipping repair. */
export function legacyMigrationPathMayExist(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export function legacyMigrationSourceOrClaimMayExist(
  sourcePath: string,
  claimSuffix = ".doctor-importing",
): boolean {
  return (
    legacyMigrationPathMayExist(sourcePath) ||
    legacyMigrationPathMayExist(`${sourcePath}${claimSuffix}`)
  );
}

/** Constrain migration reads and moves to the original trusted state root. */
export function resolveLegacyMigrationRelativePath(
  stateDir: string,
  filePath: string,
  label: string,
  includeFilePath = true,
): string {
  const relativePath = path.relative(path.resolve(stateDir), path.resolve(filePath));
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(
      `legacy ${label} path is outside the state directory${includeFilePath ? `: ${filePath}` : ""}`,
    );
  }
  return relativePath;
}

/** Hash the exact bounded bytes returned by the symlink/hardlink-safe root. */
export async function readLegacyMigrationSourceSnapshot(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
  maxBytes: number;
  label: string;
  hashDecodedText?: boolean;
}): Promise<LegacyMigrationSourceSnapshot> {
  const opened = await params.stateRoot.read(
    resolveLegacyMigrationRelativePath(params.stateDir, params.sourcePath, params.label),
    { hardlinks: "reject", maxBytes: params.maxBytes, symlinks: "reject" },
  );
  if (!opened.stat.isFile() || opened.stat.size !== opened.buffer.byteLength) {
    throw new Error(`legacy ${params.label} source is not a stable regular file`);
  }
  const raw = opened.buffer.toString("utf8");
  return {
    buffer: opened.buffer,
    dev: opened.stat.dev,
    ino: opened.stat.ino,
    mtimeMs: opened.stat.mtimeMs,
    raw,
    sha256: createHash("sha256")
      .update(params.hashDecodedText ? raw : opened.buffer)
      .digest("hex"),
    size: opened.stat.size,
    sourcePath: params.sourcePath,
  };
}

/** Pin synchronous legacy files before and after parsing; never follow new links. */
export function readLegacyMigrationSourceSnapshotSync(params: {
  sourcePath: string;
  label: string;
  followSymlinks?: boolean;
  maxBytes?: number;
}): LegacyMigrationSourceSnapshot {
  const stat = params.followSymlinks ? fs.statSync : fs.lstatSync;
  const before = stat(params.sourcePath);
  if (!before.isFile() || (!params.followSymlinks && before.isSymbolicLink())) {
    throw new Error(
      `legacy ${params.label} source is not a regular${params.followSymlinks ? "" : " non-symlink"} file`,
    );
  }
  if (params.maxBytes !== undefined && before.size > params.maxBytes) {
    throw new Error(`legacy ${params.label} source exceeds the metadata size limit`);
  }
  const raw = fs.readFileSync(params.sourcePath, "utf8");
  const after = stat(params.sourcePath);
  if (
    !after.isFile() ||
    (!params.followSymlinks && after.isSymbolicLink()) ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error(`legacy ${params.label} source changed while doctor was reading it`);
  }
  return {
    buffer: Buffer.from(raw),
    dev: after.dev,
    ino: after.ino,
    mtimeMs: after.mtimeMs,
    raw,
    sha256: createHash("sha256").update(raw).digest("hex"),
    size: after.size,
    sourcePath: params.sourcePath,
  };
}

/** Check source identity again before committing or deleting a verified import. */
export function assertLegacyMigrationSourceUnchanged(params: {
  sourcePath: string;
  snapshot: LegacyMigrationSourceSnapshot;
  label: string;
  followSymlinks?: boolean;
  maxBytes?: number;
}): void {
  if (
    !legacyMigrationSourceSnapshotsMatch(
      readLegacyMigrationSourceSnapshotSync(params),
      params.snapshot,
    )
  ) {
    throw new Error(`legacy ${params.label} source changed after doctor loaded it`);
  }
}

/** Restore a claimed legacy source when verified cleanup cannot complete. */
export function claimAndRemoveLegacyMigrationSource(params: {
  sourcePath: string;
  snapshot: LegacyMigrationSourceSnapshot;
  label: string;
  followSymlinks?: boolean;
  maxBytes?: number;
  beforeClaim?: () => void;
  removeSource?: (sourcePath: string) => void;
}): void {
  params.beforeClaim?.();
  const claimPath = `${params.sourcePath}.doctor-importing-${process.pid}-${randomUUID()}`;
  fs.renameSync(params.sourcePath, claimPath);
  try {
    const claimed = readLegacyMigrationSourceSnapshotSync({ ...params, sourcePath: claimPath });
    if (!legacyMigrationSourceSnapshotsMatch(claimed, params.snapshot)) {
      throw new Error(`legacy ${params.label} source changed before doctor could claim it`);
    }
    (params.removeSource ?? fs.unlinkSync)(claimPath);
  } catch (error) {
    let restoreFailure = "";
    if (fs.existsSync(claimPath) && !fs.existsSync(params.sourcePath)) {
      try {
        fs.renameSync(claimPath, params.sourcePath);
      } catch (restoreError) {
        restoreFailure = `; the claimed source remains at ${claimPath} because restore also failed: ${String(restoreError)}`;
      }
    }
    throw new Error(`${String(error)}${restoreFailure}`, { cause: error });
  }
}

export function legacyMigrationSourceSnapshotsMatch(
  left: Pick<LegacyMigrationSourceSnapshot, "dev" | "ino" | "mtimeMs" | "sha256" | "size">,
  right: Pick<LegacyMigrationSourceSnapshot, "dev" | "ino" | "mtimeMs" | "sha256" | "size">,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256 &&
    left.size === right.size
  );
}

export function legacyMigrationSourceContentMatches(
  left: Pick<LegacyMigrationSourceSnapshot, "sha256" | "size">,
  right: Pick<LegacyMigrationSourceSnapshot, "sha256" | "size">,
): boolean {
  return left.sha256 === right.sha256 && left.size === right.size;
}
