import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { logWarn } from "../logger.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

export type McpLoopbackTool = ReturnType<typeof resolveGatewayScopedTools>["tools"][number];

export type McpToolSchemaEntry = {
  name: string;
  description: string | undefined;
  inputSchema: Record<string, unknown>;
};

function readLoopbackToolField(tool: McpLoopbackTool, key: "name" | "description" | "parameters") {
  try {
    return (tool as unknown as Record<typeof key, unknown>)[key];
  } catch {
    return undefined;
  }
}

export function readMcpLoopbackToolName(tool: McpLoopbackTool): string | undefined {
  const value = readLoopbackToolField(tool, "name");
  if (typeof value !== "string") {
    return undefined;
  }
  const name = value.trim();
  return name || undefined;
}

function readLoopbackToolDescription(tool: McpLoopbackTool): string | undefined {
  const value = readLoopbackToolField(tool, "description");
  return typeof value === "string" ? value : undefined;
}

function readLoopbackToolParameters(tool: McpLoopbackTool): Record<string, unknown> | undefined {
  let value;
  try {
    value = (tool as unknown as { parameters?: unknown }).parameters;
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return {};
  }
  try {
    return { ...value };
  } catch {
    return undefined;
  }
}

function flattenUnionSchema(raw: Record<string, unknown>): Record<string, unknown> {
  const variants = (raw.anyOf ?? raw.oneOf) as unknown[] | undefined;
  if (!Array.isArray(variants) || variants.length === 0) {
    return raw;
  }
  const mergedProps: Record<string, unknown> = {};
  const requiredSets: Set<string>[] = [];
  for (const variant of variants) {
    if (variant === true) {
      requiredSets.push(new Set());
      continue;
    }
    if (!isRecord(variant)) {
      continue;
    }
    const props = isRecord(variant.properties) ? variant.properties : undefined;
    if (props) {
      for (const [key, schema] of Object.entries(props)) {
        if (!isPropertySchema(schema)) {
          logWarn(`mcp loopback: malformed schema definition for "${key}", ignoring that variant`);
          continue;
        }
        if (!(key in mergedProps)) {
          mergedProps[key] = schema;
          continue;
        }
        const existing = mergedProps[key];
        const incoming = schema;
        if (existing === true || incoming === true) {
          mergedProps[key] = true;
          continue;
        }
        if (existing === false) {
          mergedProps[key] = incoming;
          continue;
        }
        if (incoming === false) {
          continue;
        }
        if (!isRecord(existing) || !isRecord(incoming)) {
          if (existing !== incoming) {
            logWarn(
              `mcp loopback: conflicting schema definitions for "${key}", keeping the first variant`,
            );
          }
          continue;
        }
        if (Array.isArray(existing.enum) && Array.isArray(incoming.enum)) {
          mergedProps[key] = {
            ...existing,
            enum: uniqueValues([...(existing.enum as unknown[]), ...(incoming.enum as unknown[])]),
          };
          continue;
        }
        if ("const" in existing && "const" in incoming && existing.const !== incoming.const) {
          const merged: Record<string, unknown> = {
            ...existing,
            enum: [existing.const, incoming.const],
          };
          delete merged.const;
          mergedProps[key] = merged;
          continue;
        }
        logWarn(
          `mcp loopback: conflicting schema definitions for "${key}", keeping the first variant`,
        );
      }
    }
    requiredSets.push(
      new Set(Array.isArray(variant.required) ? (variant.required as string[]) : []),
    );
  }
  const required =
    requiredSets.length > 0
      ? [...(requiredSets[0] ?? [])].filter(
          (key) => key in mergedProps && requiredSets.every((set) => set.has(key)),
        )
      : [];
  const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = raw;
  return { ...rest, type: "object", properties: mergedProps, required };
}

function isPropertySchema(value: unknown): value is boolean | Record<string, unknown> {
  return typeof value === "boolean" || isRecord(value);
}

export function buildMcpToolSchema(tools: McpLoopbackTool[]): McpToolSchemaEntry[] {
  return tools.flatMap((tool) => {
    const name = readMcpLoopbackToolName(tool);
    if (!name) {
      return [];
    }
    let raw = readLoopbackToolParameters(tool);
    if (!raw) {
      return [];
    }
    if (raw.anyOf || raw.oneOf) {
      raw = flattenUnionSchema(raw);
    }
    if (raw.type !== "object") {
      raw.type = "object";
    }
    if (!raw.properties) {
      raw.properties = {};
    }
    return {
      name,
      description: readLoopbackToolDescription(tool),
      inputSchema: raw,
    };
  });
}
