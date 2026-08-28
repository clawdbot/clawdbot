import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import type { PluginToolMcpMeta } from "../plugins/tools.js";

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

function collapseDocText(value: string | undefined): string {
  return normalizeDocLines(value).join(" ");
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
    const description = collapseDocText(param.description);
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

function renderInlineObjectType(schema: unknown): string {
  const properties = readMcpSchemaProperties(schema);
  const keys = Object.keys(properties);
  if (keys.length === 0) {
    return "Record<string, unknown>";
  }
  const required = new Set(readMcpRequiredKeys(schema));
  return `{ ${keys
    .map(
      (key) =>
        `${tsPropertyName(key)}${required.has(key) ? "" : "?"}: ${schemaType(properties[key])}`,
    )
    .join("; ")} }`;
}

function schemaType(schema: unknown): string {
  if (!isRecord(schema)) {
    return "unknown";
  }
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum.filter(
        (entry): entry is string | number | boolean =>
          typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
      )
    : [];
  if (enumValues.length > 0 && enumValues.length <= 16) {
    return enumValues.map((entry) => JSON.stringify(entry)).join(" | ");
  }
  const union = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (union && union.length > 0 && union.length <= 8) {
    return union.map(schemaType).join(" | ");
  }
  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => schemaType({ ...schema, type })).join(" | ");
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `Array<${schemaType(schema.items)}>`;
    case "object":
      return renderInlineObjectType(schema);
    case "null":
      return "null";
    default:
      return Object.keys(readMcpSchemaProperties(schema)).length > 0
        ? renderInlineObjectType(schema)
        : "unknown";
  }
}

export function buildMcpParamDocs(schema: unknown): McpApiParamDoc[] {
  const properties = readMcpSchemaProperties(schema);
  const requiredKeys = readMcpRequiredKeys(schema);
  const required = new Set(requiredKeys);
  return [...new Set([...requiredKeys, ...Object.keys(properties)])].map((key) => {
    const descriptor = properties[key];
    const doc: McpApiParamDoc = {
      name: key,
      required: required.has(key),
      type: schemaType(descriptor),
    };
    if (isRecord(descriptor)) {
      const description =
        typeof descriptor.description === "string" ? descriptor.description.trim() : "";
      if (description) {
        doc.description = description;
      }
      if ("default" in descriptor) {
        doc.defaultValue = descriptor.default;
      }
    }
    return doc;
  });
}

function renderMcpInputType(params: readonly McpApiParamDoc[]): string[] {
  if (params.length === 0) {
    return ["input?: Record<string, never>"];
  }
  const lines = ["input: {"];
  for (const param of params) {
    if (param.description || param.defaultValue !== undefined) {
      const description = collapseDocText(param.description);
      const suffix =
        param.defaultValue === undefined ? "" : ` Default: ${JSON.stringify(param.defaultValue)}.`;
      lines.push(`  /** ${escapeDocComment(`${description}${suffix}`.trim())} */`);
    }
    lines.push(`  ${tsPropertyName(param.name)}${param.required ? "" : "?"}: ${param.type};`);
  }
  lines.push("}");
  return lines;
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
  return [
    ...renderDocComment(tool.description, tool.params),
    `function ${functionName}(`,
    ...renderMcpInputType(tool.params).map((line) => `  ${line}`),
    `): Promise<${resultType}>;`,
  ];
}

function renderMcpServerHeader(server: McpApiServerDoc, tools: readonly McpApiToolDoc[]): string {
  const lines = [
    "type McpApiHeader = { header: string; tools?: unknown[]; schemas?: Record<string, unknown> };",
    "",
    "type McpToolResult = {",
    "  content: unknown[];",
    "  structuredContent?: unknown;",
    "  isError?: boolean;",
    "};",
    "type McpResourcesListResult = { resources: unknown[]; nextCursor?: string };",
    "type McpResourcesReadResult = { contents: unknown[] };",
    "type McpPromptsListResult = { prompts: unknown[]; nextCursor?: string };",
    "type McpPromptsGetResult = { messages: unknown[]; description?: string };",
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

function renderMcpRootHeader(servers: readonly McpApiServerDoc[]): string {
  return [
    "type McpApiHeader = { header: string; servers?: unknown[] };",
    "",
    "declare const MCP: {",
    "  /** List visible MCP servers and request server-specific headers. */",
    "  $api(): Promise<McpApiHeader>;",
    ...servers.map((server) => `  readonly ${server.identifier}: typeof MCP.${server.identifier};`),
    "};",
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
      header: renderMcpRootHeader(params.servers),
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
    renderMcpRootHeader(servers),
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
