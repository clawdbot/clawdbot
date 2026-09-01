import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime";
import type { OpenClawPluginApi } from "./api.js";
import { isMemoryMachineOutput } from "./cli-output-mode.js";
import type { MemoryConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import {
  MEMORY_QUERY_COLUMNS,
  type MemoryQueryColumn,
  type MemoryQueryFilter,
  type MemoryDB,
} from "./lancedb-store.js";
import { normalizeRecallQuery } from "./memory-policy.js";

function parsePositiveIntegerOption(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseMemoryCliColumns(value: unknown): MemoryQueryColumn[] {
  if (typeof value !== "string") {
    return [...MEMORY_QUERY_COLUMNS];
  }
  const columns = value.split(",").map((column) => column.trim());
  const invalid = columns.filter(
    (column): column is string =>
      !MEMORY_QUERY_COLUMNS.includes(column as (typeof MEMORY_QUERY_COLUMNS)[number]),
  );
  if (invalid.length > 0) {
    throw new Error(`Unsupported memory columns: ${invalid.join(", ")}`);
  }
  return columns as MemoryQueryColumn[];
}

function parseMemoryCliOrder(value: unknown): {
  column: MemoryQueryColumn;
  direction: 1 | -1;
} | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const [column, direction = "asc", extra] = value.split(":");
  if (
    extra !== undefined ||
    !MEMORY_QUERY_COLUMNS.includes(column as MemoryQueryColumn) ||
    !["asc", "desc"].includes(direction.toLowerCase())
  ) {
    throw new Error("--order-by must be <id|text|importance|category|createdAt>:<asc|desc>");
  }
  return {
    column: column as MemoryQueryColumn,
    direction: direction.toLowerCase() === "desc" ? -1 : 1,
  };
}

export function parseMemoryCliFilter(rawValue: unknown): MemoryQueryFilter | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  if (typeof rawValue !== "string") {
    throw new Error("--filter must be a string");
  }
  const filter = rawValue.trim();
  if (filter.length > 200) {
    throw new Error("Filter condition exceeds maximum length of 200 characters");
  }
  const match =
    /^(id|text|importance|category|createdAt)\s*(=|!=|<>|<=|>=|<|>|LIKE)\s*(?:'((?:''|[^'])*)'|(-?(?:\d+(?:\.\d+)?|\.\d+)))$/i.exec(
      filter,
    );
  if (!match) {
    throw new Error(
      "--filter must be one comparison using id, text, importance, category, or createdAt",
    );
  }
  const rawColumn = match[1]!;
  const rawOperator = match[2]!;
  const rawString = match[3];
  const rawNumber = match[4];
  const column = MEMORY_QUERY_COLUMNS.find(
    (candidate) => candidate.toLowerCase() === rawColumn.toLowerCase(),
  );
  if (!column) {
    throw new Error(`Unsupported memory filter column: ${rawColumn}`);
  }
  const operator = rawOperator.toUpperCase() as MemoryQueryFilter["operator"];
  const value = rawString !== undefined ? rawString.replaceAll("''", "'") : Number(rawNumber);
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("--filter numeric value must be finite");
  }
  const expectsNumber = column === "importance" || column === "createdAt";
  if (expectsNumber !== (typeof value === "number")) {
    throw new Error(`--filter ${column} requires a ${expectsNumber ? "number" : "quoted string"}`);
  }
  if (operator === "LIKE" && typeof value !== "string") {
    throw new Error("--filter LIKE requires a quoted string");
  }
  return { column, operator, value };
}

