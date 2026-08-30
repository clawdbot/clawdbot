/**
 * Copies authored fields into a record with no inherited properties.
 * Direct normalization would otherwise persist prototype-only input.
 */
export function snapshotOwnCronRecord(record: Record<string, unknown>): Record<string, unknown> {
  const snapshot: Record<string, unknown> = Object.create(null);
  return Object.assign(snapshot, record);
}
