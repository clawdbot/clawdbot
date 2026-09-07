// Chokidar forwards native watch failures and directory-scan errors through the same event.
export function getFileWatchCapacityCode(
  error: unknown,
): "EMFILE" | "ENFILE" | "ENOSPC" | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("syscall" in error) ||
    error.syscall !== "watch" ||
    !("code" in error)
  ) {
    return undefined;
  }
  const code = error.code;
  return code === "EMFILE" || code === "ENFILE" || code === "ENOSPC" ? code : undefined;
}
