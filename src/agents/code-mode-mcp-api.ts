import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import type { PluginToolMcpMeta } from "../plugins/tool-metadata.js";

type McpApiParamDoc = {
  name: string;
  required: boolean;
  type: string;
  description?: string;
  defaultValue?: unknown;
};

type McpApiToolDoc = {
  method: string;
  path: string[];
  mcpTool: string;
  operation: PluginToolMcpMeta["operation"];
  description?: string;
  parameters: unknown;
  params: McpApiParamDoc[];
};

export type McpApiServerDoc = {
  identifier: string;
  serverName: string;
  nodeLabel?: string;
  tools: McpApiToolDoc[];
};

/** Virtual TypeScript-style API file exposed to code mode. */
export type CodeModeApiVirtualFile = {
  path: string;
  description?: string;
  content: string;
  bytes: number;
};

export function readMcpSchemaProperties(schema: unknown): Record<string, unknown> {
  const properties = isRecord(schema) ? schema.properties : undefined;
  return isRecord(properties) ? properties : {};
}

export function readMcpRequiredKeys(schema: unknown): string[] {
  const required = isRecord(schema) ? schema.required : undefined;
  return Array.isArray(required)
    ? required.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function escapeDocComment(value: string): string {
  return value.replace(/\*\//gu, "* /").trim();
}

function normalizeDocLines(value: string | undefined): string[] {
  return value
    ? value
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 12)
    : [];
}

function renderDocComment(
  summary: string | undefined,
  params: readonly McpApiParamDoc[],
): string[] {
  const docLines = normalizeDocLines(summary);
  if (docLines.length === 0 && params.length === 0) {
    return [];
  }
  const lines = ["/**", ...docLines.map((line) => ` * ${escapeDocComment(line)}`)];
  if (docLines.length > 0 && params.length > 0) {
    lines.push(" *");
  }
  for (const param of params) {
    const suffix =
      param.defaultValue === undefined ? "" : ` Default: ${JSON.stringify(param.defaultValue)}.`;
    const description = `${normalizeDocLines(param.description).join(" ")}${suffix}`.trim();
    if (description) {
      lines.push(
        ` * @param ${param.name}${param.required ? "" : "?"} ${escapeDocComment(description)}`,
      );
    }
  }
  lines.push(" */");
  return lines;
}

function tsPropertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) ? name : JSON.stringify(name);
}

function renderInlineObjectType(
  schema: unknown,
  params: readonly McpApiParamDoc[],
  depth = 0,
): string {
  const additional = isRecord(schema) ? schema.additionalProperties : undefined;
  const patterns = isRecord(schema) ? schema.patternProperties : undefined;
  const extraType =
    isRecord(patterns) && Object.keys(patterns).length > 0
      ? "unknown"
      : additional === false
        ? "never"
        : schemaType(additional, depth + 1);
  if (params.length === 0) {
    return `Record<string, ${extraType}>`;
  }
  const fields = params.map(
    (param) => `${tsPropertyName(param.name)}${param.required ? "" : "?"}: ${param.type};`,
  );
  if (extraType !== "never") {
    // TypeScript index signatures also cover named properties, unlike JSON Schema's
    // additionalProperties. Include their types so valid named inputs remain expressible.
    const types = new Set([extraType, ...params.map((param) => param.type)]);
    if (params.some((param) => !param.required)) {
      types.add("undefined");
    }
    fields.push(
      `[key: string]: ${types.has("unknown") || types.size > 8 ? "unknown" : [...types].join(" | ")};`,
    );
  }
  return `{ ${fields.join(" ")} }`;
}

