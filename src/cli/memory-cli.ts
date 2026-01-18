import type { Command } from "commander";

import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { setVerbose } from "../globals.js";
import { withProgress, withProgressTotals } from "./progress.js";
import { formatErrorMessage, withManager } from "./cli-utils.js";
import { getMemorySearchManager, type MemorySearchManagerResult } from "../memory/index.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { colorize, isRich, theme } from "../terminal/theme.js";

type MemoryCommandOptions = {
  agent?: string;
  json?: boolean;
  deep?: boolean;
  index?: boolean;
  verbose?: boolean;
};

type MemoryManager = NonNullable<MemorySearchManagerResult["manager"]>;

function resolveAgent(cfg: ReturnType<typeof loadConfig>, agent?: string) {
  const trimmed = agent?.trim();
  if (trimmed) return trimmed;
  return resolveDefaultAgentId(cfg);
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
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions) => {
      setVerbose(Boolean(opts.verbose));
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
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
            await withProgress({ label: "Checking memory…", total: 2 }, async (progress) => {
              progress.setLabel("Probing vector…");
              await manager.probeVectorAvailability();
              progress.tick();
              progress.setLabel("Probing embeddings…");
              embeddingProbe = await manager.probeEmbeddingAvailability();
              progress.tick();
            });
            if (opts.index) {
              await withProgressTotals(
                {
                  label: "Indexing memory…",
                  total: 0,
                  fallback: opts.verbose ? "line" : undefined,
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
            const vectorState = status.vector.enabled
              ? status.vector.available
                ? "ready"
                : "unavailable"
              : "disabled";
            const vectorColor =
              vectorState === "ready"
                ? theme.success
                : vectorState === "unavailable"
                  ? theme.warn
                  : theme.muted;
            lines.push(`${label("Vector")} ${colorize(rich, vectorColor, vectorState)}`);
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
            const ftsState = status.fts.enabled
              ? status.fts.available
                ? "ready"
                : "unavailable"
              : "disabled";
            const ftsColor =
              ftsState === "ready"
                ? theme.success
                : ftsState === "unavailable"
                  ? theme.warn
                  : theme.muted;
            lines.push(`${label("FTS")} ${colorize(rich, ftsColor, ftsState)}`);
            if (status.fts.error) {
              lines.push(`${label("FTS error")} ${warn(status.fts.error)}`);
            }
          }
          if (status.cache) {
            const cacheState = status.cache.enabled ? "enabled" : "disabled";
            const cacheColor = status.cache.enabled ? theme.success : theme.muted;
            const suffix =
              status.cache.enabled && typeof status.cache.entries === "number"
                ? ` (${status.cache.entries} entries)`
                : "";
            lines.push(
              `${label("Embedding cache")} ${colorize(rich, cacheColor, cacheState)}${suffix}`,
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
    .action(async (opts: MemoryCommandOptions & { force?: boolean }) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      await withManager<MemoryManager>({
        getManager: () => getMemorySearchManager({ cfg, agentId }),
        onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
        onCloseError: (err) =>
          defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
        close: (manager) => manager.close(),
        run: async (manager) => {
          try {
            await manager.sync({ reason: "cli", force: opts.force });
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
