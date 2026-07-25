/**
 * Resolves the stable timing key for a Vitest shard specification.
 */
export function resolveShardTimingKey(spec: unknown): unknown;
/**
 * Creates a timing sample for completed non-watch Vitest shard runs.
 */
export function createShardTimingSample(
  spec: unknown,
  durationMs: unknown,
): {
  baseConfig: unknown;
  config: unknown;
  durationMs: unknown;
  includePatternCount: unknown;
} | null;
/**
 * Reads persisted shard timing averages, returning an empty map when disabled.
 */
export function readShardTimings(cwd?: string, env?: NodeJS.ProcessEnv): Map<unknown, unknown>;
/**
 * Merges new shard timing samples into the persisted local timing artifact.
 */
export function writeShardTimings(samples: unknown, cwd?: string, env?: NodeJS.ProcessEnv): void;
