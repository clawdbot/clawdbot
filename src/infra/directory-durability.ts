import { syncDirectory, type DirectorySyncOutcome } from "@openclaw/fs-safe/durability";

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EINVAL" ||
    code === "ENOTSUP" ||
    code === "ENOSYS" ||
    (process.platform === "win32" && (code === "EISDIR" || code === "EPERM" || code === "EACCES"))
  );
}

/** Compatibility adapter for former best-effort call sites; crash commits use syncDirectory. */
export async function syncDirectoryIfSupported(
  directoryPath: string,
): Promise<DirectorySyncOutcome> {
  try {
    return await syncDirectory(directoryPath);
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) {
      throw error;
    }
    const code = (error as NodeJS.ErrnoException).code;
    return code ? { status: "unsupported", code } : { status: "unsupported" };
  }
}
