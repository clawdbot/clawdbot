export function resolveMatrixActionLimit(raw: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(raw !== undefined && Number.isFinite(raw) ? raw : fallback));
}