function schemaType(schema: unknown, depth = 0): string {
  if (!isRecord(schema) || depth >= 8) {
    return "unknown";
  }
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  const types = new Set(Array.isArray(schema.type) ? schema.type : [schema.type]);
  // Ajv widens the declared types with nullable, then independently applies enum.
  const allowsNull =
    (types.has(undefined) || types.has("null") || schema.nullable === true) &&
    (!enumValues || enumValues.includes(null));
  if (allowsNull && schema.nullable === true) {
    types.add("null");
  }
  if (!allowsNull) {
    types.delete("null");
  }
  if (enumValues && enumValues.length > 0 && enumValues.length <= 16) {
    const compatible = enumValues.filter((entry) => {
      const type = entry === null ? "null" : Array.isArray(entry) ? "array" : typeof entry;
      return (
        types.has(undefined) ||
        types.has(type) ||
        (type === "number" && types.has("integer") && Number.isInteger(entry))
      );
    });
    if (
      compatible.every(
        (entry) =>
          entry === null ||
          typeof entry === "string" ||
          typeof entry === "boolean" ||
          (typeof entry === "number" && Number.isFinite(entry)),
      )
    ) {
      return compatible.map((entry) => JSON.stringify(entry)).join(" | ") || "never";
    }
  }
  const union = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (union && union.length > 0 && union.length <= 8) {
    return union.map((variant) => schemaType(variant, depth + 1)).join(" | ");
  }
  return (
    [...types]
      .map((type) => {
        switch (type) {
          case "integer":
          case "number":
            return "number";
          case "array":
            return `Array<${schemaType(schema.items, depth + 1)}>`;
          case "string":
          case "boolean":
          case "null":
            return type;
          case "object":
            return renderInlineObjectType(schema, buildMcpParamDocs(schema, depth), depth);
          default:
            return "unknown";
        }
      })
      .join(" | ") || "never"
  );
}

export function buildMcpParamDocs(schema: unknown, depth = 0): McpApiParamDoc[] {
  const properties = readMcpSchemaProperties(schema);
  const requiredKeys = readMcpRequiredKeys(schema);
  const required = new Set(requiredKeys);
  return [...new Set([...requiredKeys, ...Object.keys(properties)])].map((key) => {
    const descriptor = properties[key];
    const doc: McpApiParamDoc = {
      name: key,
      required: required.has(key),
      type: schemaType(descriptor, depth + 1),
    };
    if (isRecord(descriptor)) {
      const description =
        typeof descriptor.description === "string" ? descriptor.description.trim() : "";
      if (description) {
        doc.description = description;
      }
      if (Object.hasOwn(descriptor, "default")) {
        doc.defaultValue = descriptor.default;
      }
    }
    return doc;
  });
}

function renderMcpToolSignature(
  tool: McpApiToolDoc,
  functionName = tool.path.at(-1) ?? tool.method,
): string[] {
  const resultType = {
    tool: "McpToolResult",
    resources_list: "McpResourcesListResult",
    resources_read: "McpResourcesReadResult",
    prompts_list: "McpPromptsListResult",
    prompts_get: "McpPromptsGetResult",
  }[tool.operation];
  // The invocation mapper supplies defaults only for top-level arguments.
  const inputParams = tool.params.map((param) => ({
    ...param,
    required: param.required && param.defaultValue === undefined,
  }));
  const optional = inputParams.some((param) => param.required) ? "" : "?";
  return [
    ...renderDocComment(tool.description, inputParams),
    `function ${functionName}(`,
    `  input${optional}: ${renderInlineObjectType(tool.parameters, inputParams)}`,
    `): Promise<${resultType}>;`,
  ];
}

