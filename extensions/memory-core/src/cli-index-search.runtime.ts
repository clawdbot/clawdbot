import path from "node:path";
import { resolveMemorySearchStaleness } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveMemoryDreamingConfig } from "openclaw/plugin-sdk/memory-core-host-status";
import {
  buildCliMemorySearchSessionKey,
  formatAuditCounts,
  formatExtraPaths,
  formatMemoryIndexOutcome,
  resolveMemoryPluginConfig,
  scanMemoryManagerSources,
  withMemoryCommand,
} from "./cli-runtime-common.js";
import {
  defaultRuntime,
  formatErrorMessage,
  setVerbose,
  shortenHomeInString,
  shortenHomePath,
  theme,
  withProgressTotals,
} from "./cli.host.runtime.js";
import type {
  MemoryCommandOptions,
  MemoryPromoteCommandOptions,
  MemoryPromoteExplainOptions,
  MemorySearchCommandOptions,
} from "./cli.types.js";
import { resolveShortTermPromotionDreamingConfig } from "./dreaming.js";
import { formatMemoryVectorDegradedWriteReason } from "./memory/manager-vector-warning.js";
import type { MemoryCoreRuntimeHost } from "./memory/runtime-host.js";
import {
  applyShortTermPromotions,
  auditShortTermPromotionArtifacts,
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
  resolveShortTermRecallLockPath,
  resolveShortTermRecallStorePath,
} from "./short-term-promotion.js";
const { accent, heading, info, muted, success, warn } = theme;
function formatSourceLabel(source: string, workspaceDir: string): string {
  if (source === "memory") {
    return shortenHomeInString(
      `memory (MEMORY.md + ${path.join(workspaceDir, "memory")}${path.sep}*.md)`,
    );
  }
  if (source === "sessions") {
    return "sessions (current transcripts + retained transcript artifacts)";
  }
  return source;
}
export async function runMemoryIndex(
  opts: MemoryCommandOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  setVerbose(Boolean(opts.verbose));
  await withMemoryCommand({
    commandName: "memory index",
    agent: opts.agent,
    allAgents: true,
    purpose: "cli",
    ...hostOptions,
    run: async ({ manager, agentId }) => {
      try {
        const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;
        if (opts.verbose) {
          const status = manager.status();
          const label = (text: string) => muted(`${text}:`);
          const sourceLabels = (status.sources ?? []).map((source) =>
            formatSourceLabel(source, status.workspaceDir ?? ""),
          );
          const extraPaths = status.workspaceDir
            ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? [])
            : [];
          const requestedProvider = status.requestedProvider ?? status.provider;
          const modelLabel = status.model ?? status.provider;
          const lines = [
            `${heading("Memory Index")} ${muted(`(${agentId})`)}`,
            `${label("Provider")} ${info(status.provider)} ${muted(
              `(requested: ${requestedProvider})`,
            )}`,
            `${label("Model")} ${info(modelLabel)}`,
            sourceLabels.length ? `${label("Sources")} ${info(sourceLabels.join(", "))}` : null,
            extraPaths.length ? `${label("Extra paths")} ${info(extraPaths.join(", "))}` : null,
          ].filter(Boolean) as string[];
          if (status.fallback) {
            lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
          }
          defaultRuntime.log(lines.join("\n"));
          defaultRuntime.log("");
        }
        const startedAt = Date.now();
        let lastLabel = "Indexing memory…";
        let lastCompleted = 0;
        let lastTotal = 0;
        const formatDuration = (elapsedMs: number) => {
          const seconds = Math.floor(elapsedMs / 1000);
          return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        };
        const buildLabel = () => {
          const elapsedMs = Math.max(1, Date.now() - startedAt);
          const elapsed = formatDuration(elapsedMs);
          if (lastTotal <= 0 || lastCompleted <= 0) {
            return `${lastLabel} · elapsed ${elapsed}`;
          }
          const remainingMs = Math.max(
            0,
            ((lastTotal - lastCompleted) * elapsedMs) / lastCompleted,
          );
          return `${lastLabel} · elapsed ${elapsed} · eta ${formatDuration(remainingMs)}`;
        };
        if (!syncFn) {
          defaultRuntime.log("Memory backend does not support manual reindex.");
          return;
        }
        await withProgressTotals(
          {
            label: "Indexing memory…",
            total: 0,
            fallback: opts.verbose ? "line" : undefined,
          },
          async (update, progress) => {
            const interval = setInterval(() => {
              progress.setLabel(buildLabel());
            }, 1000);
            try {
              await syncFn({
                reason: "cli",
                force: Boolean(opts.force),
                progress: (syncUpdate) => {
                  if (syncUpdate.label) {
                    lastLabel = syncUpdate.label;
                  }
                  lastCompleted = syncUpdate.completed;
                  lastTotal = syncUpdate.total;
                  update({
                    completed: syncUpdate.completed,
                    total: syncUpdate.total,
                    label: buildLabel(),
                  });
                  progress.setLabel(buildLabel());
                },
              });
            } finally {
              clearInterval(interval);
            }
          },
        );
        let postIndexStatus = manager.status();
        const scan = await scanMemoryManagerSources(postIndexStatus, agentId);
        const outcome = formatMemoryIndexOutcome(postIndexStatus, scan, agentId);
        let semanticVectorAvailable = postIndexStatus.vector?.semanticAvailable;
        const vectorStoreAvailable =
          postIndexStatus.vector?.storeAvailable ?? postIndexStatus.vector?.available;
        if (
          postIndexStatus.backend === "builtin" &&
          (postIndexStatus.vector?.enabled ?? false) &&
          semanticVectorAvailable === undefined &&
          vectorStoreAvailable !== false &&
          typeof manager.probeVectorAvailability === "function"
        ) {
          semanticVectorAvailable = await manager.probeVectorAvailability();
          postIndexStatus = manager.status();
          semanticVectorAvailable =
            postIndexStatus.vector?.semanticAvailable ?? semanticVectorAvailable;
        }
        const vectorEnabled = postIndexStatus.vector?.enabled ?? false;
        const vectorAvailable =
          semanticVectorAvailable ??
          postIndexStatus.vector?.semanticAvailable ??
          postIndexStatus.vector?.available ??
          postIndexStatus.vector?.storeAvailable;
        const vectorLoadErr = postIndexStatus.vector?.loadError;
        defaultRuntime.log(outcome);
        if (vectorEnabled && vectorAvailable === false) {
          // Indexing still persisted chunks/FTS state; keep the command successful but
          // emit a stderr warning so operators and scripts can detect degraded recall.
          defaultRuntime.error(
            `Memory index WARNING (${agentId}): chunks_vec not updated — ${formatMemoryVectorDegradedWriteReason(vectorLoadErr)}. Vector recall degraded.`,
          );
        }
      } catch (err) {
        const message = formatErrorMessage(err);
        defaultRuntime.error(`Memory index failed (${agentId}): ${message}`);
        process.exitCode = 1;
      }
    },
  });
}
export async function runMemorySearch(
  queryArg: string | undefined,
  opts: MemorySearchCommandOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  const query = opts.query ?? queryArg;
  if (!query) {
    defaultRuntime.error("Missing search query. Provide a positional query or use --query <text>.");
    process.exitCode = 1;
    return;
  }
  await withMemoryCommand({
    commandName: "memory search",
    agent: opts.agent,
    diagnosticsToStderr: Boolean(opts.json),
    purpose: "cli",
    ...hostOptions,
    run: async ({ manager, cfg, agentId }) => {
      const memoryPluginConfig = resolveMemoryPluginConfig(cfg);
      const dreamingEnabled = resolveMemoryDreamingConfig({
        pluginConfig: memoryPluginConfig,
        cfg,
      }).enabled;
      const dreaming = resolveShortTermPromotionDreamingConfig({
        pluginConfig: memoryPluginConfig,
        cfg,
      });
      const sessionKey = buildCliMemorySearchSessionKey(agentId);
      let results: Awaited<ReturnType<typeof manager.search>>;
      try {
        results = await manager.search(query, {
          maxResults: opts.maxResults,
          minScore: opts.minScore,
          sessionKey,
        });
      } catch (err) {
        const message = formatErrorMessage(err);
        defaultRuntime.error(`Memory search failed: ${message}`);
        process.exitCode = 1;
        return;
      }
      const status = manager.status();
      const staleness = resolveMemorySearchStaleness(status, agentId);
      const workspaceDir = status.workspaceDir;
      if (dreamingEnabled) {
        await recordShortTermRecalls({
          workspaceDir,
          query,
          results,
          timezone: dreaming.timezone,
        }).catch(() => {
          // Persistence is best-effort, but the short-lived CLI must await it
          // so process exit cannot discard an in-flight recall write.
        });
      }
      if (opts.json) {
        defaultRuntime.writeJson({ results, ...staleness });
        return;
      }
      if (staleness) {
        defaultRuntime.error(`${staleness.warning} ${staleness.action}`);
      }
      if (results.length === 0) {
        defaultRuntime.log("No matches.");
        return;
      }
      const lines: string[] = [];
      for (const result of results) {
        lines.push(
          `${success(result.score.toFixed(3))} ${accent(`${shortenHomePath(result.path)}:${result.startLine}-${result.endLine}`)}`,
        );
        lines.push(muted(result.snippet));
        lines.push("");
      }
      defaultRuntime.log(lines.join("\n").trim());
    },
  });
}
function matchesPromotionSelector(
  candidate: {
    key: string;
    path: string;
    snippet: string;
  },
  selector: string,
): boolean {
  const trimmed = selector.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }
  return (
    candidate.key.toLowerCase() === trimmed ||
    candidate.key.toLowerCase().includes(trimmed) ||
    candidate.path.toLowerCase().includes(trimmed) ||
    candidate.snippet.toLowerCase().includes(trimmed)
  );
}
export async function runMemoryPromote(
  opts: MemoryPromoteCommandOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  await withMemoryCommand({
    commandName: "memory promote",
    agent: opts.agent,
    diagnosticsToStderr: Boolean(opts.json),
    purpose: "status",
    ...hostOptions,
    run: async ({ manager, cfg, agentId }) => {
      const status = manager.status();
      const workspaceDir = status.workspaceDir?.trim();
      const dreaming = resolveShortTermPromotionDreamingConfig({
        pluginConfig: resolveMemoryPluginConfig(cfg),
        cfg,
      });
      if (!workspaceDir) {
        defaultRuntime.error("Memory promote requires a resolvable workspace directory.");
        process.exitCode = 1;
        return;
      }
      let candidates: Awaited<ReturnType<typeof rankShortTermPromotionCandidates>>;
      try {
        const gatherAllForApply = Boolean(opts.apply);
        candidates = await rankShortTermPromotionCandidates({
          workspaceDir,
          limit: gatherAllForApply ? undefined : opts.limit,
          minScore: gatherAllForApply ? 0 : (opts.minScore ?? dreaming.minScore),
          minRecallCount: gatherAllForApply ? 0 : (opts.minRecallCount ?? dreaming.minRecallCount),
          minUniqueQueries: gatherAllForApply
            ? 0
            : (opts.minUniqueQueries ?? dreaming.minUniqueQueries),
          recencyHalfLifeDays: dreaming.recencyHalfLifeDays,
          maxAgeDays: gatherAllForApply ? undefined : dreaming.maxAgeDays,
          includePromoted: Boolean(opts.includePromoted),
        });
      } catch (err) {
        defaultRuntime.error(`Memory promote ranking failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
        return;
      }
      let applyResult: Awaited<ReturnType<typeof applyShortTermPromotions>> | undefined;
      if (opts.apply) {
        try {
          applyResult = await applyShortTermPromotions({
            workspaceDir,
            candidates,
            limit: opts.limit,
            minScore: opts.minScore ?? dreaming.minScore,
            minRecallCount: opts.minRecallCount ?? dreaming.minRecallCount,
            minUniqueQueries: opts.minUniqueQueries ?? dreaming.minUniqueQueries,
            maxAgeDays: dreaming.maxAgeDays,
            maxPromotedSnippetTokens: dreaming.maxPromotedSnippetTokens,
            timezone: dreaming.timezone,
          });
        } catch (err) {
          defaultRuntime.error(`Memory promote apply failed: ${formatErrorMessage(err)}`);
          process.exitCode = 1;
          return;
        }
      }
      const outputLimit =
        typeof opts.limit === "number" && Number.isFinite(opts.limit)
          ? Math.max(0, Math.floor(opts.limit))
          : candidates.length;
      const rejectedCandidates = applyResult
        ? applyResult.rejectedCandidates.slice(
            0,
            Math.max(0, outputLimit - applyResult.appliedCandidates.length),
          )
        : [];
      const outputCandidateKeys = applyResult
        ? new Set([
            ...applyResult.appliedCandidates.map((candidate) => candidate.key),
            ...rejectedCandidates.map((rejection) => rejection.candidate.key),
          ])
        : undefined;
      const outputCandidates = outputCandidateKeys
        ? candidates.filter((candidate) => outputCandidateKeys.has(candidate.key))
        : candidates;
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const lockPath = resolveShortTermRecallLockPath(workspaceDir);
      const audit = await auditShortTermPromotionArtifacts({ workspaceDir });
      if (opts.json) {
        defaultRuntime.writeJson({
          workspaceDir,
          storePath,
          lockPath,
          audit,
          candidates: outputCandidates,
          apply: applyResult
            ? {
                applied: applyResult.applied,
                appended: applyResult.appended,
                reconciledExisting: applyResult.reconciledExisting,
                memoryPath: applyResult.memoryPath,
                appliedCandidates: applyResult.appliedCandidates,
                rejectedCandidates,
              }
            : undefined,
        });
        return;
      }
      if (candidates.length === 0) {
        defaultRuntime.log("No short-term recall candidates.");
        defaultRuntime.log(`Recall store: ${shortenHomePath(storePath)}`);
        if (audit.issues.length > 0) {
          for (const issue of audit.issues) {
            defaultRuntime.log(issue.message);
          }
        }
        return;
      }
      const lines: string[] = [];
      lines.push(`${heading("Short-Term Promotion Candidates")} ${muted(`(${agentId})`)}`);
      lines.push(`${muted("Recall store:")} ${shortenHomePath(storePath)}`);
      lines.push(muted(`Store health: ${formatAuditCounts(audit)}`));
      for (const candidate of outputCandidates) {
        lines.push(
          `${success(candidate.score.toFixed(3))} ${accent(`${shortenHomePath(candidate.path)}:${candidate.startLine}-${candidate.endLine}`)}`,
        );
        lines.push(
          muted(
            `signals=${candidate.signalCount} recalls=${candidate.recallCount} avg=${candidate.avgScore.toFixed(3)} queries=${candidate.uniqueQueries} age=${candidate.ageDays.toFixed(1)}d consolidate=${candidate.components.consolidation.toFixed(2)} conceptual=${candidate.components.conceptual.toFixed(2)}`,
          ),
        );
        if (candidate.conceptTags.length > 0) {
          lines.push(muted(`concepts=${candidate.conceptTags.join(", ")}`));
        }
        if (candidate.snippet) {
          lines.push(muted(candidate.snippet));
        }
        lines.push("");
      }
      if (audit.issues.length > 0) {
        lines.push(warn("Audit issues:"));
        for (const issue of audit.issues) {
          lines.push((issue.severity === "error" ? warn : muted)(issue.message));
        }
        lines.push("");
      }
      if (applyResult) {
        for (const rejection of rejectedCandidates) {
          const candidate = rejection.candidate;
          const source = `${shortenHomePath(candidate.path)}:${candidate.startLine}-${candidate.endLine}`;
          lines.push(warn(`Skipped ${source}: ${rejection.reason}.`));
        }
        if (applyResult.applied > 0) {
          lines.push(
            success(
              `Processed ${applyResult.applied} candidate(s) for ${shortenHomePath(applyResult.memoryPath)}.`,
            ),
          );
          lines.push(
            muted(
              `appended=${applyResult.appended} reconciledExisting=${applyResult.reconciledExisting}`,
            ),
          );
        } else if (rejectedCandidates.length === 0) {
          lines.push(warn("No candidates met apply criteria."));
        }
      }
      defaultRuntime.log(lines.join("\n").trim());
    },
  });
}
export async function runMemoryPromoteExplain(
  selectorArg: string | undefined,
  opts: MemoryPromoteExplainOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  const selector = selectorArg?.trim();
  if (!selector) {
    defaultRuntime.error("Memory promote-explain requires a non-empty selector.");
    process.exitCode = 1;
    return;
  }
  await withMemoryCommand({
    commandName: "memory promote-explain",
    agent: opts.agent,
    diagnosticsToStderr: Boolean(opts.json),
    purpose: "status",
    ...hostOptions,
    run: async ({ manager, cfg, agentId }) => {
      const status = manager.status();
      const workspaceDir = status.workspaceDir?.trim();
      const dreaming = resolveShortTermPromotionDreamingConfig({
        pluginConfig: resolveMemoryPluginConfig(cfg),
        cfg,
      });
      if (!workspaceDir) {
        defaultRuntime.error("Memory promote-explain requires a resolvable workspace directory.");
        process.exitCode = 1;
        return;
      }
      let candidates: Awaited<ReturnType<typeof rankShortTermPromotionCandidates>>;
      try {
        candidates = await rankShortTermPromotionCandidates({
          workspaceDir,
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
          includePromoted: Boolean(opts.includePromoted),
          recencyHalfLifeDays: dreaming.recencyHalfLifeDays,
          maxAgeDays: dreaming.maxAgeDays,
        });
      } catch (err) {
        defaultRuntime.error(`Memory promote-explain failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
        return;
      }
      const candidate = candidates.find((entry) => matchesPromotionSelector(entry, selector));
      if (!candidate) {
        defaultRuntime.error(`No promotion candidate matched "${selector}".`);
        process.exitCode = 1;
        return;
      }
      const thresholds = {
        minScore: dreaming.minScore,
        minRecallCount: dreaming.minRecallCount,
        minUniqueQueries: dreaming.minUniqueQueries,
        maxAgeDays: dreaming.maxAgeDays ?? null,
      };
      if (opts.json) {
        defaultRuntime.writeJson({
          workspaceDir,
          thresholds,
          candidate,
          passes: {
            score: candidate.score >= thresholds.minScore,
            // Engine gate is aggregate signalCount vs minRecallCount (config name unchanged).
            recallCount: candidate.signalCount >= thresholds.minRecallCount,
            uniqueQueries: candidate.uniqueQueries >= thresholds.minUniqueQueries,
            maxAge:
              thresholds.maxAgeDays === null ? true : candidate.ageDays <= thresholds.maxAgeDays,
          },
        });
        return;
      }
      const lines = [
        `${heading("Promotion Explain")} ${muted("(" + agentId + ")")}`,
        accent(candidate.key),
        muted(
          `${shortenHomePath(candidate.path)}:${String(candidate.startLine)}-${String(candidate.endLine)}`,
        ),
        candidate.snippet,
        muted(
          `score=${candidate.score.toFixed(3)} signals=${candidate.signalCount} recalls=${candidate.recallCount} uniqueQueries=${candidate.uniqueQueries} ageDays=${candidate.ageDays.toFixed(1)}`,
        ),
        muted(
          `components: frequency=${candidate.components.frequency.toFixed(2)} relevance=${candidate.components.relevance.toFixed(2)} diversity=${candidate.components.diversity.toFixed(2)} recency=${candidate.components.recency.toFixed(2)} consolidation=${candidate.components.consolidation.toFixed(2)} conceptual=${candidate.components.conceptual.toFixed(2)}`,
        ),
        muted(
          `thresholds: minScore=${thresholds.minScore} minRecallCount=${thresholds.minRecallCount} minUniqueQueries=${thresholds.minUniqueQueries} maxAgeDays=${thresholds.maxAgeDays ?? "none"}`,
        ),
      ];
      if (candidate.conceptTags.length > 0) {
        lines.push(muted(`concepts=${candidate.conceptTags.join(", ")}`));
      }
      defaultRuntime.log(lines.join("\n"));
    },
  });
}
