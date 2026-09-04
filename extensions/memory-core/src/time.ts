export function resolveMemoryCoreNowMs(nowMs?: number): number {
  const candidate = nowMs ?? Number.NaN;
  return new Date(candidate).toJSON() === null ? Date.now() : candidate;
}

export function resolveMemoryCoreTimestamp(nowMs?: number): string {
  const timestampMs = resolveMemoryCoreNowMs(nowMs);
  return new Date(timestampMs).toJSON() ?? new Date().toISOString();
}
