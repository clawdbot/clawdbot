import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { listMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
  formatMemoryDreamingDay,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { appendMemoryHostEvent } from "openclaw/plugin-sdk/memory-host-events";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  appendConsolidationSkippedSummary,
  appendConsolidationSummary,
  storeMemoryPreimage,
} from "./dreaming-consolidation-artifacts.js";
import {
  isConsolidationCandidateEligible,
  isPromotionOriginBlocked,
} from "./dreaming-consolidation-candidates.js";
import { applyMemoryConsolidationPlan, consolidateMemory } from "./dreaming-consolidation.js";
import { compactMemoryForBudget, DEFAULT_MEMORY_FILE_MAX_CHARS } from "./memory-budget.js";
import {
  hashMemoryContent,
  isAtomicReplacePermissionError,
  MemoryWriteConflictError,
  readMemoryContent,
  resolveMemoryWritePath,
  writeMemoryContent,
} from "./short-term-promotion-memory-write.js";
import {
  buildPromotionRecallAnnotations,
  groupPromotionCandidatesByProjectKey,
} from "./short-term-promotion-metadata.js";
import { resolveShortTermSourcePathCandidates } from "./short-term-promotion-record.js";
import { rehydratePromotionCandidate } from "./short-term-promotion-rehydrate.js";
import { readStore, withShortTermLock, writeStore } from "./short-term-promotion-store.js";
import {
  DEFAULT_PROMOTION_MIN_RECALL_COUNT,
  DEFAULT_PROMOTION_MIN_SCORE,
  DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
  type ApplyShortTermPromotionsOptions,
  type ApplyShortTermPromotionsResult,
  type PromotionCandidate,
  type ShortTermRecallEntry,
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
const MEMORY_WRITE_LOCK_OPTIONS = {
  retries: { retries: 100, factor: 1.2, minTimeout: 25, maxTimeout: 250 },
  stale: 120_000,
  staleRecovery: "fail-closed" as const,
};

function buildPromotionSection(
  candidates: PromotionCandidate[],
  nowMs: number,
  timezone?: string,
  maxPromotedSnippetTokens = DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
): string {
  const sectionDate = formatMemoryDreamingDay(nowMs, timezone);
  const lines = ["", `## Promoted From Short-Term Memory (${sectionDate})`, ""];
  const projectGroups = groupPromotionCandidatesByProjectKey(candidates);

  for (const { projectKey, candidates: groupCandidates } of projectGroups) {
    if (projectGroups.length > 1) {
      lines.push(projectKey ? `### Project: ${projectKey}` : "### Global", "");
    }
    for (const candidate of groupCandidates) {
      const source = `${candidate.path}:${candidate.startLine}-${candidate.endLine}`;
      const metadata = `[score=${candidate.score.toFixed(3)} signals=${candidate.signalCount} recalls=${candidate.recallCount} avg=${candidate.avgScore.toFixed(3)} source=${source}]`;
      lines.push(`<!-- ${PROMOTION_MARKER_PREFIX}${candidate.key} -->`);
      // Cap only the visible MEMORY.md text. The recall store keeps the full
      // rehydrated snippet so ranking, provenance, and dream narratives remain
      // tied to the source entry instead of this presentation budget.
      lines.push(
        `- ${formatPromotedSnippetForMemory(candidate.snippet, maxPromotedSnippetTokens)} ${metadata} ${buildPromotionRecallAnnotations(candidate)}`,
      );
    }
    if (projectGroups.length > 1) {
      lines.push("");
    }
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

function consolidationCandidateFingerprint(candidate: PromotionCandidate): string {
  return JSON.stringify({
    key: candidate.key,
    path: candidate.path,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    snippet: candidate.snippet,
    provenance: candidate.provenance,
    projectKey: candidate.projectKey,
  });
}

function withAuthoritativeProvenance(
  candidate: PromotionCandidate,
  provenance: PromotionCandidate["provenance"],
): PromotionCandidate {
  if (isPromotionOriginBlocked(candidate)) {
    return candidate;
  }
  const next = { ...candidate };
  if (provenance) {
    next.provenance = provenance;
  } else {
    delete next.provenance;
  }
  return next;
}

function withDailyFileQuarantine(
  candidate: PromotionCandidate,
  provenanceByPath: ReadonlyMap<
    string,
    { fileHash: string; originClass: "agent" | "untrusted"; observedAt: number }
  >,
): PromotionCandidate {
  const record = provenanceByPath.get(candidate.path.replaceAll("\\", "/"));
  if (record?.originClass !== "untrusted") {
    return candidate;
  }
  return {
    ...candidate,
    provenance: {
      originClass: "untrusted",
      sessionKind: candidate.provenance?.sessionKind ?? "unknown",
      observedAt: record.observedAt,
    },
  };
}

function recallStoreEntryFingerprint(entry: ShortTermRecallEntry | undefined): string {
  return JSON.stringify(entry ?? null);
}

async function promotionSourceFingerprint(
  workspaceDir: string,
  candidate: PromotionCandidate,
): Promise<string> {
  for (const sourcePath of resolveShortTermSourcePathCandidates(workspaceDir, candidate.path)) {
    try {
      const content = await fs.readFile(sourcePath);
      return createHash("sha256").update(content).digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return "missing";
}

async function resolveMemoryPromotionLockTarget(workspaceDir: string): Promise<string> {
  const lockDir = path.join(resolveStateDir(), "locks");
  await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
  const canonicalWorkspace = await fs
    .realpath(workspaceDir)
    .catch(() => path.resolve(workspaceDir));
  const workspaceHash = createHash("sha256").update(canonicalWorkspace).digest("hex");
  return path.join(lockDir, `memory-promotion-${workspaceHash}`);
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

  const dailyProvenanceEntries = await listMemoryArtifactProvenance({ workspaceDir });
  const dailyProvenanceByPath = new Map(
    dailyProvenanceEntries.map((entry) => [
      entry.relativePath.replaceAll("\\", "/"),
      entry.provenance,
    ]),
  );
  const store = await withShortTermLock(workspaceDir, async () => readStore(workspaceDir, nowIso));
  const currentCandidates = options.candidates.map((candidate) => {
    const entry = store.entries[candidate.key];
    const authoritative = entry
      ? withAuthoritativeProvenance(
          {
            ...candidate,
            path: entry.path,
            startLine: entry.startLine,
            endLine: entry.endLine,
            snippet: entry.snippet,
          },
          entry.provenance,
        )
      : candidate;
    // Flush quarantine is sticky at the daily-file boundary. This deliberately
    // sacrifices trusted lines in a mixed file so untrusted text cannot promote.
    return withDailyFileQuarantine(authoritative, dailyProvenanceByPath);
  });
  const rejectionReasons = new Map<string, string>();
  const eligible = currentCandidates.filter((candidate) => {
    const latest = store.entries[candidate.key];
    const queryCount = Math.max(candidate.uniqueQueries, candidate.recallDays.length);
    // Explicit untrusted/system origins never promote on ANY path (append or
    // consolidation): recall frequency must never launder externally-derived
    // content into MEMORY.md. Workspace memory files index as 'agent', so
    // legitimate daily-note candidates stay eligible.
    const reason = isPromotionOriginBlocked(candidate)
      ? `origin filter (${candidate.provenance?.originClass})`
      : options.consolidation && (!latest || !isConsolidationCandidateEligible(candidate))
        ? "consolidation origin/session filter"
        : isContaminatedDreamingSnippet(candidate.snippet)
          ? "contamination filter"
          : candidate.promotedAt || latest?.promotedAt
            ? "already promoted"
            : candidate.score < minScore
              ? `score threshold (${candidate.score.toFixed(3)} < ${minScore})`
              : candidate.signalCount < minRecallCount
                ? `signal threshold (${candidate.signalCount} < ${minRecallCount})`
                : queryCount < minUniqueQueries
                  ? `query threshold (${queryCount} < ${minUniqueQueries})`
                  : maxAgeDays >= 0 && candidate.ageDays > maxAgeDays
                    ? `age threshold (${candidate.ageDays.toFixed(1)}d > ${maxAgeDays}d)`
                    : undefined;
    if (reason) {
      rejectionReasons.set(candidate.key, reason);
    }
    return !reason;
  });
  const selected = eligible.slice(0, limit);
  for (const candidate of eligible.slice(limit)) {
    rejectionReasons.set(candidate.key, `selection limit (${limit})`);
  }

  const rehydratedSelected: PromotionCandidate[] = [];
  const plannedSourceFingerprints = new Map<string, string>();
  for (const candidate of selected) {
    const sourceFingerprintBefore = await promotionSourceFingerprint(workspaceDir, candidate);
    const rehydrated = await rehydratePromotionCandidate(workspaceDir, candidate);
    const sourceFingerprintAfter = await promotionSourceFingerprint(workspaceDir, candidate);
    // Integrity is guarded by source-fingerprint stability during rehydration,
    // successful rehydration (the snippet still exists in the live file), the
    // contamination check, and the origin block above. Rehydration is meant to
    // reshape the snippet (capping, heading context, moved lines), so we do not
    // additionally require the rehydrated text to equal the stored recall.
    if (
      sourceFingerprintBefore === sourceFingerprintAfter &&
      rehydrated &&
      !isContaminatedDreamingSnippet(rehydrated.snippet)
    ) {
      rehydratedSelected.push(rehydrated);
      plannedSourceFingerprints.set(candidate.key, sourceFingerprintAfter);
    } else {
      rejectionReasons.set(
        candidate.key,
        !rehydrated
          ? "source rehydration failed"
          : sourceFingerprintBefore !== sourceFingerprintAfter
            ? "source changed during apply"
            : "contamination filter after rehydration",
      );
    }
  }

  if (rehydratedSelected.length === 0) {
    return {
      memoryPath,
      applied: 0,
      appended: 0,
      reconciledExisting: 0,
      appliedCandidates: [],
      rejectedCandidates: currentCandidates.map((candidate) => ({
        candidate,
        reason: rejectionReasons.get(candidate.key) ?? "candidate changed during apply",
      })),
      compactedSections: 0,
      compactedDates: [],
    };
  }

  const plannedStoreEntryFingerprints = new Map(
    rehydratedSelected.map((candidate) => [
      candidate.key,
      recallStoreEntryFingerprint(store.entries[candidate.key]),
    ]),
  );
  // Promotions historically follow user-managed MEMORY.md symlinks. Replace the
  // final target atomically without severing the chain, matching the prior writeFile path.
  let memoryWritePath = await resolveMemoryWritePath(memoryPath);
  let existingMemory = await fs.readFile(memoryWritePath, "utf-8").catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "";
    }
    throw err;
  });
  let existingMarkers = extractPromotionMarkers(existingMemory);
  let alreadyWritten = rehydratedSelected.filter((candidate) => existingMarkers.has(candidate.key));
  let toAppend = rehydratedSelected.filter((candidate) => !existingMarkers.has(candidate.key));
  const consolidationBaseMemoryHash = hashMemoryContent(existingMemory);
  const plannedCandidateFingerprints = new Map(
    toAppend.map((candidate) => [candidate.key, consolidationCandidateFingerprint(candidate)]),
  );

  let compactedDates: string[] = [];
  const budgetChars =
    typeof options.memoryFileMaxChars === "number" && Number.isFinite(options.memoryFileMaxChars)
      ? Math.max(0, Math.floor(options.memoryFileMaxChars))
      : DEFAULT_MEMORY_FILE_MAX_CHARS;
  const consolidationPlan =
    options.consolidation?.subagent && toAppend.length > 0
      ? await consolidateMemory({
          subagent: options.consolidation.subagent,
          workspaceDir,
          existingMemory,
          candidates: toAppend,
          ...(options.consolidation.model ? { model: options.consolidation.model } : {}),
          maxPriorEntryLossFraction: Math.max(
            0,
            Math.min(1, options.maxPriorEntryLossFraction ?? 0.25),
          ),
          memoryFileMaxChars: budgetChars,
          ...(typeof options.maxPromotedSnippetTokens === "number"
            ? { maxPromotedSnippetTokens: options.maxPromotedSnippetTokens }
            : {}),
          nowMs,
          logger: options.consolidation.logger,
        })
      : null;
  let consolidationResult: Awaited<ReturnType<typeof applyMemoryConsolidationPlan>> = null;
  let committedCandidates: PromotionCandidate[] = [];
  let appendedCandidates = 0;
  let rewriteSkippedReason: string | undefined;
  const promotionLockTarget = await resolveMemoryPromotionLockTarget(workspaceDir);
  await withFileLock(promotionLockTarget, MEMORY_WRITE_LOCK_OPTIONS, async () => {
    await withShortTermLock(workspaceDir, async () => {
      const latestStore = await readStore(workspaceDir, nowIso);
      const authoritativeSelected: PromotionCandidate[] = [];
      for (const candidate of rehydratedSelected) {
        const entry = latestStore.entries[candidate.key];
        if (!entry) {
          const wasDirectCandidate =
            !options.consolidation &&
            plannedStoreEntryFingerprints.get(candidate.key) ===
              recallStoreEntryFingerprint(undefined);
          const sourceUnchanged =
            plannedSourceFingerprints.get(candidate.key) ===
            (await promotionSourceFingerprint(workspaceDir, candidate));
          if (
            wasDirectCandidate &&
            sourceUnchanged &&
            !isContaminatedDreamingSnippet(candidate.snippet)
          ) {
            authoritativeSelected.push(candidate);
          }
          continue;
        }
        if (entry.promotedAt) {
          continue;
        }
        const storeChanged =
          plannedStoreEntryFingerprints.get(candidate.key) !== recallStoreEntryFingerprint(entry);
        const sourceChanged =
          plannedSourceFingerprints.get(candidate.key) !==
          (await promotionSourceFingerprint(workspaceDir, candidate));
        if (storeChanged || sourceChanged) {
          continue;
        }
        const currentCandidate = withAuthoritativeProvenance(candidate, entry.provenance);
        if (options.consolidation && !isConsolidationCandidateEligible(currentCandidate)) {
          continue;
        }
        if (!isContaminatedDreamingSnippet(currentCandidate.snippet)) {
          authoritativeSelected.push(currentCandidate);
        }
      }
      memoryWritePath = await resolveMemoryWritePath(memoryPath);
      existingMemory = await fs.readFile(memoryWritePath, "utf-8").catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          return "";
        }
        throw err;
      });
      existingMarkers = extractPromotionMarkers(existingMemory);
      alreadyWritten = authoritativeSelected.filter((candidate) =>
        existingMarkers.has(candidate.key),
      );
      toAppend = authoritativeSelected.filter((candidate) => !existingMarkers.has(candidate.key));
      const successfulCandidates = new Map(
        alreadyWritten.map((candidate) => [candidate.key, candidate]),
      );
      const plannedKeys = new Set(
        consolidationPlan?.operations.map((operation) => operation.candidateKey) ?? [],
      );
      const planIsCurrent =
        consolidationPlan !== null &&
        plannedKeys.size === toAppend.length &&
        toAppend.every(
          (candidate) =>
            plannedKeys.has(candidate.key) &&
            plannedCandidateFingerprints.get(candidate.key) ===
              consolidationCandidateFingerprint(candidate),
        );
      if (planIsCurrent && consolidationPlan) {
        if (hashMemoryContent(existingMemory) !== consolidationBaseMemoryHash) {
          rewriteSkippedReason = "MEMORY.md changed while consolidation was running";
        } else {
          consolidationResult = applyMemoryConsolidationPlan({
            existingMemory,
            plan: consolidationPlan,
            nowMs,
            ...(options.timezone ? { timezone: options.timezone } : {}),
            memoryFileMaxChars: budgetChars,
            maxPriorEntryLossFraction: Math.max(
              0,
              Math.min(1, options.maxPriorEntryLossFraction ?? 0.25),
            ),
          });
        }
      }
      if (consolidationResult) {
        try {
          await storeMemoryPreimage({ workspaceDir, content: existingMemory, nowMs });
        } catch (error) {
          options.consolidation?.logger.warn(
            `memory-core: consolidation preimage failed (${String(error)}); using append-only fallback.`,
          );
          consolidationResult = null;
        }
      }
      if (consolidationResult) {
        try {
          await writeMemoryContent({
            memoryPath,
            memoryWritePath,
            expectedHash: consolidationBaseMemoryHash,
            content: consolidationResult.content,
          });
          for (const candidate of toAppend) {
            successfulCandidates.set(candidate.key, candidate);
          }
          appendedCandidates = toAppend.length;
        } catch (error) {
          if (
            !(error instanceof MemoryWriteConflictError) &&
            !isAtomicReplacePermissionError(error)
          ) {
            throw error;
          }
          rewriteSkippedReason =
            error instanceof MemoryWriteConflictError
              ? "MEMORY.md changed immediately before the consolidation rename"
              : "the MEMORY.md directory blocked atomic replacement";
          consolidationResult = null;
          existingMemory = await readMemoryContent(memoryWritePath);
          existingMarkers = extractPromotionMarkers(existingMemory);
          alreadyWritten = authoritativeSelected.filter((candidate) =>
            existingMarkers.has(candidate.key),
          );
          toAppend = authoritativeSelected.filter(
            (candidate) => !existingMarkers.has(candidate.key),
          );
          successfulCandidates.clear();
          for (const candidate of alreadyWritten) {
            successfulCandidates.set(candidate.key, candidate);
          }
        }
      }
      if (!consolidationResult) {
        if (consolidationPlan) {
          options.consolidation?.logger.warn(
            "memory-core: promotion state or MEMORY.md changed during consolidation; using append-only fallback.",
          );
        }
        if (toAppend.length > 0) {
          // Model absence or rejected output preserves the shipped append-only
          // promotion contract, so a deep sweep never loses eligible memories.
          const section = buildPromotionSection(
            toAppend,
            nowMs,
            options.timezone,
            options.maxPromotedSnippetTokens,
          );
          const compaction = compactMemoryForBudget({
            existingMemory,
            newSection: section,
            budgetChars,
          });
          const droppedDates = compaction.droppedDates;
          const baseMemory = compaction.compacted;
          const header = baseMemory.trim().length > 0 ? "" : "# Long-Term Memory\n\n";
          const content = `${header}${withTrailingNewline(baseMemory)}${section}`;
          // Append fallback keeps the historical read-modify-replace contract. Policy accepts
          // its external-editor race because OpenClaw writers remain serialized by this sweep lock.
          await writeMemoryContent({
            memoryPath,
            memoryWritePath,
            expectedHash: hashMemoryContent(existingMemory),
            expectedContent: existingMemory,
            allowInPlaceFallback: true,
            content,
          });
          for (const candidate of toAppend) {
            successfulCandidates.set(candidate.key, candidate);
          }
          compactedDates = droppedDates;
          appendedCandidates = toAppend.length;
        }
      }
      if (rewriteSkippedReason) {
        options.consolidation?.logger.warn(
          `memory-core: ${rewriteSkippedReason}; using append-only fallback.`,
        );
      }
      for (const candidate of successfulCandidates.values()) {
        const entry = latestStore.entries[candidate.key];
        if (!entry) {
          continue;
        }
        entry.startLine = candidate.startLine;
        entry.endLine = candidate.endLine;
        entry.snippet = candidate.snippet;
        entry.promotedAt = nowIso;
      }
      const latestUpdatedAtMs = Date.parse(latestStore.updatedAt);
      latestStore.updatedAt = resolveMemoryCoreTimestamp(
        Math.max(nowMs, Number.isFinite(latestUpdatedAtMs) ? latestUpdatedAtMs : 0),
      );
      await writeStore(workspaceDir, latestStore);
      committedCandidates = [...successfulCandidates.values()];
    });
  });
  if (consolidationResult) {
    await appendConsolidationSummary({
      workspaceDir,
      result: consolidationResult,
      nowMs,
    }).catch((error: unknown) => {
      options.consolidation?.logger.warn(
        `memory-core: MEMORY.md was consolidated but DREAMS.md summary failed: ${String(error)}`,
      );
    });
  } else if (rewriteSkippedReason) {
    await appendConsolidationSkippedSummary({
      workspaceDir,
      nowMs,
      reason: rewriteSkippedReason,
    }).catch((error: unknown) => {
      options.consolidation?.logger.warn(
        `memory-core: consolidation skip summary failed: ${String(error)}`,
      );
    });
  }

  await appendMemoryHostEvent(workspaceDir, {
    type: "memory.promotion.applied",
    timestamp: nowIso,
    memoryPath,
    applied: committedCandidates.length,
    candidates: committedCandidates.map((candidate) => ({
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
    applied: committedCandidates.length,
    appended: appendedCandidates,
    reconciledExisting: alreadyWritten.length,
    appliedCandidates: committedCandidates,
    rejectedCandidates: currentCandidates
      .filter((candidate) => !committedCandidates.some((applied) => applied.key === candidate.key))
      .map((candidate) => ({
        candidate,
        reason: rejectionReasons.get(candidate.key) ?? "candidate changed during apply",
      })),
    compactedSections: compactedDates.length,
    compactedDates,
  };
}
