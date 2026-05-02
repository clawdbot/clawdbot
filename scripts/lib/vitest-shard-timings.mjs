import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TIMINGS_FILE_ENV_KEY = "OPENCLAW_TEST_PROJECTS_TIMINGS_PATH";
const TIMINGS_DISABLE_ENV_KEY = "OPENCLAW_TEST_PROJECTS_TIMINGS";
const SHARD_NAME_ENV_KEY = "OPENCLAW_VITEST_SHARD_NAME";

function sanitizeTimingLabel(value) {
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hashIncludePatterns(includePatterns) {
  return createHash("sha1").update(JSON.stringify(includePatterns)).digest("hex").slice(0, 12);
}

function shouldUseShardTimings(env = process.env) {
  return env[TIMINGS_DISABLE_ENV_KEY] !== "0";
}

function resolveShardTimingsPath(cwd = process.cwd(), env = process.env) {
  return env[TIMINGS_FILE_ENV_KEY] || path.join(cwd, ".artifacts", "vitest-shard-timings.json");
}

export function resolveShardTimingKey(spec) {
  if (!Array.isArray(spec.includePatterns) || spec.includePatterns.length === 0) {
    return spec.config;
  }

  const shardName = sanitizeTimingLabel(spec.env?.[SHARD_NAME_ENV_KEY] ?? "");
  if (shardName) {
    return `${spec.config}#${shardName}`;
  }

  return `${spec.config}#include-${spec.includePatterns.length}-${hashIncludePatterns(
    spec.includePatterns,
  )}`;
}

export function createShardTimingSample(spec, durationMs) {
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

export function readShardTimings(cwd = process.cwd(), env = process.env) {
  if (!shouldUseShardTimings(env)) {
    return new Map();
  }
  try {
    const raw = fs.readFileSync(resolveShardTimingsPath(cwd, env), "utf8");
    const parsed = JSON.parse(raw);
    const configs = parsed && typeof parsed === "object" ? parsed.configs : null;
    if (!configs || typeof configs !== "object") {
      return new Map();
    }
    return new Map(
      Object.entries(configs)
        .map(([config, value]) => {
          const durationMs = Number(value?.averageMs ?? value?.durationMs);
          return Number.isFinite(durationMs) && durationMs > 0 ? [config, durationMs] : null;
        })
        .filter(Boolean),
    );
  } catch {
    return new Map();
  }
}

export function writeShardTimings(samples, cwd = process.cwd(), env = process.env) {
  if (!shouldUseShardTimings(env) || samples.length === 0) {
    return;
  }

  const outputPath = resolveShardTimingsPath(cwd, env);
  let current = { version: 1, configs: {} };
  try {
    current = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  } catch {
    // First run, or a corrupt local artifact. Rewrite below.
  }

  const configs =
    current && typeof current === "object" && current.configs && typeof current.configs === "object"
      ? { ...current.configs }
      : {};
  const updatedAt = new Date().toISOString();
  for (const sample of samples) {
    if (!sample.config || !Number.isFinite(sample.durationMs) || sample.durationMs <= 0) {
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
