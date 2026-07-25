// Secure filesystem access for the exec approval policy store.
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "./crypto-digest.js";
import {
  normalizeExecApprovalsInternal,
  parsePersistedExecApprovals,
} from "./exec-approvals-config.js";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./exec-approvals-core.js";
import { assertNoSymlinkParentsSync } from "./fs-safe-advanced.js";
import { resolveRequiredHomeDir } from "./home-dir.js";

function hashExecApprovalsRaw(raw: string | null): string {
  // Preserve existing hashes for present files so mixed-version native/CLI
  // clients can still compare snapshots; only missing needs its own domain.
  return raw === null ? `missing:${sha256Hex("")}` : sha256Hex(raw);
}

export function hashExecApprovalsFile(file: ExecApprovalsFile): string {
  return hashExecApprovalsRaw(`${JSON.stringify(file, null, 2)}\n`);
}

export function isExecApprovalsTargetMissing(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw err;
  }
}

export function isExecApprovalsLockMissing(filePath: string): boolean {
  try {
    const dir = fs.realpathSync(path.dirname(filePath));
    return isExecApprovalsTargetMissing(`${path.join(dir, path.basename(filePath))}.lock`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw err;
  }
}

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  assertNoExecApprovalsSymlinkParents(dir, resolveRequiredHomeDir());
  fs.mkdirSync(dir, { recursive: true });
  const dirStat = fs.lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error(`Refusing to use unsafe exec approvals directory: ${dir}`);
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    if (process.platform !== "win32") {
      throw err;
    }
  }
  return dir;
}

export function resolveCanonicalExecApprovalsTarget(filePath: string): string {
  const dir = ensureDir(filePath);
  return path.join(fs.realpathSync(dir), path.basename(filePath));
}

