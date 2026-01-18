import type { Command } from "commander";

import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { MemorySearchConfig } from "../config/types.tools.js";
import { loadConfig } from "../config/config.js";
import { setVerbose } from "../globals.js";
import { withProgress, withProgressTotals } from "./progress.js";
import { formatErrorMessage, withManager } from "./cli-utils.js";
import { getMemorySearchManager, type MemorySearchManagerResult } from "../memory/index.js";
import {
  resolveMemoryCacheState,
  resolveMemoryFtsState,
  resolveMemoryVectorState,
  type Tone,
} from "../memory/status-format.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { colorize, isRich, theme } from "../terminal/theme.js";

type MemoryCommandOptions = {
  agent?: string;
  json?: boolean;
  deep?: boolean;
  index?: boolean;
  indexMode?: IndexMode;
  progress?: ProgressMode;
  verbose?: boolean;
};

type MemoryManager = NonNullable<MemorySearchManagerResult["manager"]>;
type IndexMode = "auto" | "batch" | "direct";
type ProgressMode = "auto" | "line" | "log" | "none";

function resolveAgent(cfg: ReturnType<typeof loadConfig>, agent?: string) {
  const trimmed = agent?.trim();
  if (trimmed) return trimmed;
  return resolveDefaultAgentId(cfg);
}

function resolveIndexMode(raw?: string): IndexMode {
  if (!raw) return "auto";
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "batch") return "batch";
  if (trimmed === "direct") return "direct";
  return "auto";
}

function resolveProgressMode(raw?: string): ProgressMode {
  if (!raw) return "auto";
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "line") return "line";
  if (trimmed === "log") return "log";
  if (trimmed === "none") return "none";
  return "auto";
}

function applyIndexMode(cfg: ClawdbotConfig, agentId: string, mode: IndexMode): ClawdbotConfig {
  if (mode === "auto") return cfg;
  const enabled = mode === "batch";
  const patchMemorySearch = (memorySearch?: MemorySearchConfig) => {
    const remote = memorySearch?.remote;
    const batch = remote?.batch;
    return {
      ...memorySearch,
      remote: {
        ...remote,
        batch: {
          ...batch,
          enabled,
        },
      },
    };
  };
  const nextAgents = { ...cfg.agents };
  nextAgents.defaults = {
    ...cfg.agents?.defaults,
    memorySearch: patchMemorySearch(cfg.agents?.defaults?.memorySearch),
  };
  if (cfg.agents?.list?.length) {
    nextAgents.list = cfg.agents.list.map((agent) =>
      agent.id === agentId
        ? {
            ...agent,
            memorySearch: patchMemorySearch(agent.memorySearch),
          }
        : agent,
    );
  }
  return { ...cfg, agents: nextAgents };
}

function resolveProgressOptions(
  mode: ProgressMode,
  verbose: boolean,
): { enabled?: boolean; fallback?: "spinner" | "line" | "log" | "none" } {
  if (mode === "none") return { enabled: false, fallback: "none" };
  if (mode === "line") return { fallback: "line" };
  if (mode === "log") return { fallback: "log" };
  return { fallback: verbose ? "line" : undefined };
}

