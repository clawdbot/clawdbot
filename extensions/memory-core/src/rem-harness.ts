import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  resolveMemoryDeepDreamingConfig,
  resolveMemoryRemDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import {
  filterRecallEntriesWithinLookback,
  previewRemDreaming,
  type RemDreamingPreview,
} from "./dreaming-phases.js";
import { previewGroundedRemMarkdown, type GroundedRemPreviewResult } from "./rem-evidence.js";
import {
  rankShortTermPromotionCandidates,
  readShortTermRecallEntries,
  type PromotionCandidate,
} from "./short-term-promotion.js";

const DAILY_MEMORY_FILE_NAME_RE = /^\d{4}-\d{2}-\d{2}\.md$/i;

type MemoryRemHarnessRemConfig = ReturnType<typeof resolveMemoryRemDreamingConfig>;
type MemoryRemHarnessDeepConfig = ReturnType<typeof resolveMemoryDeepDreamingConfig>;

export type PreviewRemHarnessOptions = {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  grounded?: boolean;
  groundedInputPaths?: string[];
  groundedFileLimit?: number;
  includePromoted?: boolean;
  candidateLimit?: number;
  remPreviewLimit?: number;
  nowMs?: number;
};

export type PreviewRemHarnessResult = {
  workspaceDir: string;
  nowMs: number;
  remConfig: MemoryRemHarnessRemConfig;
  deepConfig: MemoryRemHarnessDeepConfig;
  recallEntryCount: number;
  remSkipped: boolean;
  rem: RemDreamingPreview;
  groundedInputPaths: string[];
  grounded: GroundedRemPreviewResult | null;
  deep: {
    candidateLimit?: number;
    candidateCount: number;
    truncated: boolean;
    candidates: PromotionCandidate[];
  };
};

function normalizeOptionalPositiveLimit(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function resolveRemPreviewLimit(configLimit: number, cap: number | undefined): number {
  if (configLimit <= 0) {
    return 0;
  }
  if (typeof cap !== "number" || !Number.isFinite(cap)) {
    return configLimit;
  }
  return Math.max(0, Math.min(configLimit, Math.floor(cap)));
}

function createSkippedRemPreview(): RemDreamingPreview {
  return {
    sourceEntryCount: 0,
    reflections: [],
    candidateTruths: [],
    candidateKeys: [],
    bodyLines: [],
  };
}

async function listWorkspaceDailyFiles(workspaceDir: string, limit?: number): Promise<string[]> {
  const memoryDir = path.join(workspaceDir, "memory");
  let entries: string[] = [];
  try {
    const dirEntries = await fs.readdir(memoryDir, { withFileTypes: true });
    entries = dirEntries
      .filter((entry) => entry.isFile() && DAILY_MEMORY_FILE_NAME_RE.test(entry.name))
      .map((entry) => entry.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const files = entries
    .map((name) => path.join(memoryDir, name))
    .toSorted((left, right) => left.localeCompare(right));
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0 || files.length <= limit) {
    return files;
  }
  return files.slice(-Math.floor(limit));
}

function resolveGroundedFileLimit(
  configLimit: number,
  cap: number | undefined,
): number | undefined {
  if (typeof cap !== "number" || !Number.isFinite(cap)) {
    return configLimit;
  }
  const normalizedCap = Math.max(1, Math.floor(cap));
  return configLimit > 0 ? Math.min(configLimit, normalizedCap) : normalizedCap;
}

export async function previewRemHarness(
  params: PreviewRemHarnessOptions,
): Promise<PreviewRemHarnessResult> {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const remConfig = resolveMemoryRemDreamingConfig({
    pluginConfig: params.pluginConfig,
    cfg: params.cfg,
  });
  const deepConfig = resolveMemoryDeepDreamingConfig({
    pluginConfig: params.pluginConfig,
    cfg: params.cfg,
  });
  const allRecallEntries = await readShortTermRecallEntries({
    workspaceDir: params.workspaceDir,
    nowMs,
  });
  const recallEntries = filterRecallEntriesWithinLookback({
    entries: allRecallEntries,
    nowMs,
    lookbackDays: remConfig.lookbackDays,
  });
  const remPreviewLimit = resolveRemPreviewLimit(remConfig.limit, params.remPreviewLimit);
  const remSkipped = remConfig.limit <= 0 || remPreviewLimit <= 0;
  const rem = remSkipped
    ? createSkippedRemPreview()
    : previewRemDreaming({
        entries: recallEntries,
        limit: remPreviewLimit,
        minPatternStrength: remConfig.minPatternStrength,
      });

  let groundedInputPaths = params.groundedInputPaths ?? [];
  let grounded: GroundedRemPreviewResult | null = null;
  if (params.grounded) {
    if (groundedInputPaths.length === 0) {
      groundedInputPaths = await listWorkspaceDailyFiles(
        params.workspaceDir,
        resolveGroundedFileLimit(remConfig.limit, params.groundedFileLimit),
      );
    }
    grounded =
      groundedInputPaths.length > 0
        ? await previewGroundedRemMarkdown({
            workspaceDir: params.workspaceDir,
            inputPaths: groundedInputPaths,
          })
        : null;
  }

  const candidateLimit = normalizeOptionalPositiveLimit(params.candidateLimit);
  const rankedCandidates = await rankShortTermPromotionCandidates({
    workspaceDir: params.workspaceDir,
    minScore: 0,
    minRecallCount: 0,
    minUniqueQueries: 0,
    includePromoted: Boolean(params.includePromoted),
    recencyHalfLifeDays: deepConfig.recencyHalfLifeDays,
    maxAgeDays: deepConfig.maxAgeDays,
    nowMs,
    ...(candidateLimit ? { limit: candidateLimit + 1 } : {}),
  });
  const truncated = typeof candidateLimit === "number" && rankedCandidates.length > candidateLimit;
  const candidates =
    typeof candidateLimit === "number"
      ? rankedCandidates.slice(0, candidateLimit)
      : rankedCandidates;

  return {
    workspaceDir: params.workspaceDir,
    nowMs,
    remConfig,
    deepConfig,
    recallEntryCount: recallEntries.length,
    remSkipped,
    rem,
    groundedInputPaths,
    grounded,
    deep: {
      ...(candidateLimit ? { candidateLimit } : {}),
      candidateCount: candidates.length,
      truncated,
      candidates,
    },
  };
}