function assertNoExecApprovalsSymlinkParents(targetPath: string, trustedRoot: string): void {
  try {
    assertNoSymlinkParentsSync({
      rootDir: trustedRoot,
      targetPath,
      allowOutsideRoot: true,
      messagePrefix: "Refusing to traverse symlink in exec approvals path",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UnsafeExecApprovalsPathError(message, { cause: err });
  }
}

export class UnsafeExecApprovalsPathError extends Error {}

function assertSafeExecApprovalsStat(filePath: string, stat: fs.Stats): void {
  if (stat.isSymbolicLink()) {
    throw new UnsafeExecApprovalsPathError(
      `Refusing to write exec approvals via symlink: ${filePath}`,
    );
  }
  if (!stat.isFile()) {
    throw new UnsafeExecApprovalsPathError(
      `Refusing to use non-file exec approvals path: ${filePath}`,
    );
  }
}

function assertSafeExecApprovalsDestination(filePath: string): void {
  try {
    assertSafeExecApprovalsStat(filePath, fs.lstatSync(filePath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

function assertSafeExecApprovalsOverwriteFallback(filePath: string): void {
  assertSafeExecApprovalsDestination(filePath);
  try {
    const stat = fs.statSync(filePath);
    if (stat.nlink > 1) {
      throw new Error(`Refusing copy fallback for hard-linked exec approvals file: ${filePath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

type ExecApprovalsFallbackDestination = {
  existed: boolean;
  fd: number;
  snapshot: Buffer | null;
};

function sameFilesystemEntry(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

type ExecApprovalsRawState = { exists: false; raw: null } | { exists: true; raw: string };

function readExecApprovalsRawState(filePath: string): ExecApprovalsRawState {
  assertNoExecApprovalsSymlinkParents(path.dirname(filePath), resolveRequiredHomeDir());
  // Anchor policy bytes to one inode; otherwise a path swap can make the CAS
  // hash describe a different file than the guarded approvals destination.
  let before: fs.Stats;
  try {
    before = fs.lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, raw: null };
    }
    throw err;
  }
  assertSafeExecApprovalsStat(filePath, before);

  const noFollowFlag = fs.constants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new UnsafeExecApprovalsPathError(
        `Refusing to read changed exec approvals path: ${filePath}`,
        { cause: err },
      );
    }
    if (code === "ELOOP") {
      throw new UnsafeExecApprovalsPathError(
        `Refusing to write exec approvals via symlink: ${filePath}`,
        { cause: err },
      );
    }
    throw err;
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameFilesystemEntry(before, opened)) {
      throw new UnsafeExecApprovalsPathError(
        `Refusing to read changed exec approvals path: ${filePath}`,
      );
    }
    const raw = fs.readFileSync(fd, "utf8");
    let after: fs.Stats;
    try {
      after = fs.lstatSync(filePath);
    } catch (err) {
      throw new UnsafeExecApprovalsPathError(
        `Refusing to read changed exec approvals path: ${filePath}`,
        { cause: err },
      );
    }
    assertSafeExecApprovalsStat(filePath, after);
    if (!sameFilesystemEntry(opened, after)) {
      throw new UnsafeExecApprovalsPathError(
        `Refusing to read changed exec approvals path: ${filePath}`,
      );
    }
    return { exists: true, raw };
  } finally {
    fs.closeSync(fd);
  }
}

export function readExecApprovalsSnapshotFromPath(filePath: string): ExecApprovalsSnapshot {
  const state = readExecApprovalsRawState(filePath);
  if (!state.exists) {
    return {
      path: filePath,
      exists: false,
      raw: null,
      file: normalizeExecApprovalsInternal({ version: 1, agents: {} }),
      hash: hashExecApprovalsRaw(null),
    };
  }
  return {
    path: filePath,
    exists: true,
    raw: state.raw,
    file: parsePersistedExecApprovals(state.raw),
    hash: hashExecApprovalsRaw(state.raw),
  };
}

function readExecApprovalsFallbackSnapshotFromFd(fd: number): Buffer {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  while (true) {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    position += bytesRead;
  }
  return Buffer.concat(chunks);
}

function validateExecApprovalsFallbackFd(filePath: string, fd: number): fs.Stats {
  const linkStat = fs.lstatSync(filePath);
  if (linkStat.isSymbolicLink()) {
    throw new Error(`Refusing to write exec approvals via symlink: ${filePath}`);
  }
  const pathStat = fs.statSync(filePath);
  const fdStat = fs.fstatSync(fd);
  if (!fdStat.isFile()) {
    throw new Error(`Refusing copy fallback for non-file exec approvals path: ${filePath}`);
  }
  if (fdStat.nlink > 1) {
    throw new Error(`Refusing copy fallback for hard-linked exec approvals file: ${filePath}`);
  }
  if (!sameFilesystemEntry(pathStat, fdStat)) {
    throw new Error(`Refusing copy fallback after exec approvals path changed: ${filePath}`);
  }
  return fdStat;
}

function openExistingExecApprovalsFallbackDestination(
  filePath: string,
): ExecApprovalsFallbackDestination {
  const noFollowFlag = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(filePath, fs.constants.O_RDWR | noFollowFlag, 0o600);
  try {
    validateExecApprovalsFallbackFd(filePath, fd);
    return {
      existed: true,
      fd,
      snapshot: readExecApprovalsFallbackSnapshotFromFd(fd),
    };
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // best-effort after validation failure
    }
    throw err;
  }
}

function createExecApprovalsFallbackDestination(
  filePath: string,
): ExecApprovalsFallbackDestination {
  const noFollowFlag = fs.constants.O_NOFOLLOW ?? 0;
  try {
    const fd = fs.openSync(
      filePath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag,
      0o600,
    );
    try {
      validateExecApprovalsFallbackFd(filePath, fd);
      return { existed: false, fd, snapshot: null };
    } catch (err) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort after validation failure
      }
      throw err;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return openExistingExecApprovalsFallbackDestination(filePath);
    }
    throw err;
  }
}

function openExecApprovalsFallbackDestination(filePath: string): ExecApprovalsFallbackDestination {
  try {
    return openExistingExecApprovalsFallbackDestination(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return createExecApprovalsFallbackDestination(filePath);
    }
    throw err;
  }
}

function writeExecApprovalsFallbackBuffer(fd: number, contents: Buffer): void {
  fs.ftruncateSync(fd, 0);
  let written = 0;
  while (written < contents.length) {
    written += fs.writeSync(fd, contents, written, contents.length - written, written);
  }
  fs.ftruncateSync(fd, contents.length);
  try {
    fs.fchmodSync(fd, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
}

function restoreExecApprovalsFallbackDestination(
  filePath: string,
  destination: ExecApprovalsFallbackDestination,
): void {
  if (!destination.existed) {
    try {
      const pathStat = fs.statSync(filePath);
      const fdStat = fs.fstatSync(destination.fd);
      if (sameFilesystemEntry(pathStat, fdStat)) {
        fs.rmSync(filePath, { force: true });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    return;
  }
  writeExecApprovalsFallbackBuffer(destination.fd, destination.snapshot ?? Buffer.alloc(0));
}

function copyExecApprovalsFallback(tempPath: string, filePath: string): void {
  const contents = fs.readFileSync(tempPath);
  const destination = openExecApprovalsFallbackDestination(filePath);
  try {
    writeExecApprovalsFallbackBuffer(destination.fd, contents);
    validateExecApprovalsFallbackFd(filePath, destination.fd);
  } catch (copyErr) {
    try {
      restoreExecApprovalsFallbackDestination(filePath, destination);
    } catch (restoreErr) {
      throw new Error(
        `Failed to restore exec approvals after copy fallback failure for ${filePath}: ${String(
          copyErr,
        )}`,
        { cause: restoreErr },
      );
    }
    throw copyErr;
  } finally {
    fs.closeSync(destination.fd);
  }
}

function renameExecApprovalsWithFallback(tempPath: string, filePath: string): void {
  try {
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Windows can reject rename-overwrite when another process has a transient
    // handle on the target approvals file.
    if (code !== "EPERM" && code !== "EEXIST") {
      throw err;
    }
    assertSafeExecApprovalsOverwriteFallback(filePath);
    copyExecApprovalsFallback(tempPath, filePath);
    fs.rmSync(tempPath, { force: true });
  }
}

// Coerce legacy/corrupted allowlists into `ExecAllowlistEntry[]` before we spread
// entries to add ids (spreading strings creates {"0":"l","1":"s",...}).
export function hardenUnchangedExecApprovals(filePath: string): boolean {
  ensureDir(filePath);
  assertSafeExecApprovalsDestination(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
  if (stat.nlink > 1) {
    return false;
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
  return true;
}

export function writeExecApprovalsRaw(filePath: string, raw: string) {
  const dir = ensureDir(filePath);
  assertSafeExecApprovalsDestination(filePath);
  const tempPath = path.join(dir, `.exec-approvals.${process.pid}.${crypto.randomUUID()}.tmp`);
  let tempWritten = false;
  try {
    fs.writeFileSync(tempPath, raw, { mode: 0o600, flag: "wx" });
    try {
      fs.chmodSync(tempPath, 0o600);
    } catch {
      // best-effort on platforms without chmod
    }
    tempWritten = true;
    renameExecApprovalsWithFallback(tempPath, filePath);
  } finally {
    if (tempWritten && fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
}