export function registerMemoryCli(program: Command) {
  const memory = program
    .command("memory")
    .description("Memory search tools")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/memory", "docs.clawd.bot/cli/memory")}\n`,
    );

  memory
    .command("status")
    .description("Show memory search index status")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .option("--deep", "Probe embedding provider availability")
    .option("--index", "Reindex if dirty (implies --deep)")
    .option(
      "--index-mode <mode>",
      "Index mode (auto|batch|direct) when indexing",
      "auto",
    )
    .option("--progress <mode>", "Progress output (auto|line|log|none)", "auto")
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions) => {
      setVerbose(Boolean(opts.verbose));
      const rawCfg = loadConfig();
      const agentId = resolveAgent(rawCfg, opts.agent);
      const indexMode = resolveIndexMode(opts.indexMode);
      const progressMode = resolveProgressMode(opts.progress);
      const progressOptions = resolveProgressOptions(progressMode, Boolean(opts.verbose));
      const cfg = applyIndexMode(rawCfg, agentId, indexMode);
      await withManager<MemoryManager>({
        getManager: () => getMemorySearchManager({ cfg, agentId }),
        onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
        onCloseError: (err) =>
          defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
        close: (manager) => manager.close(),
        run: async (manager) => {
          const deep = Boolean(opts.deep || opts.index);
          let embeddingProbe:
            | Awaited<ReturnType<typeof manager.probeEmbeddingAvailability>>
            | undefined;
          let indexError: string | undefined;
          if (deep) {
            await withProgress(
              { label: "Checking memory…", total: 2, ...progressOptions },
              async (progress) => {
              progress.setLabel("Probing vector…");
              await manager.probeVectorAvailability();
              progress.tick();
              progress.setLabel("Probing embeddings…");
              embeddingProbe = await manager.probeEmbeddingAvailability();
              progress.tick();
              },
            );
            if (opts.index) {
              await withProgressTotals(
                {
                  label: "Indexing memory…",
                  total: 0,
                  ...progressOptions,
                },
                async (update, progress) => {
                  try {
                    await manager.sync({
                      reason: "cli",
                      progress: (syncUpdate) => {
                        update({
                          completed: syncUpdate.completed,
                          total: syncUpdate.total,
                          label: syncUpdate.label,
                        });
                        if (syncUpdate.label) progress.setLabel(syncUpdate.label);
                      },
                    });
                  } catch (err) {
                    indexError = formatErrorMessage(err);
                    defaultRuntime.error(`Memory index failed: ${indexError}`);
                    process.exitCode = 1;
                  }
                },
              );
            }
          } else {
            await manager.probeVectorAvailability();
          }
          const status = manager.status();
          if (opts.json) {
            defaultRuntime.log(
              JSON.stringify(
                {
                  ...status,
                  embeddings: embeddingProbe
                    ? { ok: embeddingProbe.ok, error: embeddingProbe.error }
                    : undefined,
                  indexError,
                },
                null,
                2,
              ),
            );
            return;
          }
          if (opts.index) {
            const line = indexError
              ? `Memory index failed: ${indexError}`
              : "Memory index complete.";
            defaultRuntime.log(line);
          }
          const rich = isRich();
          const heading = (text: string) => colorize(rich, theme.heading, text);
          const muted = (text: string) => colorize(rich, theme.muted, text);
          const info = (text: string) => colorize(rich, theme.info, text);
          const success = (text: string) => colorize(rich, theme.success, text);
          const warn = (text: string) => colorize(rich, theme.warn, text);
          const accent = (text: string) => colorize(rich, theme.accent, text);
          const label = (text: string) => muted(`${text}:`);
          const colorForTone = (tone: Tone) =>
            tone === "ok" ? theme.success : tone === "warn" ? theme.warn : theme.muted;
          const lines = [
            `${heading("Memory Search")} ${muted(`(${agentId})`)}`,
            `${label("Provider")} ${info(status.provider)} ${muted(
              `(requested: ${status.requestedProvider})`,
            )}`,
            `${label("Model")} ${info(status.model)}`,
            status.sources?.length
              ? `${label("Sources")} ${info(status.sources.join(", "))}`
              : null,
            `${label("Indexed")} ${success(`${status.files} files · ${status.chunks} chunks`)}`,
            `${label("Dirty")} ${status.dirty ? warn("yes") : muted("no")}`,
            `${label("Store")} ${info(status.dbPath)}`,
            `${label("Workspace")} ${info(status.workspaceDir)}`,
          ].filter(Boolean) as string[];
          if (embeddingProbe) {
            const state = embeddingProbe.ok ? "ready" : "unavailable";
            const stateColor = embeddingProbe.ok ? theme.success : theme.warn;
            lines.push(`${label("Embeddings")} ${colorize(rich, stateColor, state)}`);
            if (embeddingProbe.error) {
              lines.push(`${label("Embeddings error")} ${warn(embeddingProbe.error)}`);
            }
          }
          if (status.sourceCounts?.length) {
            lines.push(label("By source"));
            for (const entry of status.sourceCounts) {
              const counts = `${entry.files} files · ${entry.chunks} chunks`;
              lines.push(`  ${accent(entry.source)} ${muted("·")} ${muted(counts)}`);
            }
          }
          if (status.fallback) {
            lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
          }
          if (status.vector) {
            const vectorState = resolveMemoryVectorState(status.vector);
            const vectorColor = colorForTone(vectorState.tone);
            lines.push(`${label("Vector")} ${colorize(rich, vectorColor, vectorState.state)}`);
            if (status.vector.dims) {
              lines.push(`${label("Vector dims")} ${info(String(status.vector.dims))}`);
            }
            if (status.vector.extensionPath) {
              lines.push(`${label("Vector path")} ${info(status.vector.extensionPath)}`);
            }
            if (status.vector.loadError) {
              lines.push(`${label("Vector error")} ${warn(status.vector.loadError)}`);
            }
          }
          if (status.fts) {
            const ftsState = resolveMemoryFtsState(status.fts);
            const ftsColor = colorForTone(ftsState.tone);
            lines.push(`${label("FTS")} ${colorize(rich, ftsColor, ftsState.state)}`);
            if (status.fts.error) {
              lines.push(`${label("FTS error")} ${warn(status.fts.error)}`);
            }
          }
          if (status.cache) {
            const cacheState = resolveMemoryCacheState(status.cache);
            const cacheColor = colorForTone(cacheState.tone);
            const suffix =
              status.cache.enabled && typeof status.cache.entries === "number"
                ? ` (${status.cache.entries} entries)`
                : "";
            lines.push(
              `${label("Embedding cache")} ${colorize(rich, cacheColor, cacheState.state)}${suffix}`,
            );
            if (status.cache.enabled && typeof status.cache.maxEntries === "number") {
              lines.push(`${label("Cache cap")} ${info(String(status.cache.maxEntries))}`);
            }
          }
          if (status.fallback?.reason) {
            lines.push(muted(status.fallback.reason));
          }
          if (indexError) {
            lines.push(`${label("Index error")} ${warn(indexError)}`);
          }
          defaultRuntime.log(lines.join("\n"));
        },
      });
    });

  memory
    .command("index")
    .description("Reindex memory files")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--force", "Force full reindex", false)
    .option(
      "--index-mode <mode>",
      "Index mode (auto|batch|direct) when indexing",
      "auto",
    )
    .option("--progress <mode>", "Progress output (auto|line|log|none)", "auto")
    .action(async (opts: MemoryCommandOptions & { force?: boolean }) => {
      const rawCfg = loadConfig();
      const agentId = resolveAgent(rawCfg, opts.agent);
      const indexMode = resolveIndexMode(opts.indexMode);
      const progressMode = resolveProgressMode(opts.progress);
      const progressOptions = resolveProgressOptions(progressMode, Boolean(opts.verbose));
      const cfg = applyIndexMode(rawCfg, agentId, indexMode);
      await withManager<MemoryManager>({
        getManager: () => getMemorySearchManager({ cfg, agentId }),
        onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
        onCloseError: (err) =>
          defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
        close: (manager) => manager.close(),
        run: async (manager) => {
          try {
            if (progressMode === "none") {
              await manager.sync({ reason: "cli", force: opts.force });
            } else {
              await withProgressTotals(
                {
                  label: "Indexing memory…",
                  total: 0,
                  ...progressOptions,
                },
                async (update, progress) => {
                  await manager.sync({
                    reason: "cli",
                    force: opts.force,
                    progress: (syncUpdate) => {
                      update({
                        completed: syncUpdate.completed,
                        total: syncUpdate.total,
                        label: syncUpdate.label,
                      });
                      if (syncUpdate.label) progress.setLabel(syncUpdate.label);
                    },
                  });
                },
              );
            }
            defaultRuntime.log("Memory index updated.");
          } catch (err) {
            const message = formatErrorMessage(err);
            defaultRuntime.error(`Memory index failed: ${message}`);
            process.exitCode = 1;
          }
        },
      });
    });

  memory
    .command("search")
    .description("Search memory files")
    .argument("<query>", "Search query")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--max-results <n>", "Max results", (v) => Number(v))
    .option("--min-score <n>", "Minimum score", (v) => Number(v))
    .option("--json", "Print JSON")
    .action(
      async (
        query: string,
        opts: MemoryCommandOptions & {
          maxResults?: number;
          minScore?: number;
        },
      ) => {
        const cfg = loadConfig();
        const agentId = resolveAgent(cfg, opts.agent);
        await withManager<MemoryManager>({
          getManager: () => getMemorySearchManager({ cfg, agentId }),
          onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
          onCloseError: (err) =>
            defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
          close: (manager) => manager.close(),
          run: async (manager) => {
            let results: Awaited<ReturnType<typeof manager.search>>;
            try {
              results = await manager.search(query, {
                maxResults: opts.maxResults,
                minScore: opts.minScore,
              });
            } catch (err) {
              const message = formatErrorMessage(err);
              defaultRuntime.error(`Memory search failed: ${message}`);
              process.exitCode = 1;
              return;
            }
            if (opts.json) {
              defaultRuntime.log(JSON.stringify({ results }, null, 2));
              return;
            }
            if (results.length === 0) {
              defaultRuntime.log("No matches.");
              return;
            }
            const rich = isRich();
            const lines: string[] = [];
            for (const result of results) {
              lines.push(
                `${colorize(rich, theme.success, result.score.toFixed(3))} ${colorize(
                  rich,
                  theme.accent,
                  `${result.path}:${result.startLine}-${result.endLine}`,
                )}`,
              );
              lines.push(colorize(rich, theme.muted, result.snippet));
              lines.push("");
            }
            defaultRuntime.log(lines.join("\n").trim());
          },
        });
      },
    );
}
