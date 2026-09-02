// Persists per-shard Vitest timing samples for later scheduling.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveShardTimingKey, type VitestShardTimingSpec } from "./vitest-shard-metadata.mts";

const TIMINGS_FILE_ENV_KEY = "OPENCLAW_TEST_PROJECTS_TIMINGS_PATH";
const TIMINGS_DISABLE_ENV_KEY = "OPENCLAW_TEST_PROJECTS_TIMINGS";

function shouldUseShardTimings(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TIMINGS_DISABLE_ENV_KEY] !== "0";
}

function resolveShardTimingsPath(cwd = process.cwd(), env = process.env): string {
  return env[TIMINGS_FILE_ENV_KEY] || path.join(cwd, ".artifacts", "vitest-shard-timings.json");
}

/**
 * Creates a timing sample for completed non-watch Vitest shard runs.
 */
export function createShardTimingSample(spec: VitestShardTimingSpec, durationMs: number) {
  if (spec.watchMode || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }

  const includePatternCount = Array.isArray(spec.includePatterns) ? spec.includePatterns.length : 0;
  return {
    baseConfig: spec.config,
    config: resolveShardTimingKey(spec),
    durationMs,
    includePatternCount,
  };
}

type ShardTimingSample = NonNullable<ReturnType<typeof createShardTimingSample>>;

/**
 * Reads persisted shard timing averages, returning an empty map when disabled.
 */
export function readShardTimings(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Map<string, number> {
  if (!shouldUseShardTimings(env)) {
    return new Map();
  }
  try {
    const raw = fs.readFileSync(resolveShardTimingsPath(cwd, env), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const configs = isRecord(parsed) && isRecord(parsed.configs) ? parsed.configs : null;
    if (!configs) {
      return new Map();
    }
    return new Map(
      Object.entries(configs).flatMap(([config, value]) => {
        if (!isRecord(value)) {
          return [];
        }
        const durationMs = Number(value.averageMs ?? value.durationMs);
        return Number.isFinite(durationMs) && durationMs > 0 ? [[config, durationMs]] : [];
      }),
    );
  } catch {
    return new Map();
  }
}

/**
 * Merges new shard timing samples into the persisted local timing artifact.
 */
export function writeShardTimings(
  samples: Array<ShardTimingSample | null>,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!shouldUseShardTimings(env) || samples.length === 0) {
    return;
  }

  const outputPath = resolveShardTimingsPath(cwd, env);
  let current: unknown = { version: 1, configs: {} };
  try {
    current = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  } catch {
    // First run, or a corrupt local artifact. Rewrite below.
  }

  const configs: Record<string, Record<string, unknown>> = {};
  if (isRecord(current) && isRecord(current.configs)) {
    for (const [config, timing] of Object.entries(current.configs)) {
      if (isRecord(timing)) {
        configs[config] = { ...timing };
      }
    }
  }
  const updatedAt = new Date().toISOString();
  for (const sample of samples) {
    if (
      !sample ||
      !sample.config ||
      !Number.isFinite(sample.durationMs) ||
      sample.durationMs <= 0
    ) {
      continue;
    }
    const previous = configs[sample.config];
    const previousAverage = Number(previous?.averageMs ?? previous?.durationMs);
    const sampleCount = Math.max(0, Number(previous?.sampleCount) || 0) + 1;
    const averageMs =
      Number.isFinite(previousAverage) && previousAverage > 0
        ? Math.round(previousAverage * 0.7 + sample.durationMs * 0.3)
        : Math.round(sample.durationMs);
    configs[sample.config] = {
      averageMs,
      lastMs: Math.round(sample.durationMs),
      sampleCount,
      updatedAt,
      ...(sample.baseConfig && sample.baseConfig !== sample.config
        ? { baseConfig: sample.baseConfig }
        : {}),
      ...(sample.includePatternCount ? { includePatternCount: sample.includePatternCount } : {}),
    };
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify({ version: 1, configs }, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, outputPath);
}
