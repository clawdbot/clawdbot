import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Root } from "@openclaw/fs-safe";
import { pathMayExistSync } from "./path-existence.js";

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

type LegacyMigrationSourceIdentity = Pick<
  LegacyMigrationSourceSnapshot,
  "dev" | "ino" | "mtimeMs" | "sha256" | "size" | "sourcePath"
>;

/** Keep every claim operation bound to the same trusted owner root and source inode. */
export class LegacyMigrationSourceClaim<
  TSnapshot extends LegacyMigrationSourceIdentity = LegacyMigrationSourceSnapshot,
> {
  readonly sourcePath: string;
  readonly claimPath: string;
  readonly sourceRelativePath: string;
  readonly claimRelativePath: string;

  constructor(
    private readonly params: {
      stateRoot: Root;
      stateDir: string;
      sourcePath: string;
      label: string;
      claimSuffix?: string;
      readSnapshot: (sourcePath: string) => Promise<TSnapshot>;
      formatError?: (error: unknown) => string;
      includeFilePath?: boolean;
    },
  ) {
    this.sourcePath = params.sourcePath;
    this.claimPath = `${params.sourcePath}${params.claimSuffix ?? ".doctor-importing"}`;
    this.sourceRelativePath = resolveLegacyMigrationRelativePath(
      params.stateDir,
      this.sourcePath,
      params.label,
      params.includeFilePath,
    );
    this.claimRelativePath = resolveLegacyMigrationRelativePath(
      params.stateDir,
      this.claimPath,
      params.label,
      params.includeFilePath,
    );
  }

  async exists(claimed = false): Promise<boolean> {
    return await this.params.stateRoot.exists(
      claimed ? this.claimRelativePath : this.sourceRelativePath,
    );
  }

  async read(claimed = false): Promise<TSnapshot> {
    return await this.params.readSnapshot(claimed ? this.claimPath : this.sourcePath);
  }

  async recover(conflictMessage: string): Promise<void> {
    if (!(await this.exists(true))) {
      return;
    }
    const claimed = await this.read(true);
    if (!(await this.exists())) {
      await this.params.stateRoot.move(this.claimRelativePath, this.sourceRelativePath);
      return;
    }
    if (!legacyMigrationSourceContentMatches(claimed, await this.read())) {
      throw new Error(conflictMessage);
    }
    await this.params.stateRoot.remove(this.claimRelativePath);
  }

  async restore(): Promise<string | null> {
    try {
      if (!(await this.exists(true))) {
        return null;
      }
      if (await this.exists()) {
        return `source path already exists: ${this.sourcePath}`;
      }
      await this.params.stateRoot.move(this.claimRelativePath, this.sourceRelativePath);
      return null;
    } catch (error) {
      return this.params.formatError?.(error) ?? String(error);
    }
  }

  async claim(params: {
    snapshot: TSnapshot;
    mismatchMessage: string;
    beforeClaim?: () => void;
  }): Promise<TSnapshot> {
    params.beforeClaim?.();
    await this.params.stateRoot.move(this.sourceRelativePath, this.claimRelativePath);
    const claimed = await this.read(true);
    if (!legacyMigrationSourceSnapshotsMatch(claimed, params.snapshot)) {
      throw new Error(params.mismatchMessage);
    }
    return claimed;
  }

  async remove(
    params: {
      removeSource?: (sourcePath: string) => Promise<void> | void;
      sourceReappearedMessage?: string;
      remainingMessage?: string;
      sourceRemainingMessage?: string;
      claimRemainingMessage?: string;
      skipSourceCheck?: boolean;
    } = {},
  ): Promise<void> {
    if (!params.skipSourceCheck && (await this.exists())) {
      throw new Error(
        params.sourceReappearedMessage ??
          `legacy source reappeared during import: ${this.sourcePath}`,
      );
    }
    if (params.removeSource) {
      await params.removeSource(this.claimPath);
    } else {
      await this.params.stateRoot.remove(this.claimRelativePath);
    }
    const sourceRemainingMessage = params.sourceRemainingMessage ?? params.remainingMessage;
    if (sourceRemainingMessage && (await this.exists())) {
      throw new Error(sourceRemainingMessage);
    }
    const claimRemainingMessage = params.claimRemainingMessage ?? params.remainingMessage;
    if (claimRemainingMessage && (await this.exists(true))) {
      throw new Error(claimRemainingMessage);
    }
  }
}

/** Restore claimed sources in reverse order so a failed multi-file import remains atomic. */
export async function restoreLegacyMigrationSourceClaims<
  TSnapshot extends LegacyMigrationSourceIdentity,
>(claims: readonly LegacyMigrationSourceClaim<TSnapshot>[]): Promise<string[]> {
  const errors: string[] = [];
  for (const claim of claims.toReversed()) {
    const error = await claim.restore();
    if (error) {
      errors.push(error);
    }
  }
  return errors;
}

/** Claim every source before SQLite writes; restore the full batch on the first mismatch. */
export async function claimLegacyMigrationSourceClaims<
  TSnapshot extends LegacyMigrationSourceIdentity,
>(
  claims: readonly { claim: LegacyMigrationSourceClaim<TSnapshot>; snapshot: TSnapshot }[],
  params: { beforeClaim?: () => void; mismatchMessage: string },
): Promise<void> {
  params.beforeClaim?.();
  const claimed: LegacyMigrationSourceClaim<TSnapshot>[] = [];
  try {
    for (const { claim, snapshot } of claims) {
      claimed.push(claim);
      await claim.claim({ snapshot, mismatchMessage: params.mismatchMessage });
    }
  } catch (error) {
    const restoreErrors = await restoreLegacyMigrationSourceClaims(claimed);
    throw new Error(
      `${String(error)}${restoreErrors.length > 0 ? `; restore failures: ${restoreErrors.join("; ")}` : ""}`,
      { cause: error },
    );
  }
}

export function legacyMigrationSourceOrClaimMayExist(
  sourcePath: string,
  claimSuffix = ".doctor-importing",
): boolean {
  return pathMayExistSync(sourcePath) || pathMayExistSync(`${sourcePath}${claimSuffix}`);
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

function legacyMigrationSourceContentMatches(
  left: Pick<LegacyMigrationSourceSnapshot, "sha256" | "size">,
  right: Pick<LegacyMigrationSourceSnapshot, "sha256" | "size">,
): boolean {
  return left.sha256 === right.sha256 && left.size === right.size;
}
