import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  MEMORY_QUERY_COLUMNS,
  type MemoryQueryColumn,
  type MemoryQueryFilter,
} from "./lancedb-store.js";

export function parsePositiveIntegerOption(
  value: string | undefined,
  flag: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

export function parseMemoryCliColumns(value: unknown): MemoryQueryColumn[] {
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

export function parseMemoryCliOrder(value: unknown): {
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
