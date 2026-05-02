import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type { CommandArgValues } from "./commands-registry.types.js";

type CommandArgsFormatter = (values: CommandArgValues) => string | undefined;

function normalizeArgValue(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  let text: string;
  if (typeof value === "string") {
    text = normalizeOptionalString(value) ?? "";
  } else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    text = normalizeOptionalString(String(value)) ?? "";
  } else if (typeof value === "symbol") {
    text = normalizeOptionalString(value.toString()) ?? "";
  } else if (typeof value === "function") {
    text = normalizeOptionalString(value.toString()) ?? "";
  } else {
    // Objects and arrays
    text = JSON.stringify(value);
  }
  return text ? text : undefined;
}

function formatActionArgs(
  values: CommandArgValues,
  params: {
    formatKnownAction: (action: string, path: string | undefined) => string | undefined;
  },
): string | undefined {
  const action = normalizeOptionalLowercaseString(normalizeArgValue(values.action));
  const path = normalizeArgValue(values.path);
  const value = normalizeArgValue(values.value);
  if (!action) {
    return undefined;
  }
  const knownAction = params.formatKnownAction(action, path);
  if (knownAction) {
    return knownAction;
  }
  return formatSetUnsetArgAction(action, { path, value });
}

const formatConfigArgs: CommandArgsFormatter = (values) =>
  formatActionArgs(values, {
    formatKnownAction: (action, path) => {
      if (action === "show" || action === "get") {
        return path ? `${action} ${path}` : action;
      }
      return undefined;
    },
  });

const formatMcpArgs: CommandArgsFormatter = (values) =>
  formatActionArgs(values, {
    formatKnownAction: (action, path) => {
      if (action === "show" || action === "get") {
        return path ? `${action} ${path}` : action;
      }
      return undefined;
    },
  });

const formatPluginsArgs: CommandArgsFormatter = (values) =>
  formatActionArgs(values, {
    formatKnownAction: (action, path) => {
      if (action === "list") {
        return "list";
      }
      if (action === "show" || action === "get") {
        return path ? `${action} ${path}` : action;
      }
      if (action === "enable" || action === "disable") {
        return path ? `${action} ${path}` : action;
      }
      return undefined;
    },
  });

const formatDebugArgs: CommandArgsFormatter = (values) =>
  formatActionArgs(values, {
    formatKnownAction: (action) => {
      if (action === "show" || action === "reset") {
        return action;
      }
      return undefined;
    },
  });

function formatSetUnsetArgAction(
  action: string,
  params: { path: string | undefined; value: string | undefined },
): string {
  if (action === "unset") {
    return params.path ? `${action} ${params.path}` : action;
  }
  if (action === "set") {
    if (!params.path) {
      return action;
    }
    if (!params.value) {
      return `${action} ${params.path}`;
    }
    return `${action} ${params.path}=${params.value}`;
  }
  return action;
}

const formatQueueArgs: CommandArgsFormatter = (values) => {
  const mode = normalizeArgValue(values.mode);
  const debounce = normalizeArgValue(values.debounce);
  const cap = normalizeArgValue(values.cap);
  const drop = normalizeArgValue(values.drop);
  const parts: string[] = [];
  if (mode) {
    parts.push(mode);
  }
  if (debounce) {
    parts.push(`debounce:${debounce}`);
  }
  if (cap) {
    parts.push(`cap:${cap}`);
  }
  if (drop) {
    parts.push(`drop:${drop}`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
};

const formatExecArgs: CommandArgsFormatter = (values) => {
  const host = normalizeArgValue(values.host);
  const security = normalizeArgValue(values.security);
  const ask = normalizeArgValue(values.ask);
  const node = normalizeArgValue(values.node);
  const parts: string[] = [];
  if (host) {
    parts.push(`host=${host}`);
  }
  if (security) {
    parts.push(`security=${security}`);
  }
  if (ask) {
    parts.push(`ask=${ask}`);
  }
  if (node) {
    parts.push(`node=${node}`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
};

export const COMMAND_ARG_FORMATTERS: Record<string, CommandArgsFormatter> = {
  config: formatConfigArgs,
  mcp: formatMcpArgs,
  plugins: formatPluginsArgs,
  debug: formatDebugArgs,
  queue: formatQueueArgs,
  exec: formatExecArgs,
};
