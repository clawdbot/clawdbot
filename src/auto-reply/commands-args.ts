import type { CommandArgValues } from "./commands-registry.types.js";

export type CommandArgsFormatter = (values: CommandArgValues) => string | undefined;

function normalizeArgValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

const formatConfigArgs: CommandArgsFormatter = (values) => {
  const action = normalizeArgValue(values.action)?.toLowerCase();
  const path = normalizeArgValue(values.path);
  const value = normalizeArgValue(values.value);
  if (!action) return undefined;
  if (action === "show" || action === "get") {
    return path ? `${action} ${path}` : action;
  }
  if (action === "unset") {
    return path ? `${action} ${path}` : action;
  }
  if (action === "set") {
    if (!path) return action;
    if (!value) return `${action} ${path}`;
    return `${action} ${path}=${value}`;
  }
  return action;
};

const formatDebugArgs: CommandArgsFormatter = (values) => {
  const action = normalizeArgValue(values.action)?.toLowerCase();
  const path = normalizeArgValue(values.path);
  const value = normalizeArgValue(values.value);
  if (!action) return undefined;
  if (action === "show" || action === "reset") {
    return action;
  }
  if (action === "unset") {
    return path ? `${action} ${path}` : action;
  }
  if (action === "set") {
    if (!path) return action;
    if (!value) return `${action} ${path}`;
    return `${action} ${path}=${value}`;
  }
  return action;
};

const formatQueueArgs: CommandArgsFormatter = (values) => {
  const mode = normalizeArgValue(values.mode);
  const debounce = normalizeArgValue(values.debounce);
  const cap = normalizeArgValue(values.cap);
  const drop = normalizeArgValue(values.drop);
  const parts: string[] = [];
  if (mode) parts.push(mode);
  if (debounce) parts.push(`debounce:${debounce}`);
  if (cap) parts.push(`cap:${cap}`);
  if (drop) parts.push(`drop:${drop}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
};

export const COMMAND_ARG_FORMATTERS: Record<string, CommandArgsFormatter> = {
  config: formatConfigArgs,
  debug: formatDebugArgs,
  queue: formatQueueArgs,
};
