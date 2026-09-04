const WATCH_CAPACITY_CODES = new Set(["EMFILE", "ENFILE", "ENOSPC"]);

export function getMemoryWatchCapacityCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return null;
  }
  return typeof err.code === "string" && WATCH_CAPACITY_CODES.has(err.code) ? err.code : null;
}
