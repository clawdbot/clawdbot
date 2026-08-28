import type { MemoryEmbeddingProbeResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  resolveMemoryLightDreamingConfig,
  resolveMemoryRemDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  formatAuditCounts,
  formatExtraPaths,
  formatMemoryIndexOutcome,
  resolveMemoryPluginConfig,
  scanMemoryManagerSources,
  withMemoryCommand,
  type MemoryManager,
  type MemorySourceScan,
} from "./cli-runtime-common.js";
import {
  defaultRuntime,
  formatErrorMessage,
  setVerbose,
  shortenHomePath,
  theme,
  withProgress,
  withProgressTotals,
  type OpenClawConfig,
} from "./cli.host.runtime.js";
import type { MemoryCommandOptions } from "./cli.types.js";
import {
  auditDreamingArtifacts,
  repairDreamingArtifacts,
  type DreamingArtifactsAuditSummary,
  type RepairDreamingArtifactsResult,
} from "./dreaming-repair.js";
import { resolveShortTermPromotionDreamingConfig } from "./dreaming.js";
import type { MemoryCoreRuntimeHost } from "./memory/runtime-host.js";
import {
  auditShortTermPromotionArtifacts,
  repairShortTermPromotionArtifacts,
  type RepairShortTermPromotionArtifactsResult,
  type ShortTermAuditSummary,
} from "./short-term-promotion.js";
const { accent, heading, info, muted, success, warn } = theme;
type LlamaCppRuntimeStatus = {
  state?: string;
  backend?: string;
  buildInfo?: string;
  model?: { id?: string; path?: string };
  capabilities?: { vision?: boolean; draft?: boolean };
  endpoints?: Record<string, string>;
  loadError?: string;
};
function readLlamaCppRuntimeStatus(
  status: ReturnType<MemoryManager["status"]>,
): LlamaCppRuntimeStatus | null {
  const runtime = asNullableRecord(asNullableRecord(status.custom)?.llamaCppRuntime);
  return runtime?.engine === "llama.cpp" ? (runtime as LlamaCppRuntimeStatus) : null;
}
function formatMemoryIndexIdentityWarning(
  status: ReturnType<MemoryManager["status"]>,
  agentId: string,
): {
  reason: string;
  fix: string;
} | null {
  const indexIdentity = asNullableRecord(asNullableRecord(status.custom)?.indexIdentity);
  const reason =
    (indexIdentity?.status === "mismatched" || indexIdentity?.status === "missing") &&
    typeof indexIdentity.reason === "string"
      ? indexIdentity.reason
      : undefined;
  if (!reason) {
    return null;
  }
  return {
    reason,
    fix: `Run: openclaw memory status --index --agent ${agentId}`,
  };
}
function formatDreamingSummary(cfg: OpenClawConfig): string {
  const pluginConfig = resolveMemoryPluginConfig(cfg);
  const light = resolveMemoryLightDreamingConfig({ pluginConfig, cfg });
  const deep = resolveShortTermPromotionDreamingConfig({ pluginConfig, cfg });
  const rem = resolveMemoryRemDreamingConfig({ pluginConfig, cfg });
  const timezone = deep.timezone ?? light.timezone ?? rem.timezone;
  const formatCron = (cron: string) => (timezone ? `${cron} (${timezone})` : cron);
  const lightSummary = light.enabled
    ? `light=${formatCron(light.cron)} · limit=${light.limit} · lookbackDays=${light.lookbackDays}`
    : null;
  const remSummary = rem.enabled
    ? `rem=${formatCron(rem.cron)} · limit=${rem.limit} · lookbackDays=${rem.lookbackDays} · minPatternStrength=${rem.minPatternStrength}`
    : null;
  const hasLighterPhase = light.enabled || rem.enabled;
  const deepLabel = hasLighterPhase ? "deep=" : "";
  const deepDetails = `${formatCron(deep.cron)} · limit=${deep.limit} · minScore=${deep.minScore} · minRecallCount=${deep.minRecallCount} · minUniqueQueries=${deep.minUniqueQueries} · recencyHalfLifeDays=${deep.recencyHalfLifeDays} · maxAgeDays=${deep.maxAgeDays ?? "none"} · maxPromotedSnippetTokens=${deep.maxPromotedSnippetTokens}`;
  const deepSummary = deep.enabled ? `${deepLabel}${deepDetails}` : null;
  const phases = [lightSummary, remSummary, deepSummary].filter(Boolean);
  return phases.length > 0 ? phases.join(" · ") : "off";
}
function formatRepairSummary(repair: RepairShortTermPromotionArtifactsResult): string {
  const actions: string[] = [];
  if (repair.rewroteStore) {
    const removedOverflowEntries = repair.removedOverflowEntries ?? 0;
    const details = [
      repair.removedInvalidEntries > 0 ? `-${repair.removedInvalidEntries} invalid` : null,
      (repair.removedDanglingEntries ?? 0) > 0
        ? `-${repair.removedDanglingEntries} dangling`
        : null,
      removedOverflowEntries > 0 ? `-${removedOverflowEntries} overflow` : null,
    ]
      .filter(Boolean)
      .join(", ");
    actions.push(`rewrote store${details ? ` (${details})` : ""}`);
  }
  if (repair.removedStaleLock) {
    actions.push("removed stale lock");
  }
  return actions.length > 0 ? actions.join(" · ") : "no changes";
}
function formatDreamingAuditSummary(audit: DreamingArtifactsAuditSummary): string {
  const bits = [
    audit.dreamsPath ? "diary present" : "diary absent",
    `${audit.sessionCorpusFileCount} corpus files`,
    audit.sessionIngestionExists ? "ingestion state present" : "ingestion state absent",
    audit.suspiciousSessionCorpusLineCount > 0
      ? `${audit.suspiciousSessionCorpusLineCount} suspicious lines`
      : null,
  ].filter(Boolean);
  return bits.join(" · ");
}
function formatDreamingRepairSummary(repair: RepairDreamingArtifactsResult): string {
  const actions: string[] = [];
  if (repair.archivedSessionCorpus) {
    actions.push("archived session corpus");
  }
  if (repair.archivedSessionIngestion) {
    actions.push("archived ingestion state");
  }
  if (repair.archivedDreamsDiary) {
    actions.push("archived diary");
  }
  if (repair.warnings.length > 0) {
    actions.push(`${repair.warnings.length} warning${repair.warnings.length === 1 ? "" : "s"}`);
  }
  return actions.length > 0 ? actions.join(" · ") : "no changes";
}
export async function runMemoryStatus(
  opts: MemoryCommandOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  setVerbose(Boolean(opts.verbose));
  const allResults: Array<{
    agentId: string;
    status: ReturnType<MemoryManager["status"]>;
    embeddingProbe?: MemoryEmbeddingProbeResult;
    indexError?: string;
    scan?: MemorySourceScan;
    audit?: ShortTermAuditSummary;
    repair?: RepairShortTermPromotionArtifactsResult;
    dreamingAudit?: DreamingArtifactsAuditSummary;
    dreamingRepair?: RepairDreamingArtifactsResult;
  }> = [];
  const cfg = await withMemoryCommand({
    commandName: "memory status",
    agent: opts.agent,
    allAgents: true,
    diagnosticsToStderr: Boolean(opts.json),
    purpose: opts.index ? "cli" : "status",
    inspectSources: true,
    ...hostOptions,
    run: async ({ manager, agentId }) => {
      const deep = Boolean(opts.deep || opts.index);
      let embeddingProbe: MemoryEmbeddingProbeResult | undefined;
      let indexError: string | undefined;
      const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;
      if (deep) {
        const initialStatus = manager.status();
        const hasVectorStoreProbe =
          initialStatus.backend === "builtin" &&
          typeof manager.probeVectorStoreAvailability === "function";
        await withProgress(
          { label: "Checking memory…", total: hasVectorStoreProbe ? 3 : 2 },
          async (progress) => {
            progress.setLabel(hasVectorStoreProbe ? "Probing vector store…" : "Probing vectors…");
            if (hasVectorStoreProbe) {
              await manager.probeVectorStoreAvailability?.();
            } else {
              await manager.probeVectorAvailability();
            }
            progress.tick();
            progress.setLabel("Probing embeddings…");
            embeddingProbe = await manager.probeEmbeddingAvailability();
            progress.tick();
            if (hasVectorStoreProbe) {
              progress.setLabel("Checking semantic vectors…");
              await manager.probeVectorAvailability();
              progress.tick();
            }
          },
        );
        if (opts.index && syncFn) {
          await withProgressTotals(
            {
              label: "Indexing memory…",
              total: 0,
              fallback: opts.verbose ? "line" : undefined,
            },
            async (update, progress) => {
              try {
                await syncFn({
                  reason: "cli",
                  force: Boolean(opts.force),
                  progress: (syncUpdate) => {
                    update({
                      completed: syncUpdate.completed,
                      total: syncUpdate.total,
                      label: syncUpdate.label,
                    });
                    if (syncUpdate.label) {
                      progress.setLabel(syncUpdate.label);
                    }
                  },
                });
              } catch (err) {
                indexError = formatErrorMessage(err);
                defaultRuntime.error(`Memory index failed: ${indexError}`);
                process.exitCode = 1;
              }
            },
          );
        } else if (opts.index && !syncFn) {
          defaultRuntime.log("Memory backend does not support manual reindex.");
        }
      }
      const status = manager.status();
      const scan = await scanMemoryManagerSources(status);
      const workspaceDir = status.workspaceDir;
      let audit: ShortTermAuditSummary | undefined;
      let repair: RepairShortTermPromotionArtifactsResult | undefined;
      let dreamingAudit: DreamingArtifactsAuditSummary | undefined;
      let dreamingRepair: RepairDreamingArtifactsResult | undefined;
      if (workspaceDir) {
        dreamingAudit = await auditDreamingArtifacts({ workspaceDir });
        if (opts.fix && dreamingAudit.issues.some((issue) => issue.fixable)) {
          dreamingRepair = await repairDreamingArtifacts({ workspaceDir });
          dreamingAudit = await auditDreamingArtifacts({ workspaceDir });
        }
        if (opts.fix) {
          repair = await repairShortTermPromotionArtifacts({ workspaceDir });
        }
        audit = await auditShortTermPromotionArtifacts({ workspaceDir });
      }
      allResults.push({
        agentId,
        status,
        embeddingProbe,
        indexError,
        scan,
        audit,
        repair,
        dreamingAudit,
        dreamingRepair,
      });
    },
  });
  if (opts.json) {
    defaultRuntime.writeJson(allResults);
    return;
  }
  const label = (text: string) => muted(`${text}:`);
  for (const result of allResults) {
    const {
      agentId,
      status,
      embeddingProbe,
      indexError,
      scan,
      audit,
      repair,
      dreamingAudit,
      dreamingRepair,
    } = result;
    const filesIndexed = status.files ?? 0;
    const chunksIndexed = status.chunks ?? 0;
    const totalFiles = scan?.totalFiles ?? null;
    const indexedLabel =
      totalFiles === null
        ? `${filesIndexed}/? files · ${chunksIndexed} chunks`
        : `${filesIndexed}/${totalFiles} files · ${chunksIndexed} chunks`;
    if (opts.index) {
      const line = indexError
        ? `Memory index failed: ${indexError}`
        : formatMemoryIndexOutcome(status, scan, agentId);
      defaultRuntime.log(line);
    }
    const requestedProvider = status.requestedProvider ?? status.provider;
    const modelLabel = status.model ?? status.provider;
    const storePath = status.dbPath ? shortenHomePath(status.dbPath) : "<unknown>";
    const workspacePath = status.workspaceDir ? shortenHomePath(status.workspaceDir) : "<unknown>";
    const sourceList = status.sources?.length ? status.sources.join(", ") : null;
    const extraPaths = status.workspaceDir
      ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? [])
      : [];
    const lines = [
      `${heading("Memory Search")} ${muted(`(${agentId})`)}`,
      `${label("Provider")} ${info(status.provider)} ${muted(`(requested: ${requestedProvider})`)}`,
      `${label("Model")} ${info(modelLabel)}`,
      sourceList ? `${label("Sources")} ${info(sourceList)}` : null,
      extraPaths.length ? `${label("Extra paths")} ${info(extraPaths.join(", "))}` : null,
      `${label("Indexed")} ${success(indexedLabel)}`,
      `${label("Dirty")} ${status.dirty ? warn("yes") : muted("no")}`,
      `${label("Store")} ${info(storePath)}`,
      `${label("Workspace")} ${info(workspacePath)}`,
      `${label("Dreaming")} ${info(formatDreamingSummary(cfg))}`,
    ].filter(Boolean) as string[];
    if (embeddingProbe) {
      const state =
        embeddingProbe.ok && embeddingProbe.checked === false
          ? "skipped"
          : embeddingProbe.ok
            ? "ready"
            : "unavailable";
      const stateColor = state === "skipped" ? muted : embeddingProbe.ok ? success : warn;
      lines.push(`${label("Embeddings")} ${stateColor(state)}`);
      if (embeddingProbe.error) {
        lines.push(`${label("Embeddings error")} ${warn(embeddingProbe.error)}`);
      }
    }
    const llamaCppRuntime = opts.deep ? readLlamaCppRuntimeStatus(status) : null;
    if (llamaCppRuntime) {
      const runtime = llamaCppRuntime;
      const backend = runtime.backend ?? "unknown";
      const build = runtime.buildInfo ? ` (${runtime.buildInfo})` : "";
      lines.push(`${label("llama.cpp server")} ${info(backend)}${muted(build)}`);
      if (runtime.model?.id) {
        lines.push(`${label("Server model")} ${info(runtime.model.id)}`);
      }
      if (runtime.model?.path) {
        lines.push(`${label("Model path")} ${info(shortenHomePath(runtime.model.path))}`);
      }
      if (runtime.capabilities) {
        const capabilities = [
          runtime.capabilities.vision ? "vision" : null,
          runtime.capabilities.draft ? "draft" : null,
        ].filter(Boolean);
        lines.push(
          `${label("Capabilities")} ${info(capabilities.length ? capabilities.join(", ") : "text only")}`,
        );
      }
      if (runtime.endpoints) {
        lines.push(
          `${label("Endpoints")} ${info(
            Object.entries(runtime.endpoints)
              .map(([name, state]) => `${name}=${state}`)
              .join(" "),
          )}`,
        );
      }
      if (runtime.loadError) {
        lines.push(`${label("llama.cpp error")} ${warn(runtime.loadError)}`);
      }
    }
    const identityWarning = formatMemoryIndexIdentityWarning(status, agentId);
    if (identityWarning) {
      lines.push(`${label("Index identity")} ${warn(identityWarning.reason)}`);
      lines.push(`${label("Vector search")} ${warn("paused until memory is rebuilt")}`);
      lines.push(`${label("Fix")} ${muted(identityWarning.fix)}`);
    }
    if (status.sourceCounts?.length) {
      lines.push(label("By source"));
      for (const entry of status.sourceCounts) {
        const total = scan?.sources?.find(
          (scanEntry) => scanEntry.source === entry.source,
        )?.totalFiles;
        const counts =
          total === null
            ? `${entry.files}/? files · ${entry.chunks} chunks`
            : `${entry.files}/${total} files · ${entry.chunks} chunks`;
        lines.push(`  ${accent(entry.source)} ${muted("·")} ${muted(counts)}`);
      }
    }
    if (status.fallback) {
      lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
    }
    if (status.vector) {
      const formatVectorState = (available: boolean | undefined) =>
        status.vector?.enabled
          ? available === undefined
            ? "unknown"
            : available
              ? "ready"
              : "unavailable"
          : "disabled";
      const formatVectorLine = (lineLabel: string, state: string) => {
        const vectorColor = state === "ready" ? success : state === "unavailable" ? warn : muted;
        lines.push(`${label(lineLabel)} ${vectorColor(state)}`);
      };
      if (status.backend === "builtin") {
        const storeState =
          status.vector.storeAvailable === undefined && status.vector.enabled
            ? status.vector.index?.state === "complete"
              ? "indexed (unprobed)"
              : status.vector.index?.state === "incomplete"
                ? "index incomplete (unprobed)"
                : status.vector.index?.state === "unverified"
                  ? "index unverified (unprobed)"
                  : formatVectorState(undefined)
            : formatVectorState(status.vector.storeAvailable);
        formatVectorLine("Vector store", storeState);
        if (status.vector.semanticAvailable !== undefined) {
          formatVectorLine("Semantic vectors", formatVectorState(status.vector.semanticAvailable));
        }
      } else {
        const vectorState = formatVectorState(
          status.vector.semanticAvailable ?? status.vector.available,
        );
        formatVectorLine("Vector", vectorState);
      }
      if (status.vector.dims) {
        lines.push(`${label("Vector dims")} ${info(String(status.vector.dims))}`);
      }
      if (status.vector.extensionPath) {
        lines.push(`${label("Vector path")} ${info(shortenHomePath(status.vector.extensionPath))}`);
      }
      if (status.vector.loadError) {
        lines.push(`${label("Vector error")} ${warn(status.vector.loadError)}`);
      }
    }
    if (status.fts) {
      const ftsState = status.fts.enabled
        ? status.fts.available
          ? "ready"
          : "unavailable"
        : "disabled";
      const ftsColor = ftsState === "ready" ? success : ftsState === "unavailable" ? warn : muted;
      lines.push(`${label("FTS")} ${ftsColor(ftsState)}`);
      if (status.fts.error) {
        lines.push(`${label("FTS error")} ${warn(status.fts.error)}`);
      }
    }
    if (status.cache) {
      const cacheState = status.cache.enabled ? "enabled" : "disabled";
      const cacheColor = status.cache.enabled ? success : muted;
      const suffix =
        status.cache.enabled && typeof status.cache.entries === "number"
          ? ` (${status.cache.entries} entries)`
          : "";
      lines.push(`${label("Embedding cache")} ${cacheColor(cacheState)}${suffix}`);
      if (status.cache.enabled && typeof status.cache.maxEntries === "number") {
        lines.push(`${label("Cache cap")} ${info(String(status.cache.maxEntries))}`);
      }
    }
    if (status.batch) {
      const batchState = status.batch.enabled ? "enabled" : "disabled";
      const batchColor = status.batch.enabled ? success : warn;
      const batchSuffix = ` (failures ${status.batch.failures}/${status.batch.limit})`;
      lines.push(`${label("Batch")} ${batchColor(batchState)}${muted(batchSuffix)}`);
      if (status.batch.lastError) {
        lines.push(`${label("Batch error")} ${warn(status.batch.lastError)}`);
      }
    }
    if (audit) {
      lines.push(`${label("Recall store")} ${info(formatAuditCounts(audit))}`);
      lines.push(`${label("Recall path")} ${info(shortenHomePath(audit.storePath))}`);
      if (audit.updatedAt) {
        lines.push(`${label("Recall updated")} ${info(audit.updatedAt)}`);
      }
    }
    if (dreamingAudit) {
      lines.push(
        `${label("Dreaming artifacts")} ${info(formatDreamingAuditSummary(dreamingAudit))}`,
      );
      lines.push(
        `${label("Dream corpus")} ${info(shortenHomePath(dreamingAudit.sessionCorpusDir))}`,
      );
      lines.push(
        `${label("Dream ingestion")} ${info(shortenHomePath(dreamingAudit.sessionIngestionPath))}`,
      );
      if (dreamingAudit.dreamsPath) {
        lines.push(`${label("Dream diary")} ${info(shortenHomePath(dreamingAudit.dreamsPath))}`);
      }
    }
    if (repair) {
      lines.push(`${label("Repair")} ${info(formatRepairSummary(repair))}`);
    }
    if (dreamingRepair) {
      lines.push(`${label("Dream repair")} ${info(formatDreamingRepairSummary(dreamingRepair))}`);
      if (dreamingRepair.archiveDir) {
        lines.push(`${label("Dream archive")} ${info(shortenHomePath(dreamingRepair.archiveDir))}`);
      }
    }
    if (status.fallback?.reason) {
      lines.push(muted(status.fallback.reason));
    }
    if (indexError) {
      lines.push(`${label("Index error")} ${warn(indexError)}`);
    }
    if (scan?.issues.length) {
      lines.push(label("Issues"));
      for (const issue of scan.issues) {
        lines.push(`  ${warn(issue)}`);
      }
    }
    if (audit?.issues.length) {
      if (!scan?.issues.length) {
        lines.push(label("Issues"));
      }
      for (const issue of audit.issues) {
        lines.push(`  ${issue.severity === "error" ? warn(issue.message) : muted(issue.message)}`);
      }
      if (!opts.fix) {
        if (audit.issues.some((issue) => issue.fixable)) {
          lines.push(`  ${muted(`Fix: openclaw memory status --fix --agent ${agentId}`)}`);
        }
      }
    }
    if (dreamingAudit?.issues.length) {
      if (!scan?.issues.length && !audit?.issues.length) {
        lines.push(label("Issues"));
      }
      for (const issue of dreamingAudit.issues) {
        lines.push(`  ${issue.severity === "error" ? warn(issue.message) : muted(issue.message)}`);
      }
      if (!opts.fix && dreamingAudit.issues.some((issue) => issue.fixable)) {
        lines.push(`  ${muted(`Fix: openclaw memory status --fix --agent ${agentId}`)}`);
      }
    }
    defaultRuntime.log(lines.join("\n"));
    defaultRuntime.log("");
  }
}
