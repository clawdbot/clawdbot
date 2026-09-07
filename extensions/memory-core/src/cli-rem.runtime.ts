import fs from "node:fs/promises";
import path from "node:path";
import { resolveMemoryRemDreamingConfig } from "openclaw/plugin-sdk/memory-core-host-status";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { resolveMemoryPluginConfig, withMemoryCommand } from "./cli-runtime-common.js";
import { defaultRuntime, shortenHomePath, theme } from "./cli.host.runtime.js";
import type { MemoryRemBackfillOptions, MemoryRemHarnessOptions } from "./cli.types.js";
import { removeBackfillDiaryEntries, writeBackfillDiaryEntries } from "./dreaming-dreams-file.js";
import { seedHistoricalDailyMemorySignals } from "./dreaming-phases.js";
import type { MemoryCoreRuntimeHost } from "./memory/runtime-host.js";
import { previewGroundedRemMarkdown } from "./rem-evidence.js";
import { previewRemHarness } from "./rem-harness.js";
import { runSessionBackfill, type MemorySessionBackfillOptions } from "./session-backfill.js";
import {
  recordGroundedShortTermCandidates,
  removeGroundedShortTermCandidates,
} from "./short-term-promotion.js";
const { heading, muted, warn } = theme;

export async function runMemorySessionBackfill(
  opts: MemorySessionBackfillOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  await withMemoryCommand({
    commandName: "memory session-backfill",
    agent: opts.agent,
    diagnosticsToStderr: Boolean(opts.json),
    onUnavailable: opts.json ? defaultRuntime.writeJson : undefined,
    purpose: "status",
    ...hostOptions,
    run: async ({ manager, cfg, agentId }) => {
      const workspaceDir = manager.status().workspaceDir?.trim();
      if (!workspaceDir) {
        defaultRuntime.error("Memory session-backfill requires a resolvable workspace directory.");
        process.exitCode = 1;
        return;
      }
      if (
        opts.rollback &&
        (opts.apply || opts.rem || opts.from || opts.to || opts.archiveFiles?.length)
      ) {
        defaultRuntime.error(
          "Memory session-backfill --rollback cannot be combined with input, range, --rem, or --apply options.",
        );
        process.exitCode = 1;
        return;
      }
      const pluginConfig = resolveMemoryPluginConfig(cfg);
      const remConfig = resolveMemoryRemDreamingConfig({
        pluginConfig,
        cfg,
      });
      let result;
      try {
        result = await runSessionBackfill({
          agentId,
          workspaceDir,
          pluginConfig,
          ...(opts.from !== undefined ? { from: opts.from } : {}),
          ...(opts.to !== undefined ? { to: opts.to } : {}),
          ...(opts.limitDays !== undefined ? { limitDays: opts.limitDays } : {}),
          ...(opts.rem !== undefined ? { rem: opts.rem } : {}),
          ...(opts.apply !== undefined ? { apply: opts.apply } : {}),
          ...(opts.rollback !== undefined ? { rollback: opts.rollback } : {}),
          ...(opts.archiveFiles !== undefined ? { archiveFiles: opts.archiveFiles } : {}),
          ...(remConfig.timezone !== undefined ? { timezone: remConfig.timezone } : {}),
        });
      } catch (error) {
        defaultRuntime.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        defaultRuntime.writeJson(result);
        return;
      }
      if (result.rollback) {
        defaultRuntime.log(
          [
            `${heading("Session Backfill")} ${muted("(rollback)")}`,
            muted(`workspace=${shortenHomePath(workspaceDir)}`),
            muted(`removedDiaryEntries=${result.rollback.removedDiaryEntries}`),
            muted(`removedStagedEntries=${result.rollback.removedStagedEntries}`),
          ].join("\n"),
        );
        return;
      }
      const lines = [
        `${heading("Session Backfill")} ${muted(`(${agentId})`)}`,
        muted(`workspace=${shortenHomePath(workspaceDir)}`),
        muted(
          `batches=${result.batchCount ?? 1} days=${result.days.length} candidates=${result.candidateCount} staged=${result.stagedEntries}`,
        ),
      ];
      for (const batch of result.batches ?? []) {
        lines.push(
          muted(
            `batch=${batch.batch} days=${batch.days} candidates=${batch.candidates} staged=${batch.stagedEntries}`,
          ),
        );
      }
      for (const day of result.days) {
        lines.push("", heading(day.day), muted(`candidates=${day.candidateCount}`));
        lines.push(...day.topCandidates.map((candidate) => `- ${candidate}`));
      }
      if (result.days.length === 0) {
        lines.push("", "No new hash-untracked trusted session candidates.");
      }
      if (!result.applied && !result.rem) {
        lines.push("", muted("Dry run; use --apply to stage candidates."));
      }
      defaultRuntime.log(lines.join("\n"));
    },
  });
}

