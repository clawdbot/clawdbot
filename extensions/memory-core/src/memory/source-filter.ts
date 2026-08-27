// Memory Core source filtering shared by the manager and subprocess request validation tests.
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export function buildMemorySourceFilter(
  alias: string | undefined,
  sources: readonly MemorySource[],
): { sql: string; params: MemorySource[] } {
  if (sources.length === 0) {
    return { sql: "", params: [] };
  }
  const column = alias ? `${alias}.source` : "source";
  const placeholders = sources.map(() => "?").join(", ");
  return { sql: ` AND ${column} IN (${placeholders})`, params: [...sources] };
}
