// MCP loopback tool schema projection.
// Converts gateway-scoped tools into MCP tools/list-compatible schemas.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { logWarn } from "../logger.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

// MCP loopback schema projection adapts gateway tool definitions into MCP
// tools/list entries. It flattens provider-hostile union schemas into object
// schemas because some MCP clients cannot render anyOf/oneOf controls.
export type McpLoopbackTool = ReturnType<typeof resolveGatewayScopedTools>["tools"][number];

/** MCP tools/list schema entry derived from a gateway loopback tool. */
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

/** Safely reads and normalizes a loopback tool name from plugin-provided tool objects. */
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

function flattenUnionSchema(
  raw: Record<string, unknown>,
  toolName: string,
): Record<string, unknown> {
  // MCP clients vary in union-schema support. Merge only safe object variants
  // and keep common required fields so generated forms remain usable.
  const variants = (raw.anyOf ?? raw.oneOf) as unknown[] | undefined;
  if (!Array.isArray(variants) || variants.length === 0) {
    return raw;
  }
  const mergedProps = Object.create(null) as Record<string, unknown>;
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
          warnSchemaOnce(
            `mcp loopback: malformed schema definition for "${toolName}.${key}", ignoring that variant`,
          );
          continue;
        }
        if (!Object.hasOwn(mergedProps, key)) {
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
            warnSchemaOnce(
              `mcp loopback: conflicting schema definitions for "${toolName}.${key}", keeping the first variant`,
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
        warnSchemaOnce(
          `mcp loopback: conflicting schema definitions for "${toolName}.${key}", keeping the first variant`,
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
          (key) => Object.hasOwn(mergedProps, key) && requiredSets.every((set) => set.has(key)),
        )
      : [];
  const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = raw;
  return { ...rest, type: "object", properties: mergedProps, required };
}

function isPropertySchema(value: unknown): value is boolean | Record<string, unknown> {
  return typeof value === "boolean" || isRecord(value);
}

// Loopback schemas are rebuilt on every cache miss (per session/owner context and
// after TTL expiry), so raw logWarn would repeat the same field warning endlessly.
// Dedupe on the full message: distinct (tool, field, reason) still each warn once,
// but rebuilds collapse to one line. Named per tool.field so a conflict in one tool
// no longer suppresses a genuinely different conflict on the same field name in
// another tool. Bounded by the process-stable universe of loopback tool + field
// names (gateway tool metadata does not change without restart or explicit reload).
const emittedSchemaWarnings = new Set<string>();

function warnSchemaOnce(message: string) {
  if (emittedSchemaWarnings.has(message)) {
    return;
  }
  emittedSchemaWarnings.add(message);
  logWarn(message);
}

/** Builds MCP-compatible tool schemas for loopback-visible gateway tools. */
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
      raw = flattenUnionSchema(raw, name);
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
