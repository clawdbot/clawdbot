import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
  formatMemoryDreamingDay,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { appendMemoryHostEvent } from "openclaw/plugin-sdk/memory-host-events";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { compactMemoryForBudget, DEFAULT_MEMORY_FILE_MAX_CHARS } from "./memory-budget.js";
import { rehydratePromotionCandidate } from "./short-term-promotion-rehydrate.js";
import { readStore, withShortTermLock, writeStore } from "./short-term-promotion-store.js";
import {
  DEFAULT_PROMOTION_MIN_RECALL_COUNT,
  DEFAULT_PROMOTION_MIN_SCORE,
  DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
  type ApplyShortTermPromotionsOptions,
  type ApplyShortTermPromotionsResult,
  type PromotionCandidate,
} from "./short-term-promotion-types.js";
import {
  isContaminatedDreamingSnippet,
  normalizeSnippet,
  toFiniteNonNegativeInt,
  toFiniteScore,
} from "./short-term-promotion-utils.js";
import { resolveMemoryCoreNowMs, resolveMemoryCoreTimestamp } from "./time.js";

const PROMOTION_MARKER_PREFIX = "openclaw-memory-promotion:";
const PROMOTED_SNIPPET_CHARS_PER_TOKEN_ESTIMATE = 4;

function buildPromotionSection(
  candidates: PromotionCandidate[],
  nowMs: number,
  timezone?: string,
  maxPromotedSnippetTokens = DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
): string {
  const sectionDate = formatMemoryDreamingDay(nowMs, timezone);
  const lines = ["", `## Promoted From Short-Term Memory (${sectionDate})`, ""];

  for (const candidate of candidates) {
    const source = `${candidate.path}:${candidate.startLine}-${candidate.endLine}`;
    const metadata = `[score=${candidate.score.toFixed(3)} signals=${candidate.signalCount} recalls=${candidate.recallCount} avg=${candidate.avgScore.toFixed(3)} source=${source}]`;
    lines.push(`<!-- ${PROMOTION_MARKER_PREFIX}${candidate.key} -->`);
    // Cap only the visible MEMORY.md text. The recall store keeps the full
    // rehydrated snippet so ranking, provenance, and dream narratives remain
    // tied to the source entry instead of this presentation budget.
    lines.push(
      `- ${formatPromotedSnippetForMemory(candidate.snippet, maxPromotedSnippetTokens)} ${metadata}`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

function resolvePromotedSnippetCharLimit(maxTokens: number): number {
  const tokenLimit = toFiniteNonNegativeInt(
    maxTokens,
    DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
  );
  // This is an inexpensive display-size guard, not a tokenizer contract.
  return tokenLimit * PROMOTED_SNIPPET_CHARS_PER_TOKEN_ESTIMATE;
}

function truncatePromotedSnippet(snippet: string, maxTokens: number): string {
  const limit = resolvePromotedSnippetCharLimit(maxTokens);
  if (limit === 0 || snippet.length <= limit) {
    return snippet;
  }
  const hardLimit = truncateUtf16Safe(snippet, limit);
  const sentenceBoundary = Math.max(
    hardLimit.lastIndexOf(". "),
    hardLimit.lastIndexOf("! "),
    hardLimit.lastIndexOf("? "),
  );
  const wordBoundary = hardLimit.lastIndexOf(" ");
  const cutAt =
    sentenceBoundary >= Math.floor(limit * 0.55)
      ? sentenceBoundary + 1
      : wordBoundary >= Math.floor(limit * 0.65)
        ? wordBoundary
        : limit;
  return `${hardLimit.slice(0, cutAt).trimEnd()}...`;
}

function formatPromotedSnippetForMemory(rawSnippet: string, maxTokens: number): string {
  const normalized = normalizeSnippet(rawSnippet || "(no snippet captured)")
    .replace(/^[-*+] +/, "")
    .trim();
  return truncatePromotedSnippet(normalized || "(no snippet captured)", maxTokens);
}

function withTrailingNewline(content: string): string {
  if (!content) {
    return "";
  }
  return content.endsWith("\n") ? content : `${content}\n`;
}

async function resolveMemoryWritePath(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch (err) {
    const hasTrailingSeparator =
      filePath.endsWith(path.sep) ||
      (process.platform === "win32" && filePath.endsWith(path.posix.sep));
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT" || hasTrailingSeparator) {
      throw err;
    }
  }

  // Canonicalize each parent before applying a relative link target. Lexical
  // normalization would change `..` semantics when an earlier component is a symlink.
  const parentPath = await fs.realpath(path.dirname(filePath));
  const canonicalPath = path.join(parentPath, path.basename(filePath));
  let linkTarget: string;
  try {
    linkTarget = await fs.readlink(canonicalPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "EINVAL") {
      return canonicalPath;
    }
    throw err;
  }
  const isWindowsRootRelative = process.platform === "win32" && /^[\\/](?![\\/])/.test(linkTarget);
  const targetPath = isWindowsRootRelative
    ? `${path.parse(parentPath).root.replace(/[\\/]$/, "")}${linkTarget}`
    : path.isAbsolute(linkTarget)
      ? linkTarget
      : `${parentPath}${parentPath.endsWith(path.sep) ? "" : path.sep}${linkTarget}`;
  return await resolveMemoryWritePath(targetPath);
}

function isAtomicReplacePermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EACCES" || code === "EPERM" || code === "EEXIST" || code === "EROFS";
}

async function writeExistingMemoryInPlace(filePath: string, content: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, "r+");
  } catch {
    return false;
  }
  try {
    await handle.writeFile(content, { encoding: "utf-8" });
    await handle.truncate(Buffer.byteLength(content));
    await handle.sync();
    return true;
  } finally {
    await handle.close();
  }
}

