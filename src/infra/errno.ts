/** Type guard for NodeJS.ErrnoException (any object with a `code` property). */
export function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(err && typeof err === "object" && "code" in err);
}

/** Checks whether an errno-shaped value has the exact code. */
export function hasErrnoCode(err: unknown, code: string): boolean {
  return isErrno(err) && err.code === code;
}

/** Classifies missing filesystem paths across Node and fs-safe boundaries. */
export function isMissingPathError(err: unknown): boolean {
  return (
    hasErrnoCode(err, "ENOENT") || hasErrnoCode(err, "ENOTDIR") || hasErrnoCode(err, "not-found")
  );
}
