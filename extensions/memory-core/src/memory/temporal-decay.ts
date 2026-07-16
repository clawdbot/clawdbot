import fs from "node:fs/promises";
import path from "node:path";

export type TemporalDecayConfig = {
  enabled: boolean;
  halfLifeDays: number;
};

export const DEFAULT_TEMPORAL_DECAY_CONFIG: TemporalDecayConfig = {
  enabled: false,
  halfLifeDays: 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DATED_MEMORY_PATH_RE = /(?:^|\/)memory\/(\d{4})-(\d{2})-(\d{2})\.md$/;

export function toDecayLambda(halfLifeDays: number): number {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    return 0;
  }
  return Math.LN2 / halfLifeDays;
}

export function calculateTemporalDecayMultiplier(params: {
  ageInDays: number;
  halfLifeDays: number;
}): number {
  const lambda = toDecayLambda(params.halfLifeDays);
  const clampedAge = Math.max(0, params.ageInDays);
  if (lambda <= 0 || !Number.isFinite(clampedAge)) {
    return 1;
  }
  return Math.exp(-lambda * clampedAge);
}

export function applyTemporalDecayToScore(params: {
  score: number;
  ageInDays: number;
  halfLifeDays: number;
}): number {
  return params.score * calculateTemporalDecayMultiplier(params);
}

function parseMemoryDateFromPath(filePath: string): Date | null {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const match = DATED_MEMORY_PATH_RE.exec(normalized);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return parsed;
}

function isEvergreenMemoryPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === "MEMORY.md" || normalized === "memory.md") {
    return true;
  }
  if (!normalized.startsWith("memory/")) {
    return false;
  }
  return !DATED_MEMORY_PATH_RE.test(normalized);
}

async function extractTimestamp(params: {
  filePath: string;
  source?: string;
  workspaceDir?: string;
}): Promise<Date | null> {
  const fromPath = parseMemoryDateFromPath(params.filePath);
  if (fromPath) {
    return fromPath;
  }

  // Memory root/topic files are evergreen knowledge and should not decay.
  if (params.source === "memory" && isEvergreenMemoryPath(params.filePath)) {
    return null;
  }

  if (!params.workspaceDir) {
    return null;
  }

  const absolutePath = path.isAbsolute(params.filePath)
    ? params.filePath
    : path.resolve(params.workspaceDir, params.filePath);

  try {
    const stat = await fs.stat(absolutePath);
    if (!Number.isFinite(stat.mtimeMs)) {
      return null;
    }
    return new Date(stat.mtimeMs);
  } catch {
    return null;
  }
}

function ageInDaysFromTimestamp(timestamp: Date, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - timestamp.getTime());
  return ageMs / DAY_MS;
}

export async function applyTemporalDecayToHybridResults<
  T extends { path: string; score: number; source: string },
>(params: {
  results: T[];
  temporalDecay?: Partial<TemporalDecayConfig>;
  workspaceDir?: string;
  nowMs?: number;
}): Promise<T[]> {
  const config = { ...DEFAULT_TEMPORAL_DECAY_CONFIG, ...params.temporalDecay };
  if (!config.enabled) {
    return [...params.results];
  }

  const nowMs = params.nowMs ?? Date.now();
  const timestampPromiseCache = new Map<string, Promise<Date | null>>();

  return Promise.all(
    params.results.map(async (entry) => {
      const cacheKey = `${entry.source}:${entry.path}`;
      let timestampPromise = timestampPromiseCache.get(cacheKey);
      if (!timestampPromise) {
        timestampPromise = extractTimestamp({
          filePath: entry.path,
          source: entry.source,
          workspaceDir: params.workspaceDir,
        });
        timestampPromiseCache.set(cacheKey, timestampPromise);
      }

      const timestamp = await timestampPromise;
      if (!timestamp) {
        return entry;
      }

      const decayedScore = applyTemporalDecayToScore({
        score: entry.score,
        ageInDays: ageInDaysFromTimestamp(timestamp, nowMs),
        halfLifeDays: config.halfLifeDays,
      });

      return {
        ...entry,
        score: decayedScore,
      };
    }),
  );
}
