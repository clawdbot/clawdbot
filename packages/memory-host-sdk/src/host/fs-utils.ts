import { configureFsSafeNative } from "@openclaw/fs-safe/config";
// fs-safe facade with native acceleration disabled by default for this package's
// host-side memory file operations.
export { root } from "@openclaw/fs-safe/root";
export { isPathInside, isPathInsideWithRealpath } from "@openclaw/fs-safe/path";
export {
  assertNoSymlinkParents,
  readRegularFile,
  statRegularFile,
} from "@openclaw/fs-safe/advanced";
export { walkDirectory, type WalkDirectoryEntry } from "@openclaw/fs-safe/walk";

const hasModeOverride = Object.keys(process.env).some((key) =>
  /^(?:OPENCLAW_)?FS_SAFE_(?:NATIVE|PYTHON)_MODE$/u.test(
    process.platform === "win32" ? key.toUpperCase() : key,
  ),
);

if (!hasModeOverride) {
  configureFsSafeNative({ mode: "off" });
}

/**
 * True for missing-file errors emitted by Node or fs-safe.
 * The narrowed union stays stable; extra-path authorization handles `not-file` separately.
 */
export function isFileMissingError(
  err: unknown,
): err is NodeJS.ErrnoException & { code: "ENOENT" | "ENOTDIR" | "not-file" | "not-found" } {
  if (!err || typeof err !== "object" || !("code" in err)) {
    return false;
  }
  return (
    err.code === "ENOENT" ||
    err.code === "ENOTDIR" ||
    err.code === "not-file" ||
    err.code === "not-found"
  );
}