function renderMcpServerHeader(server: McpApiServerDoc, tools: readonly McpApiToolDoc[]): string {
  const lines = [
    "interface McpApiHeader { header: string; tools?: unknown[]; schemas?: Record<string, unknown> }",
    "",
    "interface McpToolResult {",
    "  content: unknown[];",
    "  structuredContent?: unknown;",
    "  isError?: boolean;",
    "}",
    "interface McpResourcesListResult { resources: unknown[]; nextCursor?: string }",
    "interface McpResourcesReadResult { contents: unknown[] }",
    "interface McpPromptsListResult { prompts: unknown[]; nextCursor?: string }",
    "interface McpPromptsGetResult { messages: unknown[]; description?: string }",
    "",
    `declare namespace MCP.${server.identifier} {`,
    "  /** Return this TypeScript-style API header. */",
    "  function $api(toolName?: string, options?: { schema?: boolean }): Promise<McpApiHeader>;",
  ];
  const nestedGroups = new Map<string, McpApiToolDoc[]>();
  for (const tool of tools) {
    if (tool.path.length === 1) {
      lines.push("", ...renderMcpToolSignature(tool).map((line) => `  ${line}`));
      continue;
    }
    const groupName = tool.path[0] ?? "tools";
    const group = nestedGroups.get(groupName);
    if (group) {
      group.push(tool);
    } else {
      nestedGroups.set(groupName, [tool]);
    }
  }
  for (const [groupName, groupTools] of [...nestedGroups].toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    lines.push("", `  namespace ${groupName} {`);
    for (const tool of groupTools) {
      lines.push("", ...renderMcpToolSignature(tool).map((line) => `    ${line}`));
    }
    lines.push("  }");
  }
  lines.push("}");
  return lines.join("\n");
}

function renderMcpRootHeader(): string {
  return [
    "interface McpRootApiHeader { header: string; servers?: unknown[] }",
    "",
    "declare namespace MCP {",
    "  /** List visible MCP servers and request server-specific headers. */",
    "  function $api(): Promise<McpRootApiHeader>;",
    "}",
  ].join("\n");
}

export function buildMcpApiResponse(params: {
  servers: readonly McpApiServerDoc[];
  server?: McpApiServerDoc;
  args: unknown[];
}) {
  const [selector, options] = params.args;
  if (!params.server) {
    return {
      kind: "mcp_api",
      scope: "root",
      header: renderMcpRootHeader(),
      servers: params.servers.map((server) => ({
        identifier: server.identifier,
        serverName: server.serverName,
        toolCount: server.tools.length,
      })),
      note: "Call MCP.<server>.$api() for a TypeScript-style header, then call tools with one object argument matching the shown input type.",
    };
  }
  const selectedName = typeof selector === "string" ? selector.trim() : "";
  const selected = selectedName
    ? params.server.tools.filter(
        (tool) =>
          tool.method === selectedName ||
          tool.path.join(".") === selectedName ||
          tool.mcpTool === selectedName,
      )
    : params.server.tools;
  return {
    kind: "mcp_api",
    scope: selected.length === 1 ? "tool" : "server",
    server: { identifier: params.server.identifier, serverName: params.server.serverName },
    header: renderMcpServerHeader(params.server, selected),
    tools: selected.map((tool) => ({
      method: tool.method,
      path: tool.path,
      mcpTool: tool.mcpTool,
      operation: tool.operation,
      description: tool.description,
    })),
    ...(isRecord(options) && options.schema === true
      ? { schemas: Object.fromEntries(selected.map((tool) => [tool.method, tool.parameters])) }
      : {}),
    note: "Call MCP tools with one object argument, for example MCP.server.tool({ requiredField: value }).",
  };
}

export function createMcpApiVirtualFiles(
  servers: readonly McpApiServerDoc[],
): CodeModeApiVirtualFile[] {
  if (servers.length === 0) {
    return [];
  }
  const rootContent = [
    ...servers.map((server) => `/// <reference path="./${server.identifier}.d.ts" />`),
    "",
    renderMcpRootHeader(),
  ].join("\n");
  return [
    {
      path: "mcp/index.d.ts",
      description: "Root MCP namespace declaration and server list.",
      content: rootContent,
      bytes: Buffer.byteLength(rootContent, "utf8"),
    },
    ...servers.map((server) => {
      const content = renderMcpServerHeader(server, server.tools);
      return {
        path: `mcp/${server.identifier}.d.ts`,
        description: `MCP server declaration for ${server.serverName}.`,
        content,
        bytes: Buffer.byteLength(content, "utf8"),
      };
    }),
  ];
}