function extractPromotionMarkers(memoryText: string): Set<string> {
  const markers = new Set<string>();
  // Marker keys include source paths, so spaces are valid. Capture until the
  // comment close; otherwise a path like "memory/project alpha/..." is missed
  // and the same candidate can be appended again.
  const matches = memoryText.matchAll(/<!--\s*openclaw-memory-promotion:([^\n]*?)\s*-->/gi);
  for (const match of matches) {
    const key = match[1]?.trim();
    if (key) {
      markers.add(key);
    }
  }
  return markers;
}

export async function applyShortTermPromotions(
  options: ApplyShortTermPromotionsOptions,
): Promise<ApplyShortTermPromotionsResult> {
  const workspaceDir = options.workspaceDir.trim();
  const nowMs = resolveMemoryCoreNowMs(options.nowMs);
  const nowIso = resolveMemoryCoreTimestamp(nowMs);
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.floor(options.limit as number))
    : options.candidates.length;
  const minScore = toFiniteScore(options.minScore, DEFAULT_PROMOTION_MIN_SCORE);
  const minRecallCount = toFiniteNonNegativeInt(
    options.minRecallCount,
    DEFAULT_PROMOTION_MIN_RECALL_COUNT,
  );
  const minUniqueQueries = toFiniteNonNegativeInt(
    options.minUniqueQueries,
    DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
  );
  const maxAgeDays = toFiniteNonNegativeInt(options.maxAgeDays, -1);
  const memoryPath = path.join(workspaceDir, "MEMORY.md");

  return await withShortTermLock(workspaceDir, async () => {
    const store = await readStore(workspaceDir, nowIso);
    const selected = options.candidates
      .filter((candidate) => {
        if (isContaminatedDreamingSnippet(candidate.snippet)) {
          return false;
        }
        if (candidate.promotedAt) {
          return false;
        }
        if (candidate.score < minScore) {
          return false;
        }
        if (candidate.signalCount < minRecallCount) {
          return false;
        }
        if (Math.max(candidate.uniqueQueries, candidate.recallDays.length) < minUniqueQueries) {
          return false;
        }
        if (maxAgeDays >= 0 && candidate.ageDays > maxAgeDays) {
          return false;
        }
        const latest = store.entries[candidate.key];
        if (latest?.promotedAt) {
          return false;
        }
        return true;
      })
      .slice(0, limit);

    const rehydratedSelected: PromotionCandidate[] = [];
    for (const candidate of selected) {
      const rehydrated = await rehydratePromotionCandidate(workspaceDir, candidate);
      if (rehydrated && !isContaminatedDreamingSnippet(rehydrated.snippet)) {
        rehydratedSelected.push(rehydrated);
      }
    }

    if (rehydratedSelected.length === 0) {
      return {
        memoryPath,
        applied: 0,
        appended: 0,
        reconciledExisting: 0,
        appliedCandidates: [],
        compactedSections: 0,
        compactedDates: [],
      };
    }

    // Promotions historically follow user-managed MEMORY.md symlinks. Replace the
    // final target atomically without severing the chain, matching the prior writeFile path.
    const memoryWritePath = await resolveMemoryWritePath(memoryPath);
    const existingMemory = await fs.readFile(memoryWritePath, "utf-8").catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return "";
      }
      throw err;
    });
    const existingMarkers = extractPromotionMarkers(existingMemory);
    const alreadyWritten = rehydratedSelected.filter((candidate) =>
      existingMarkers.has(candidate.key),
    );
    const toAppend = rehydratedSelected.filter((candidate) => !existingMarkers.has(candidate.key));

    let compactedDates: string[] = [];
    if (toAppend.length > 0) {
      const section = buildPromotionSection(
        toAppend,
        nowMs,
        options.timezone,
        options.maxPromotedSnippetTokens,
      );
      const budgetChars =
        typeof options.memoryFileMaxChars === "number" &&
        Number.isFinite(options.memoryFileMaxChars)
          ? Math.max(0, Math.floor(options.memoryFileMaxChars))
          : DEFAULT_MEMORY_FILE_MAX_CHARS;
      const compaction = compactMemoryForBudget({
        existingMemory,
        newSection: section,
        budgetChars,
      });
      compactedDates = compaction.droppedDates;
      const baseMemory = compaction.compacted;
      const header = baseMemory.trim().length > 0 ? "" : "# Long-Term Memory\n\n";
      const content = `${header}${withTrailingNewline(baseMemory)}${section}`;
      const memoryDirMode = (await fs.stat(path.dirname(memoryWritePath))).mode & 0o7777;
      let atomicRenameCommitted = false;
      const trackedRename: typeof fs.rename = async (source, destination) => {
        await fs.rename(source, destination);
        atomicRenameCommitted = true;
      };
      try {
        await replaceFileAtomic({
          filePath: memoryWritePath,
          content,
          dirMode: memoryDirMode,
          mode: 0o600,
          preserveExistingMode: true,
          tempPrefix: `${path.basename(memoryPath)}.promotion`,
          syncTempFile: true,
          syncParentDir: true,
          throwOnCleanupError: true,
          // Stage proof prevents a future post-rename permission error from entering fallback.
          fileSystem: {
            promises: {
              mkdir: fs.mkdir,
              chmod: fs.chmod,
              writeFile: fs.writeFile,
              rename: trackedRename,
              copyFile: fs.copyFile,
              unlink: fs.unlink,
              rm: fs.rm,
              open: fs.open,
              stat: fs.stat,
              lstat: fs.lstat,
            },
          },
        });
      } catch (error) {
        // Released promotion writes could update an existing writable MEMORY.md even when
        // directory ACLs blocked rename. Retain that in-place contract only after a real
        // atomic permission failure and a successful writable-file open.
        if (
          atomicRenameCommitted ||
          !isAtomicReplacePermissionError(error) ||
          !(await writeExistingMemoryInPlace(memoryWritePath, content))
        ) {
          throw error;
        }
      }
    }

    for (const candidate of rehydratedSelected) {
      const entry = store.entries[candidate.key];
      if (!entry) {
        continue;
      }
      entry.startLine = candidate.startLine;
      entry.endLine = candidate.endLine;
      entry.snippet = candidate.snippet;
      entry.promotedAt = nowIso;
    }
    store.updatedAt = nowIso;
    await writeStore(workspaceDir, store);
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.promotion.applied",
      timestamp: nowIso,
      memoryPath,
      applied: rehydratedSelected.length,
      candidates: rehydratedSelected.map((candidate) => ({
        key: candidate.key,
        path: candidate.path,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        score: candidate.score,
        recallCount: candidate.recallCount,
      })),
    });

    return {
      memoryPath,
      applied: rehydratedSelected.length,
      appended: toAppend.length,
      reconciledExisting: alreadyWritten.length,
      appliedCandidates: rehydratedSelected,
      compactedSections: compactedDates.length,
      compactedDates,
    };
  });
}
