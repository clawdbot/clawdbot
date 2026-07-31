// Applies private POSIX modes without rejecting filesystems that cannot enforce chmod.
import { randomUUID } from "node:crypto";
import { chmodSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const CHMOD_UNSUPPORTED_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "EINVAL"]);
const PRIVATE_PROBE_FILE_MODE = 0o600;

function hasRestrictivePermissions(target: string): boolean {
  try {
    return (statSync(target).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function filesystemRejectsChmod(target: string): boolean {
  let probePath: string;
  try {
    const probeDir = statSync(target).isDirectory() ? target : path.dirname(target);
    probePath = path.join(probeDir, `.openclaw-chmod-probe-${randomUUID()}`);
    writeFileSync(probePath, "", { flag: "wx", mode: PRIVATE_PROBE_FILE_MODE });
  } catch {
    return false;
  }
  try {
    chmodSync(probePath, PRIVATE_PROBE_FILE_MODE);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  } finally {
    try {
      unlinkSync(probePath);
    } catch {
      // The probe is best-effort cleanup after a failed capability check.
    }
  }
}

function canIgnorePrivateChmodError(target: string, code: string | undefined): boolean {
  if (code && CHMOD_UNSUPPORTED_CODES.has(code)) {
    return true;
  }
  if (code === "EROFS") {
    // WSL can report EROFS for chmod on an already-private path. Never waive
    // broad permissions for this anomalous code.
    return hasRestrictivePermissions(target);
  }
  if (code !== "EPERM") {
    return false;
  }
  // EPERM is ambiguous: keep restrictive targets usable, otherwise prove the
  // containing filesystem also rejects chmod before weakening fail-closed behavior.
  return hasRestrictivePermissions(target) || filesystemRejectsChmod(target);
}

/**
 * Applies a private POSIX mode, reporting unsupported filesystems without
 * weakening real permission failures.
 */
export function applyPrivateModeSync(
  target: string,
  mode: number,
): { applied: true } | { applied: false; error: unknown } {
  try {
    chmodSync(target, mode);
    return { applied: true };
  } catch (err) {
    if (!canIgnorePrivateChmodError(target, (err as NodeJS.ErrnoException).code)) {
      throw err;
    }
    return { applied: false, error: err };
  }
}