export async function runMemoryRemHarness(
  opts: MemoryRemHarnessOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  await withMemoryCommand({
    commandName: "memory rem-harness",
    agent: opts.agent,
    diagnosticsToStderr: Boolean(opts.json),
    onUnavailable: opts.json ? defaultRuntime.writeJson : undefined,
    purpose: "status",
    ...hostOptions,
    run: async ({ manager, cfg, agentId }) => {
      const status = manager.status();
      const managerWorkspaceDir = status.workspaceDir?.trim();
      const pluginConfig = resolveMemoryPluginConfig(cfg);
      if (!managerWorkspaceDir && !opts.path) {
        defaultRuntime.error("Memory rem-harness requires a resolvable workspace directory.");
        process.exitCode = 1;
        return;
      }
      const remConfig = resolveMemoryRemDreamingConfig({
        pluginConfig,
        cfg,
      });
      const nowMs = Date.now();
      let workspaceDir = managerWorkspaceDir ?? "";
      let sourceFiles: string[] = [];
      let groundedInputPaths: string[] = [];
      let importedFileCount = 0;
      let importedSignalCount = 0;
      let skippedPaths: string[] = [];
      let cleanupWorkspaceDir: string | null = null;
      if (opts.path) {
        const historical = await createHistoricalRemHarnessWorkspace({
          inputPath: opts.path,
          remLimit: remConfig.limit,
          nowMs,
          timezone: remConfig.timezone,
        });
        workspaceDir = historical.workspaceDir;
        cleanupWorkspaceDir = historical.workspaceDir;
        sourceFiles = historical.sourceFiles;
        groundedInputPaths = historical.workspaceSourceFiles;
        importedFileCount = historical.importedFileCount;
        importedSignalCount = historical.importedSignalCount;
        skippedPaths = historical.skippedPaths;
        if (sourceFiles.length === 0) {
          await fs.rm(historical.workspaceDir, { recursive: true, force: true });
          defaultRuntime.error(
            `Memory rem-harness found no YYYY-MM-DD.md files at ${shortenHomePath(path.resolve(opts.path))}.`,
          );
          process.exitCode = 1;
          return;
        }
      }
      if (!workspaceDir) {
        defaultRuntime.error("Memory rem-harness requires a resolvable workspace directory.");
        process.exitCode = 1;
        return;
      }
      try {
        const preview = await previewRemHarness({
          workspaceDir,
          cfg,
          pluginConfig,
          grounded: Boolean(opts.grounded),
          groundedInputPaths,
          includePromoted: Boolean(opts.includePromoted),
          nowMs,
        });
        groundedInputPaths = preview.groundedInputPaths;
        const remPreview = preview.rem;
        const groundedPreview = preview.grounded;
        const deepCandidates = preview.deep.candidates;
        if (opts.json) {
          defaultRuntime.writeJson({
            workspaceDir,
            sourcePath: opts.path ? path.resolve(opts.path) : null,
            sourceFiles,
            historicalImport: opts.path
              ? {
                  importedFileCount,
                  importedSignalCount,
                  skippedPaths,
                }
              : null,
            remConfig: preview.remConfig,
            deepConfig: {
              minScore: preview.deepConfig.minScore,
              minRecallCount: preview.deepConfig.minRecallCount,
              minUniqueQueries: preview.deepConfig.minUniqueQueries,
              recencyHalfLifeDays: preview.deepConfig.recencyHalfLifeDays,
              maxAgeDays: preview.deepConfig.maxAgeDays ?? null,
              maxPromotedSnippetTokens: preview.deepConfig.maxPromotedSnippetTokens,
            },
            rem: { skipped: preview.remSkipped, ...remPreview },
            grounded: groundedPreview,
            deep: {
              candidateCount: preview.deep.candidateCount,
              candidates: deepCandidates,
            },
          });
          return;
        }
        const lines = [
          `${heading("REM Harness")} ${muted(`(${agentId})`)}`,
          muted(`workspace=${shortenHomePath(workspaceDir)}`),
          ...(opts.path
            ? [
                muted(`sourcePath=${shortenHomePath(path.resolve(opts.path))}`),
                muted(
                  `historicalFiles=${sourceFiles.length} importedFiles=${importedFileCount} importedSignals=${importedSignalCount}`,
                ),
                ...(skippedPaths.length > 0
                  ? [
                      warn(
                        `skipped=${skippedPaths.map((entry) => shortenHomePath(entry)).join(", ")}`,
                      ),
                    ]
                  : []),
              ]
            : []),
          ...(opts.grounded
            ? [
                muted(
                  `groundedInputs=${groundedInputPaths.length > 0 ? groundedInputPaths.map((entry) => shortenHomePath(entry)).join(", ") : "none"}`,
                ),
              ]
            : []),
          muted(
            `recentRecallEntries=${preview.recallEntryCount} deepCandidates=${deepCandidates.length}`,
          ),
          "",
          heading("REM Preview"),
          ...remPreview.bodyLines,
          ...(groundedPreview
            ? [
                "",
                heading("Grounded REM"),
                ...groundedPreview.files.flatMap((file) => [
                  muted(file.path),
                  file.renderedMarkdown,
                  "",
                ]),
              ]
            : []),
          "",
          heading("Deep Candidates"),
          ...(deepCandidates.length > 0
            ? deepCandidates
                .slice(0, 10)
                .map(
                  (candidate) =>
                    `${candidate.score.toFixed(3)} ${candidate.snippet} [${shortenHomePath(candidate.path)}:${candidate.startLine}-${candidate.endLine}]`,
                )
            : ["- No deep candidates."]),
        ];
        defaultRuntime.log(lines.join("\n"));
      } finally {
        if (cleanupWorkspaceDir) {
          await fs.rm(cleanupWorkspaceDir, { recursive: true, force: true });
        }
      }
    },
  });
}
export async function runMemoryRemBackfill(
  opts: MemoryRemBackfillOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  await withMemoryCommand({
    commandName: "memory rem-backfill",
    agent: opts.agent,
    diagnosticsToStderr: Boolean(opts.json),
    onUnavailable: opts.json ? defaultRuntime.writeJson : undefined,
    purpose: "status",
    ...hostOptions,
    run: async ({ manager, cfg, agentId }) => {
      const status = manager.status();
      const workspaceDir = status.workspaceDir?.trim();
      const pluginConfig = resolveMemoryPluginConfig(cfg);
      const remConfig = resolveMemoryRemDreamingConfig({
        pluginConfig,
        cfg,
      });
      if (!workspaceDir) {
        defaultRuntime.error("Memory rem-backfill requires a resolvable workspace directory.");
        process.exitCode = 1;
        return;
      }
      if (opts.rollback || opts.rollbackShortTerm) {
        const diaryRollback = opts.rollback
          ? await removeBackfillDiaryEntries({ workspaceDir })
          : null;
        const shortTermRollback = opts.rollbackShortTerm
          ? await removeGroundedShortTermCandidates({ workspaceDir })
          : null;
        if (opts.json) {
          defaultRuntime.writeJson({
            workspaceDir,
            rollback: Boolean(opts.rollback),
            rollbackShortTerm: Boolean(opts.rollbackShortTerm),
            ...(diaryRollback
              ? {
                  dreamsPath: diaryRollback.dreamsPath,
                  removedEntries: diaryRollback.removed,
                }
              : {}),
            ...(shortTermRollback
              ? {
                  shortTermStorePath: shortTermRollback.storePath,
                  removedShortTermEntries: shortTermRollback.removed,
                }
              : {}),
          });
          return;
        }
        defaultRuntime.log(
          [
            `${heading("REM Backfill")} ${muted("(rollback)")}`,
            muted(`workspace=${shortenHomePath(workspaceDir)}`),
            ...(diaryRollback
              ? [
                  muted(`dreamsPath=${shortenHomePath(diaryRollback.dreamsPath)}`),
                  muted(`removedEntries=${diaryRollback.removed}`),
                ]
              : []),
            ...(shortTermRollback
              ? [
                  muted(`shortTermStorePath=${shortenHomePath(shortTermRollback.storePath)}`),
                  muted(`removedShortTermEntries=${shortTermRollback.removed}`),
                ]
              : []),
          ].join("\n"),
        );
        return;
      }
      if (!opts.path) {
        defaultRuntime.error(
          "Memory rem-backfill requires --path <file-or-dir> unless using --rollback.",
        );
        process.exitCode = 1;
        return;
      }
      const scratchDir = await fs.mkdtemp(
        path.join(resolvePreferredOpenClawTmpDir(), "openclaw-rem-backfill-"),
      );
      try {
        const sourceFiles = await listHistoricalDailyFiles(opts.path);
        if (sourceFiles.length === 0) {
          defaultRuntime.error(
            `Memory rem-backfill found no YYYY-MM-DD.md files at ${shortenHomePath(path.resolve(opts.path))}.`,
          );
          process.exitCode = 1;
          return;
        }
        const scratchMemoryDir = path.join(scratchDir, "memory");
        await fs.mkdir(scratchMemoryDir, { recursive: true });
        const workspaceSourceFiles: string[] = [];
        for (const filePath of sourceFiles) {
          const dst = path.join(scratchMemoryDir, path.basename(filePath));
          await fs.copyFile(filePath, dst);
          workspaceSourceFiles.push(dst);
        }
        const grounded = await previewGroundedRemMarkdown({
          workspaceDir: scratchDir,
          inputPaths: workspaceSourceFiles,
        });
        const sourcePathByScratchRelativePath = new Map(
          workspaceSourceFiles.map(
            (scratchPath, index) =>
              [
                normalizeRelativePath(scratchDir, scratchPath),
                sourceFiles[index] ?? scratchPath,
              ] as const,
          ),
        );
        const entries = grounded.files
          .map((file) => {
            const isoDay = extractIsoDayFromPath(file.path);
            if (!isoDay) {
              return null;
            }
            return {
              isoDay,
              sourcePath: sourcePathByScratchRelativePath.get(file.path) ?? file.path,
              bodyLines: groundedMarkdownToDiaryLines(file.renderedMarkdown),
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
        const written = await writeBackfillDiaryEntries({
          workspaceDir,
          entries,
          timezone: remConfig.timezone,
        });
        let stagedShortTermEntries = 0;
        let replacedShortTermEntries = 0;
        if (opts.stageShortTerm) {
          const cleared = await removeGroundedShortTermCandidates({ workspaceDir });
          replacedShortTermEntries = cleared.removed;
          const shortTermSeedItems = collectGroundedShortTermSeedItems(grounded.files);
          if (shortTermSeedItems.length > 0) {
            await recordGroundedShortTermCandidates({
              workspaceDir,
              query: "__dreaming_grounded_backfill__",
              items: shortTermSeedItems,
              dedupeByQueryPerDay: true,
              nowMs: Date.now(),
              timezone: remConfig.timezone,
            });
          }
          stagedShortTermEntries = shortTermSeedItems.length;
        }
        if (opts.json) {
          defaultRuntime.writeJson({
            workspaceDir,
            sourcePath: path.resolve(opts.path),
            sourceFiles,
            groundedFiles: grounded.scannedFiles,
            writtenEntries: written.written,
            replacedEntries: written.replaced,
            dreamsPath: written.dreamsPath,
            ...(opts.stageShortTerm
              ? {
                  stagedShortTermEntries,
                  replacedShortTermEntries,
                }
              : {}),
          });
          return;
        }
        defaultRuntime.log(
          [
            `${heading("REM Backfill")} ${muted(`(${agentId})`)}`,
            muted(`workspace=${shortenHomePath(workspaceDir)}`),
            muted(`sourcePath=${shortenHomePath(path.resolve(opts.path))}`),
            muted(
              `historicalFiles=${sourceFiles.length} writtenEntries=${written.written} replacedEntries=${written.replaced}`,
            ),
            ...(opts.stageShortTerm
              ? [
                  muted(
                    `stagedShortTermEntries=${stagedShortTermEntries} replacedShortTermEntries=${replacedShortTermEntries}`,
                  ),
                ]
              : []),
            muted(`dreamsPath=${shortenHomePath(written.dreamsPath)}`),
          ].join("\n"),
        );
      } finally {
        await fs.rm(scratchDir, { recursive: true, force: true });
      }
    },
  });
}
const DAILY_MEMORY_FILE_NAME_RE = /^(\d{4}-\d{2}-\d{2})(?:-[^/]+)?\.md$/i;
async function listHistoricalDailyFiles(inputPath: string): Promise<string[]> {
  const resolvedPath = path.resolve(inputPath);
  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  if (stat.isFile()) {
    return DAILY_MEMORY_FILE_NAME_RE.test(path.basename(resolvedPath)) ? [resolvedPath] : [];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && DAILY_MEMORY_FILE_NAME_RE.test(entry.name))
    .map((entry) => path.join(resolvedPath, entry.name))
    .toSorted((a, b) => path.basename(a).localeCompare(path.basename(b)));
}
async function createHistoricalRemHarnessWorkspace(params: {
  inputPath: string;
  remLimit: number;
  nowMs: number;
  timezone?: string;
}): Promise<{
  workspaceDir: string;
  sourceFiles: string[];
  workspaceSourceFiles: string[];
  importedFileCount: number;
  importedSignalCount: number;
  skippedPaths: string[];
}> {
  const sourceFiles = await listHistoricalDailyFiles(params.inputPath);
  const workspaceDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-rem-harness-"),
  );
  const memoryDir = path.join(workspaceDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });
  for (const filePath of sourceFiles) {
    await fs.copyFile(filePath, path.join(memoryDir, path.basename(filePath)));
  }
  const workspaceSourceFiles = sourceFiles.map((entry) =>
    path.join(memoryDir, path.basename(entry)),
  );
  const seeded = await seedHistoricalDailyMemorySignals({
    workspaceDir,
    filePaths: workspaceSourceFiles,
    limit: params.remLimit,
    nowMs: params.nowMs,
    timezone: params.timezone,
  });
  return {
    workspaceDir,
    sourceFiles,
    workspaceSourceFiles,
    importedFileCount: seeded.importedFileCount,
    importedSignalCount: seeded.importedSignalCount,
    skippedPaths: seeded.skippedPaths,
  };
}
function extractIsoDayFromPath(filePath: string): string | null {
  const match = path.basename(filePath).match(DAILY_MEMORY_FILE_NAME_RE);
  return match?.[1] ?? null;
}
function normalizeRelativePath(baseDir: string, filePath: string): string {
  return path.relative(baseDir, filePath).replace(/\\/g, "/");
}
function groundedMarkdownToDiaryLines(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.replace(/^##\s+/, "").trimEnd())
    .filter((line, index, lines) => !(line.length === 0 && lines[index - 1]?.length === 0));
}
function parseGroundedRef(
  fallbackPath: string,
  ref: string,
): { path: string; startLine: number; endLine: number } | null {
  const trimmed = ref.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^(.*?):(\d+)(?:-(\d+))?$/);
  if (!match) {
    return null;
  }
  return {
    path: (match[1] ?? fallbackPath).replaceAll("\\", "/").replace(/^\.\//, ""),
    startLine: Math.max(1, Number(match[2])),
    endLine: Math.max(1, Number(match[3] ?? match[2])),
  };
}
function collectGroundedShortTermSeedItems(
  previews: Awaited<ReturnType<typeof previewGroundedRemMarkdown>>["files"],
): Array<{
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  query: string;
  signalCount: number;
  dayBucket?: string;
}> {
  const items: Array<{
    path: string;
    startLine: number;
    endLine: number;
    snippet: string;
    score: number;
    query: string;
    signalCount: number;
    dayBucket?: string;
  }> = [];
  const seen = new Set<string>();
  for (const file of previews) {
    const dayBucket = extractIsoDayFromPath(file.path) ?? undefined;
    const signals = [
      ...file.memoryImplications.map((item) => ({
        text: item.text,
        refs: item.refs,
        score: 0.92,
        query: "__dreaming_grounded_backfill__:lasting-update",
        signalCount: 2,
      })),
      ...file.candidates
        .filter((candidate) => candidate.lean === "likely_durable")
        .map((candidate) => ({
          text: candidate.text,
          refs: candidate.refs,
          score: 0.82,
          query: "__dreaming_grounded_backfill__:candidate",
          signalCount: 1,
        })),
    ];
    for (const signal of signals) {
      if (!signal.text.trim()) {
        continue;
      }
      const firstRef = signal.refs.find((ref) => ref.trim().length > 0);
      const parsedRef = firstRef ? parseGroundedRef(file.path, firstRef) : null;
      if (!parsedRef) {
        continue;
      }
      const key = `${parsedRef.path}:${parsedRef.startLine}:${parsedRef.endLine}:${signal.query}:${signal.text.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push({
        path: parsedRef.path,
        startLine: parsedRef.startLine,
        endLine: parsedRef.endLine,
        snippet: signal.text,
        score: signal.score,
        query: signal.query,
        signalCount: signal.signalCount,
        ...(dayBucket ? { dayBucket } : {}),
      });
    }
  }
  return items;
}
