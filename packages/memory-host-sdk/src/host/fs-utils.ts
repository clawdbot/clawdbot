// Memory Host SDK helper module supports fs utils behavior.
import { configureFsSafePython } from "@openclaw/fs-safe/config";
// fs-safe facade with Python validation disabled by default for this package's
// host-side memory file operations.
export { root } from "@openclaw/fs-safe/root";
export { isPathInside, isPathInsideWithRealpath } from "@openclaw/fs-safe/path";
export {
  assertNoSymlinkParents,
  readRegularFile,
  statRegularFile,
  type RegularFileStatResult,
} from "@openclaw/fs-safe/advanced";
export { walkDirectory, type WalkDirectoryEntry } from "@openclaw/fs-safe/walk";

const hasPythonModeOverride =
  process.env.FS_SAFE_PYTHON_MODE != null || process.env.OPENCLAW_FS_SAFE_PYTHON_MODE != null;

if (!hasPythonModeOverride) {
  configureFsSafePython({ mode: "off" });
}

/** True for missing-file errors emitted by Node or fs-safe. */
export function isFileMissingError(
  err: unknown,
): err is NodeJS.ErrnoException & { code: "ENOENT" | "ENOTDIR" | "not-found" } {
  return Boolean(
    err &&
    typeof err === "object" &&
    "code" in err &&
    ((err as Partial<NodeJS.ErrnoException>).code === "ENOENT" ||
      (err as Partial<NodeJS.ErrnoException>).code === "ENOTDIR" ||
      (err as { code?: unknown }).code === "not-found"),
  );
}
