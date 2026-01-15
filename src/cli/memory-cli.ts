import chalk from "chalk";
import type { Command } from "commander";

import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { getMemorySearchManager } from "../memory/index.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

type MemoryCommandOptions = {
  agent?: string;
  json?: boolean;
};

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
    .action(async (opts: MemoryCommandOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      if (!manager) {
        defaultRuntime.log(error ?? "Memory search disabled.");
        return;
      }
      const status = manager.status();
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(status, null, 2));
        return;
      }
      const lines = [
        `${chalk.bold.cyan("Memory Search")} (${agentId})`,
        `Provider: ${status.provider} (requested: ${status.requestedProvider})`,
        status.fallback ? chalk.yellow(`Fallback: ${status.fallback.from}`) : null,
        `Files: ${status.files}`,
        `Chunks: ${status.chunks}`,
        `Dirty: ${status.dirty ? "yes" : "no"}`,
        `Index: ${status.dbPath}`,
      ].filter(Boolean) as string[];
      if (status.fallback?.reason) {
        lines.push(chalk.gray(status.fallback.reason));
      }
      defaultRuntime.log(lines.join("\n"));
    });

  memory
    .command("index")
    .description("Reindex memory files")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--force", "Force full reindex", false)
    .action(async (opts: MemoryCommandOptions & { force?: boolean }) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      if (!manager) {
        defaultRuntime.log(error ?? "Memory search disabled.");
        return;
      }
      await manager.sync({ reason: "cli", force: opts.force });
      defaultRuntime.log("Memory index updated.");
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
        const { manager, error } = await getMemorySearchManager({
          cfg,
          agentId,
        });
        if (!manager) {
          defaultRuntime.log(error ?? "Memory search disabled.");
          return;
        }
        const results = await manager.search(query, {
          maxResults: opts.maxResults,
          minScore: opts.minScore,
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify({ results }, null, 2));
          return;
        }
        if (results.length === 0) {
          defaultRuntime.log("No matches.");
          return;
        }
        const lines: string[] = [];
        for (const result of results) {
          lines.push(
            `${chalk.green(result.score.toFixed(3))} ${result.path}:${result.startLine}-${result.endLine}`,
          );
          lines.push(chalk.gray(result.snippet));
          lines.push("");
        }
        defaultRuntime.log(lines.join("\n").trim());
      },
    );
}
