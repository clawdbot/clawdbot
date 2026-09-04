export function resolveMemoryWikiTimestamp(nowMs?: number): string {
  return (
    new Date(nowMs ?? Date.now()).toJSON() ??
    new Date(Date.now()).toJSON() ??
    new Date().toISOString()
  );
}