export function registerMemoryCli(
  api: OpenClawPluginApi,
  db: MemoryDB,
  embeddings: Embeddings,
  resolveCliAgentId: (rawAgentId: unknown) => string,
  resolveConfig: () => MemoryConfig,
): void {
  api.registerCli(
    ({ program }) => {
      const memory = program.command("ltm").description("LanceDB memory plugin commands");

      memory
        .command("list")
        .description("List memories")
        .option("--agent <id>", "Agent id (default: configured default agent)")
        .option("--limit <n>", "Max results")
        .option("--order-by-created-at", "Order memories by createdAt descending", false)
        .action(async (opts) => {
          const agentId = resolveCliAgentId(opts.agent);
          const limit = parsePositiveIntegerOption(opts.limit, "--limit");
          const entries = await db.list(agentId, limit, {
            orderByCreatedAt: Boolean(opts.orderByCreatedAt),
          });
          defaultRuntime.writeJson(entries);
        });

      memory
        .command("search")
        .description("Search memories")
        .argument("<query>", "Search query")
        .option("--agent <id>", "Agent id (default: configured default agent)")
        .option("--limit <n>", "Max results", "5")
        .action(async (query, opts) => {
          let operationError: unknown;
          let operationFailed = false;
          try {
            const agentId = resolveCliAgentId(opts.agent);
            const limit = parsePositiveIntegerOption(opts.limit, "--limit");
            const config = resolveConfig();
            const vector = await embeddings.embed(
              agentId,
              normalizeRecallQuery(query, config.recallMaxChars),
              config.embedding,
            );
            const results = await db.search(agentId, vector, limit, 0.3);
            const output = results.map((r) => ({
              id: r.entry.id,
              text: r.entry.text,
              category: r.entry.category,
              importance: r.entry.importance,
              score: r.score,
            }));
            defaultRuntime.writeJson(output);
          } catch (err) {
            operationError = err;
            operationFailed = true;
          }
          let closeError: unknown;
          let closeFailed = false;
          try {
            await embeddings.close?.();
          } catch (err) {
            closeError = err;
            closeFailed = true;
          }
          if (operationFailed) {
            throw operationError;
          }
          if (closeFailed) {
            throw closeError;
          }
        });

      memory
        .command("query")
        .description("Query memories (non-vector search)")
        .option("--agent <id>", "Agent id (default: configured default agent)")
        .option("--cols <columns>", "Columns to select, comma-separated")
        .option("--filter <condition>", "Filter condition")
        .option("--limit <n>", "Limit number of results", "10")
        .option("--order-by <order>", "Order by column and direction (e.g., createdAt:desc)")
        .action(async (opts) => {
          const agentId = resolveCliAgentId(opts.agent);
          const outputColumns = parseMemoryCliColumns(opts.cols);
          const order = parseMemoryCliOrder(opts.orderBy);
          const selectedColumns = [...outputColumns];
          if (order && !selectedColumns.includes(order.column)) {
            selectedColumns.push(order.column);
          }
          const limit = parsePositiveIntegerOption(opts.limit, "--limit") ?? 10;
          let rows = await db.query(agentId, {
            columns: selectedColumns,
            filter: parseMemoryCliFilter(opts.filter),
            ...(order ? {} : { limit }),
          });
          if (order) {
            rows.sort((a, b) => {
              const aValue = a[order.column] as number | string;
              const bValue = b[order.column] as number | string;
              if (aValue < bValue) {
                return -1 * order.direction;
              }
              if (aValue > bValue) {
                return order.direction;
              }
              return 0;
            });
            rows = rows.slice(0, limit);
          }
          // Arrow rows are schema-backed proxies; project output without mutating them.
          defaultRuntime.writeJson(
            rows.map((row) =>
              Object.fromEntries(outputColumns.map((column) => [column, row[column]])),
            ),
          );
        });

      memory
        .command("stats")
        .description("Show memory statistics")
        .option("--agent <id>", "Agent id (default: configured default agent)")
        .action(async (opts) => {
          const agentId = resolveCliAgentId(opts.agent);
          const count = await db.count(agentId);
          console.log(`Total memories: ${count}`);
        });
    },
    {
      commands: ["ltm"],
      descriptors: [
        {
          name: "ltm",
          description: "LanceDB memory plugin commands",
          hasSubcommands: true,
          machineOutput: isMemoryMachineOutput,
        },
      ],
    },
  );
}
