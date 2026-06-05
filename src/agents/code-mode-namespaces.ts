/**
 * Registry and runtime projection for code-mode namespaces. Plugins register
 * namespaced tool scopes here; code mode receives descriptors, virtual API
 * files, and a guarded invocation runtime.
 */
import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";

const FORBIDDEN_NAMESPACE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const NAMESPACE_PATH_KEY_SEPARATOR = "\u0000";
const CODE_MODE_NAMESPACE_TOOL_CALL = Symbol.for("openclaw.codeMode.namespaceToolCall");
const RESERVED_NAMESPACE_GLOBALS = new Set([
  "ALL_TOOLS",
  "API",
  "Array",
  "Boolean",
  "Date",
  "Error",
  "globalThis",
  "json",
  "JSON",
  "Map",
  "Math",
  "MCP",
  "namespaces",
  "Number",
  "Object",
  "Promise",
  "Set",
  "String",
  "text",
  "tools",
  "yield_control",
]);
const CODE_MODE_NAMESPACE_REGISTRY_KEY = Symbol.for("openclaw.codeMode.namespaces");

/** Runtime context passed to plugin code-mode namespace scope factories. */
export type CodeModeNamespaceContext = {
  config?: unknown;
  runtimeConfig?: unknown;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  catalogRef?: unknown;
  abortSignal?: AbortSignal;
  executeTool?: unknown;
};

/** Object installed into a code-mode namespace global. */
export type CodeModeNamespaceScope = Record<string, unknown>;

/** Maps JavaScript namespace function arguments into a tool input payload. */
export type CodeModeNamespaceToolInputMapper = (args: unknown[]) => unknown;

/** Marker object used inside namespace scopes to represent a tool invocation. */
export type CodeModeNamespaceToolCall = {
  readonly [CODE_MODE_NAMESPACE_TOOL_CALL]: true;
  readonly toolName: string;
  readonly catalogId?: string;
  readonly local?: boolean;
  readonly input?: CodeModeNamespaceToolInputMapper;
};

/** Plugin registration contract for one code-mode namespace. */
export type CodeModeNamespaceRegistration = {
  id: string;
  globalName: string;
  description?: string;
  prompt?: string | ((ctx: CodeModeNamespaceContext) => string | undefined);
  requiredToolNames: string[];
  createScope(
    ctx: CodeModeNamespaceContext,
  ): CodeModeNamespaceScope | Promise<CodeModeNamespaceScope>;
};

/** Registration with the owning plugin id attached. */
export type RegisteredCodeModeNamespace = CodeModeNamespaceRegistration & {
  pluginId: string;
};

/** JSON-serializable descriptor value emitted to the code-mode runtime. */
export type SerializedCodeModeNamespaceValue =
  | { kind: "array"; items: SerializedCodeModeNamespaceValue[] }
  | { kind: "function"; path: string[] }
  | { kind: "object"; entries: Array<[string, SerializedCodeModeNamespaceValue]> }
  | { kind: "value"; value: unknown };

/** Descriptor sent to code mode for one visible namespace. */
export type CodeModeNamespaceDescriptor = {
  id: string;
  globalName: string;
  description?: string;
  scope: SerializedCodeModeNamespaceValue;
};

type CodeModeNamespaceRuntimeEntry = {
  registration: RegisteredCodeModeNamespace;
  callablePaths: Set<string>;
  scope: CodeModeNamespaceScope;
  descriptor: CodeModeNamespaceDescriptor;
};

type CodeModeNamespaceCatalogEntry = {
  id?: string;
  source?: string;
  name: string;
  sourceName?: string;
  description?: string;
  parameters?: unknown;
  mcp?: {
    serverName: string;
    safeServerName: string;
    toolName: string;
    operation: "tool" | "resources_list" | "resources_read" | "prompts_list" | "prompts_get";
  };
};

/** Runtime dispatcher for invoking callable namespace paths. */
export type CodeModeNamespaceRuntime = {
  descriptors: CodeModeNamespaceDescriptor[];
  invoke(
    namespaceId: string,
    path: string[],
    args: unknown[],
    executeTool: (params: {
      pluginId: string;
      toolName: string;
      catalogId?: string;
      input: unknown;
      namespaceId: string;
      path: string[];
    }) => Promise<unknown>,
  ): Promise<unknown>;
};

type CodeModeNamespaceRegistryState = {
  registrations: Map<string, RegisteredCodeModeNamespace>;
};

const globalWithRegistry = globalThis as typeof globalThis & {
  [CODE_MODE_NAMESPACE_REGISTRY_KEY]?: CodeModeNamespaceRegistryState;
};

const registryState =
  globalWithRegistry[CODE_MODE_NAMESPACE_REGISTRY_KEY] ??
  (globalWithRegistry[CODE_MODE_NAMESPACE_REGISTRY_KEY] = {
    registrations: new Map<string, RegisteredCodeModeNamespace>(),
  });

function normalizeRequiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(normalized)) {
    throw new Error(`Code mode namespace ${label} must be a JavaScript identifier.`);
  }
  return normalized;
}

function normalizeRequiredToolNames(value: readonly string[] | undefined): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Code mode namespace requiredToolNames must include at least one tool name.");
  }
  const names = new Set<string>();
  for (const rawName of value) {
    const name = rawName.trim();
    if (!name) {
      throw new Error("Code mode namespace requiredToolNames must be non-empty strings.");
    }
    names.add(name);
  }
  return [...names].toSorted();
}

/** Creates a namespace function marker for a plugin-owned tool. */
export function createCodeModeNamespaceTool(
  toolName: string,
  input?: CodeModeNamespaceToolInputMapper,
): CodeModeNamespaceToolCall {
  const normalizedToolName = toolName.trim();
  if (!normalizedToolName) {
    throw new Error("Code mode namespace toolName must be non-empty.");
  }
  return {
    [CODE_MODE_NAMESPACE_TOOL_CALL]: true,
    toolName: normalizedToolName,
    ...(input ? { input } : {}),
  };
}

function createCodeModeNamespaceCatalogTool(
  catalogId: string,
  toolName: string,
  input?: CodeModeNamespaceToolInputMapper,
): CodeModeNamespaceToolCall {
  const normalizedCatalogId = catalogId.trim();
  const normalizedToolName = toolName.trim();
  if (!normalizedCatalogId) {
    throw new Error("Code mode namespace catalogId must be non-empty.");
  }
  if (!normalizedToolName) {
    throw new Error("Code mode namespace toolName must be non-empty.");
  }
  return {
    [CODE_MODE_NAMESPACE_TOOL_CALL]: true,
    catalogId: normalizedCatalogId,
    toolName: normalizedToolName,
    ...(input ? { input } : {}),
  };
}

function createCodeModeNamespaceLocalFunction(
  toolName: string,
  input: CodeModeNamespaceToolInputMapper,
): CodeModeNamespaceToolCall {
  const normalizedToolName = toolName.trim();
  if (!normalizedToolName) {
    throw new Error("Code mode namespace local function name must be non-empty.");
  }
  return {
    [CODE_MODE_NAMESPACE_TOOL_CALL]: true,
    toolName: normalizedToolName,
    local: true,
    input,
  };
}

function isCodeModeNamespaceToolCall(value: unknown): value is CodeModeNamespaceToolCall {
  const record = isRecord(value) ? (value as Record<PropertyKey, unknown>) : undefined;
  return (
    record?.[CODE_MODE_NAMESPACE_TOOL_CALL] === true &&
    typeof record.toolName === "string" &&
    record.toolName.trim().length > 0
  );
}

function normalizeRegistration(
  registration: CodeModeNamespaceRegistration,
  pluginId: string,
): RegisteredCodeModeNamespace {
  const id = registration.id.trim();
  if (!id) {
    throw new Error("Code mode namespace id must be non-empty.");
  }
  const normalizedPluginId = pluginId.trim();
  if (!normalizedPluginId) {
    throw new Error("Code mode namespace pluginId must be non-empty.");
  }
  const globalName = normalizeRequiredIdentifier(registration.globalName, "globalName");
  if (RESERVED_NAMESPACE_GLOBALS.has(globalName) || globalName.startsWith("__openclaw")) {
    throw new Error(`Code mode namespace globalName "${globalName}" is reserved.`);
  }
  if (globalName in globalThis) {
    throw new Error(`Code mode namespace globalName "${globalName}" collides with a global.`);
  }
  if (typeof registration.createScope !== "function") {
    throw new Error("Code mode namespace createScope must be a function.");
  }
  return {
    ...registration,
    id,
    pluginId: normalizedPluginId,
    globalName,
    requiredToolNames: normalizeRequiredToolNames(registration.requiredToolNames),
  };
}

/** Registers a plugin namespace after validating id/global/tool contracts. */
export function registerCodeModeNamespaceForPlugin(
  pluginId: string,
  registration: CodeModeNamespaceRegistration,
): void {
  const normalized = normalizeRegistration(registration, pluginId);
  const existingId = registryState.registrations.get(normalized.id);
  if (existingId) {
    throw new Error(`Code mode namespace id "${normalized.id}" is already registered.`);
  }
  for (const existing of registryState.registrations.values()) {
    if (existing.id !== normalized.id && existing.globalName === normalized.globalName) {
      throw new Error(
        `Code mode namespace globalName "${normalized.globalName}" is already registered by "${existing.id}".`,
      );
    }
  }
  registryState.registrations.set(normalized.id, normalized);
}

/** Removes one namespace registration by id. */
export function unregisterCodeModeNamespace(namespaceId: string): boolean {
  return registryState.registrations.delete(namespaceId.trim());
}

/** Lists registered namespaces in deterministic id order. */
export function listCodeModeNamespaces(): RegisteredCodeModeNamespace[] {
  return [...registryState.registrations.values()].toSorted((a, b) => a.id.localeCompare(b.id));
}

/** Clears all namespace registrations for isolated tests. */
export function clearCodeModeNamespacesForTest(): void {
  registryState.registrations.clear();
}

/** Clears namespace registrations owned by one plugin. */
export function clearCodeModeNamespacesForPlugin(pluginId: string): void {
  const normalized = pluginId.trim();
  for (const registration of registryState.registrations.values()) {
    if (registration.pluginId === normalized) {
      registryState.registrations.delete(registration.id);
    }
  }
}

function promptForRegistration(
  registration: RegisteredCodeModeNamespace,
  ctx: CodeModeNamespaceContext,
): string | undefined {
  const prompt =
    typeof registration.prompt === "function" ? registration.prompt(ctx) : registration.prompt;
  return typeof prompt === "string" && prompt.trim() ? prompt.trim() : undefined;
}

function registrationHasVisibleRequiredTools(
  registration: RegisteredCodeModeNamespace,
  catalog: readonly CodeModeNamespaceCatalogEntry[],
): boolean {
  const ownedVisibleToolNames = new Set(
    catalog
      .filter((entry) => entry.sourceName === registration.pluginId)
      .map((entry) => entry.name),
  );
  return registration.requiredToolNames.every((toolName) => ownedVisibleToolNames.has(toolName));
}

function filterRegistrationsByVisibleTools(
  catalog: readonly CodeModeNamespaceCatalogEntry[],
): RegisteredCodeModeNamespace[] {
  return listCodeModeNamespaces().filter((registration) =>
    registrationHasVisibleRequiredTools(registration, catalog),
  );
}

function toIdentifier(value: string, fallback: string): string {
  const words = value
    .trim()
    .split(/[^A-Za-z0-9]+/u)
    .map((word) => word.trim())
    .filter(Boolean);
  const base =
    words.length === 0
      ? fallback
      : words
          .map((word, index) =>
            index === 0
              ? word.charAt(0).toLowerCase() + word.slice(1)
              : word.charAt(0).toUpperCase() + word.slice(1),
          )
          .join("");
  const safe = base.replace(/^[^A-Za-z_$]+/u, "").replace(/[^A-Za-z0-9_$]/gu, "");
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(safe) ? safe : fallback;
}

function uniqueIdentifier(base: string, used: Set<string>): string {
  let candidate = base;
  let index = 2;
  while (
    used.has(candidate) ||
    RESERVED_NAMESPACE_GLOBALS.has(candidate) ||
    FORBIDDEN_NAMESPACE_PATH_SEGMENTS.has(candidate)
  ) {
    candidate = `${base}${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function readSchemaRecord(schema: unknown): Record<string, unknown> | undefined {
  return isRecord(schema) ? schema : undefined;
}

function readSchemaProperties(schema: unknown): Record<string, unknown> {
  const record = readSchemaRecord(schema);
  return isRecord(record?.properties) ? record.properties : {};
}

function readSchemaString(schema: unknown, key: string): string | undefined {
  const record = readSchemaRecord(schema);
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRequiredKeys(schema: unknown): string[] {
  const record = readSchemaRecord(schema);
  return Array.isArray(record?.required)
    ? record.required.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function orderedSchemaKeys(schema: unknown): string[] {
  const required = readRequiredKeys(schema);
  const properties = Object.keys(readSchemaProperties(schema));
  return [...new Set([...required, ...properties])];
}

function applySchemaDefaults(
  schema: unknown,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...input };
  for (const [key, descriptor] of Object.entries(readSchemaProperties(schema))) {
    if (!isRecord(descriptor) || !("default" in descriptor) || result[key] !== undefined) {
      continue;
    }
    result[key] = descriptor.default;
  }
  return result;
}

function mapMcpNamespaceInput(schema: unknown, args: unknown[]): unknown {
  if (args.length > 1) {
    throw new Error("MCP namespace tools accept one object argument.");
  }
  const firstArg = args[0];
  const result: Record<string, unknown> =
    firstArg === undefined ? {} : isRecord(firstArg) ? { ...firstArg } : {};
  if (firstArg !== undefined && !isRecord(firstArg)) {
    throw new Error("MCP namespace tools accept one object argument.");
  }
  const withDefaults = applySchemaDefaults(schema, result);
  const missing = readRequiredKeys(schema).filter((key) => withDefaults[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Missing required MCP namespace argument${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    );
  }
  return withDefaults;
}

function escapeDocComment(value: string): string {
  return value.replace(/\*\//gu, "* /").trim();
}

function indent(lines: string[], prefix: string): string[] {
  return lines.map((line) => `${prefix}${line}`);
}

function renderDocComment(
  summary: string | undefined,
  params: readonly McpApiParamDoc[],
): string[] {
  const lines: string[] = [];
  const docLines = normalizeDocLines(summary);
  if (docLines.length === 0 && params.length === 0) {
    return lines;
  }
  lines.push("/**");
  for (const line of docLines) {
    lines.push(` * ${escapeDocComment(line)}`);
  }
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

function normalizeDocLines(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function collapseDocText(value: string | undefined): string {
  return normalizeDocLines(value).join(" ");
}

function schemaType(schema: unknown): string {
  const record = readSchemaRecord(schema);
  if (!record) {
    return "unknown";
  }
  const enumValues = Array.isArray(record.enum)
    ? record.enum.filter(
        (entry): entry is string | number | boolean =>
          typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
      )
    : [];
  if (enumValues.length > 0 && enumValues.length <= 16) {
    return enumValues.map((entry) => JSON.stringify(entry)).join(" | ");
  }
  const oneOf = Array.isArray(record.oneOf) ? record.oneOf : undefined;
  const anyOf = Array.isArray(record.anyOf) ? record.anyOf : undefined;
  const union = oneOf ?? anyOf;
  if (union && union.length > 0 && union.length <= 8) {
    return union.map((entry) => schemaType(entry)).join(" | ");
  }
  const type = record.type;
  if (Array.isArray(type)) {
    return type.map((entry) => schemaType({ ...record, type: entry })).join(" | ");
  }
  switch (type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `${schemaType(record.items)}[]`;
    case "object":
      return renderInlineObjectType(record);
    case "null":
      return "null";
    default:
      return Object.keys(readSchemaProperties(schema)).length > 0
        ? renderInlineObjectType(record)
        : "unknown";
  }
}

function tsPropertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) ? name : JSON.stringify(name);
}

function renderInlineObjectType(schema: unknown): string {
  const properties = readSchemaProperties(schema);
  const keys = Object.keys(properties);
  if (keys.length === 0) {
    return "Record<string, unknown>";
  }
  const required = new Set(readRequiredKeys(schema));
  return `{ ${keys
    .map(
      (key) =>
        `${tsPropertyName(key)}${required.has(key) ? "" : "?"}: ${schemaType(properties[key])}`,
    )
    .join("; ")} }`;
}

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
  operation: NonNullable<CodeModeNamespaceCatalogEntry["mcp"]>["operation"];
  description?: string;
  parameters: unknown;
  params: McpApiParamDoc[];
};

type McpApiServerDoc = {
  identifier: string;
  serverName: string;
  tools: McpApiToolDoc[];
};

/** Virtual TypeScript-style API file exposed to code mode. */
export type CodeModeApiVirtualFile = {
  path: string;
  description?: string;
  content: string;
};

function buildMcpParamDocs(schema: unknown): McpApiParamDoc[] {
  const required = new Set(readRequiredKeys(schema));
  return orderedSchemaKeys(schema).map((key) => {
    const descriptor = readSchemaProperties(schema)[key];
    const doc: McpApiParamDoc = {
      name: key,
      required: required.has(key),
      type: schemaType(descriptor),
    };
    const description = readSchemaString(descriptor, "description");
    if (description) {
      doc.description = description;
    }
    if (isRecord(descriptor) && "default" in descriptor) {
      doc.defaultValue = descriptor.default;
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
  const lines = renderDocComment(tool.description, tool.params);
  lines.push(`function ${functionName}(`);
  lines.push(...indent(renderMcpInputType(tool.params), "  "));
  lines.push("): Promise<McpToolResult>;");
  return lines;
}

function renderMcpServerHeader(server: McpApiServerDoc, tools: readonly McpApiToolDoc[]): string {
  const lines = [
    "type McpApiHeader = { header: string; tools?: unknown[]; schemas?: Record<string, unknown> };",
    "",
    "type McpToolResult = {",
    "  content?: unknown[];",
    "  structuredContent?: unknown;",
    "  isError?: boolean;",
    "  [key: string]: unknown;",
    "};",
    "",
    `declare namespace MCP.${server.identifier} {`,
    "  /** Return this TypeScript-style API header. */",
    "  function $api(toolName?: string, options?: { schema?: boolean }): Promise<McpApiHeader>;",
  ];
  const topLevelTools = tools.filter((tool) => tool.path.length === 1);
  const nestedTools = tools.filter((tool) => tool.path.length > 1);
  for (const tool of topLevelTools) {
    lines.push("");
    lines.push(...indent(renderMcpToolSignature(tool), "  "));
  }
  const nestedGroups = new Map<string, McpApiToolDoc[]>();
  for (const tool of nestedTools) {
    const groupName = tool.path[0] ?? "tools";
    nestedGroups.set(groupName, [...(nestedGroups.get(groupName) ?? []), tool]);
  }
  for (const [groupName, groupTools] of [...nestedGroups.entries()].toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    lines.push("");
    lines.push(`  namespace ${groupName} {`);
    for (const tool of groupTools) {
      lines.push("");
      lines.push(...indent(renderMcpToolSignature(tool, tool.path.at(-1) ?? tool.method), "    "));
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

function renderMcpRootFile(servers: readonly McpApiServerDoc[]): string {
  const references = servers.map(
    (server) => `/// <reference path="./${server.identifier}.d.ts" />`,
  );
  return [...references, "", renderMcpRootHeader(servers)].join("\n");
}

function buildMcpApiResponse(params: {
  servers: readonly McpApiServerDoc[];
  server?: McpApiServerDoc;
  args: unknown[];
}) {
  const [selector, options] = params.args;
  const includeSchema = isRecord(options) && options.schema === true;
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
  const selected =
    typeof selector === "string" && selector.trim()
      ? params.server.tools.filter(
          (tool) =>
            tool.method === selector.trim() ||
            tool.path.join(".") === selector.trim() ||
            tool.mcpTool === selector.trim(),
        )
      : params.server.tools;
  return {
    kind: "mcp_api",
    scope: selected.length === 1 ? "tool" : "server",
    server: {
      identifier: params.server.identifier,
      serverName: params.server.serverName,
    },
    header: renderMcpServerHeader(params.server, selected),
    tools: selected.map((tool) => ({
      method: tool.method,
      path: tool.path,
      mcpTool: tool.mcpTool,
      operation: tool.operation,
      description: tool.description,
    })),
    ...(includeSchema
      ? {
          schemas: Object.fromEntries(selected.map((tool) => [tool.method, tool.parameters])),
        }
      : {}),
    note: "Call MCP tools with one object argument, for example MCP.server.tool({ requiredField: value }).",
  };
}

function scopeAtPath(
  root: CodeModeNamespaceScope,
  path: readonly string[],
): CodeModeNamespaceScope {
  let current: CodeModeNamespaceScope = root;
  for (const segment of path) {
    const next = current[segment];
    if (!isRecord(next)) {
      const object = Object.create(null) as CodeModeNamespaceScope;
      current[segment] = object;
      current = object;
      continue;
    }
    current = next;
  }
  return current;
}

function toolIdentifiersForServer(
  usedToolIdentifiers: Map<string, Set<string>>,
  serverIdentifier: string,
): Set<string> {
  const existing = usedToolIdentifiers.get(serverIdentifier);
  if (existing) {
    return existing;
  }
  const created = new Set<string>(["$api", "resources", "prompts"]);
  usedToolIdentifiers.set(serverIdentifier, created);
  return created;
}

type McpNamespaceModel = {
  root: CodeModeNamespaceScope;
  docs: McpApiServerDoc[];
};

function createMcpNamespaceModel(
  catalog: readonly CodeModeNamespaceCatalogEntry[],
): McpNamespaceModel | undefined {
  const mcpEntries = catalog.filter((entry) => entry.source === "mcp" && entry.id && entry.mcp);
  if (mcpEntries.length === 0) {
    return undefined;
  }
  const serverNames = new Map<string, string>();
  const usedServerIdentifiers = new Set<string>();
  for (const entry of mcpEntries) {
    const safeServerName = entry.mcp?.safeServerName ?? entry.sourceName ?? "mcp";
    if (serverNames.has(safeServerName)) {
      continue;
    }
    serverNames.set(
      safeServerName,
      uniqueIdentifier(toIdentifier(safeServerName, "server"), usedServerIdentifiers),
    );
  }
  const usedToolIdentifiers = new Map<string, Set<string>>();
  const root = Object.create(null) as CodeModeNamespaceScope;
  const serverDocs = new Map<string, McpApiServerDoc>();
  for (const entry of mcpEntries.toSorted((a, b) => (a.id ?? "").localeCompare(b.id ?? ""))) {
    const mcp = entry.mcp;
    if (!mcp || !entry.id) {
      continue;
    }
    const serverIdentifier =
      serverNames.get(mcp.safeServerName) ?? uniqueIdentifier("server", usedServerIdentifiers);
    const serverScope = scopeAtPath(root, [serverIdentifier]);
    serverScope.$serverName = mcp.serverName;
    let serverDoc = serverDocs.get(serverIdentifier);
    if (!serverDoc) {
      serverDoc = { identifier: serverIdentifier, serverName: mcp.serverName, tools: [] };
      serverDocs.set(serverIdentifier, serverDoc);
    }
    const path =
      mcp.operation === "resources_list"
        ? ["resources", "list"]
        : mcp.operation === "resources_read"
          ? ["resources", "read"]
          : mcp.operation === "prompts_list"
            ? ["prompts", "list"]
            : mcp.operation === "prompts_get"
              ? ["prompts", "get"]
              : [
                  uniqueIdentifier(
                    toIdentifier(mcp.toolName, "tool"),
                    toolIdentifiersForServer(usedToolIdentifiers, serverIdentifier),
                  ),
                ];
    const parent = scopeAtPath(serverScope, path.slice(0, -1));
    parent[path.at(-1) ?? "tool"] = createCodeModeNamespaceCatalogTool(
      entry.id,
      entry.name,
      (args) => mapMcpNamespaceInput(entry.parameters, args),
    );
    serverDoc.tools.push({
      method: path.join("."),
      path,
      mcpTool: mcp.toolName,
      operation: mcp.operation,
      description: entry.description,
      parameters: entry.parameters,
      params: buildMcpParamDocs(entry.parameters),
    });
  }
  const docs = [...serverDocs.values()].map((server) =>
    Object.assign({}, server, {
      tools: server.tools.toSorted((a, b) => a.method.localeCompare(b.method)),
    }),
  );
  root.$api = createCodeModeNamespaceLocalFunction("$api", (args) =>
    buildMcpApiResponse({ servers: docs, args }),
  );
  for (const server of docs) {
    const serverScope = scopeAtPath(root, [server.identifier]);
    serverScope.$api = createCodeModeNamespaceLocalFunction("$api", (args) =>
      buildMcpApiResponse({ servers: docs, server, args }),
    );
  }
  return { root, docs };
}

function createMcpNamespaceScope(
  catalog: readonly CodeModeNamespaceCatalogEntry[],
): CodeModeNamespaceScope | undefined {
  return createMcpNamespaceModel(catalog)?.root;
}

/** Builds virtual API declaration files for visible MCP namespace tools. */
export function createCodeModeApiVirtualFiles(
  catalog: readonly CodeModeNamespaceCatalogEntry[] = [],
): CodeModeApiVirtualFile[] {
  const model = createMcpNamespaceModel(catalog);
  if (!model) {
    return [];
  }
  const files: CodeModeApiVirtualFile[] = [
    {
      path: "mcp/index.d.ts",
      description: "Root MCP namespace declaration and server list.",
      content: renderMcpRootFile(model.docs),
    },
  ];
  for (const server of model.docs) {
    files.push({
      path: `mcp/${server.identifier}.d.ts`,
      description: `MCP server declaration for ${server.serverName}.`,
      content: renderMcpServerHeader(server, server.tools),
    });
  }
  return files;
}

function createMcpNamespaceEntry(
  catalog: readonly CodeModeNamespaceCatalogEntry[],
): CodeModeNamespaceRuntimeEntry | undefined {
  const scope = createMcpNamespaceScope(catalog);
  if (!scope) {
    return undefined;
  }
  const callablePaths = new Set<string>();
  return {
    registration: {
      id: "mcp",
      pluginId: "bundle-mcp",
      globalName: "MCP",
      requiredToolNames: [],
      description: "MCP server tools grouped by server.",
      createScope: () => scope,
    },
    callablePaths,
    scope,
    descriptor: {
      id: "mcp",
      globalName: "MCP",
      description: "MCP server tools grouped by server.",
      scope: serializeNamespaceScopeValue(scope, [], new WeakSet<object>(), callablePaths),
    },
  };
}

function describeMcpNamespaceForPrompt(
  catalog: readonly CodeModeNamespaceCatalogEntry[],
): string[] {
  const scope = createMcpNamespaceScope(catalog);
  if (!scope) {
    return [];
  }
  const servers = Object.entries(scope)
    .filter(([, value]) => isRecord(value) && typeof value.$serverName === "string")
    .map(([key]) => key)
    .toSorted();
  if (servers.length === 0) {
    return [];
  }
  return [
    "- MCP: MCP server tools grouped by server.",
    `Read API files such as mcp/index.d.ts and mcp/<server>.d.ts for TypeScript-style MCP headers; visible servers: ${servers.join(", ")}.`,
    "Call MCP tools as MCP.<server>.<tool>({ ...input }) with one object argument matching the header.",
  ];
}

/** Builds system-prompt text describing visible code-mode namespace globals. */
export function describeCodeModeNamespacesForPrompt(
  ctx: CodeModeNamespaceContext,
  catalog?: readonly CodeModeNamespaceCatalogEntry[],
): string {
  if (!catalog) {
    return "";
  }
  const registrations = filterRegistrationsByVisibleTools(catalog);
  const mcpPrompt = describeMcpNamespaceForPrompt(catalog);
  if (registrations.length === 0 && mcpPrompt.length === 0) {
    return "";
  }
  const lines = ["Registered namespace globals are available in code mode:"];
  lines.push(...mcpPrompt);
  for (const registration of registrations) {
    const description = registration.description?.trim();
    lines.push(
      description ? `- ${registration.globalName}: ${description}` : `- ${registration.globalName}`,
    );
    const prompt = promptForRegistration(registration, ctx);
    if (prompt) {
      lines.push(prompt);
    }
  }
  return lines.join("\n");
}

function toJsonSafe(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : (JSON.parse(serialized) as unknown);
  } catch {
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    if (value === null) {
      return null;
    }
    switch (typeof value) {
      case "string":
      case "number":
      case "boolean":
        return value;
      case "bigint":
      case "symbol":
      case "function":
        return String(value);
      default:
        return Object.prototype.toString.call(value);
    }
  }
}

function assertNamespacePathSegment(segment: string): void {
  if (
    !segment ||
    segment.includes(NAMESPACE_PATH_KEY_SEPARATOR) ||
    FORBIDDEN_NAMESPACE_PATH_SEGMENTS.has(segment)
  ) {
    throw new Error(`Invalid code mode namespace path segment: ${segment || "(empty)"}`);
  }
}

function namespacePathKey(path: readonly string[]): string {
  return path.join(NAMESPACE_PATH_KEY_SEPARATOR);
}

function serializeNamespaceScopeValue(
  value: unknown,
  path: string[] = [],
  stack = new WeakSet<object>(),
  callablePaths = new Set<string>(),
): SerializedCodeModeNamespaceValue {
  if (isCodeModeNamespaceToolCall(value)) {
    callablePaths.add(namespacePathKey(path));
    return { kind: "function", path };
  }
  if (typeof value === "function") {
    throw new Error(
      `Code mode namespace function at ${path.join(".") || "(root)"} must be created with createCodeModeNamespaceTool.`,
    );
  }
  if (value === null || typeof value !== "object") {
    return { kind: "value", value: toJsonSafe(value) };
  }
  if (stack.has(value)) {
    throw new Error(`Circular code mode namespace scope at ${path.join(".") || "(root)"}.`);
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return {
        kind: "array",
        items: value.map((item, index) =>
          serializeNamespaceScopeValue(item, [...path, String(index)], stack, callablePaths),
        ),
      };
    }
    const entries: Array<[string, SerializedCodeModeNamespaceValue]> = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertNamespacePathSegment(key);
      entries.push([
        key,
        serializeNamespaceScopeValue(child, [...path, key], stack, callablePaths),
      ]);
    }
    return { kind: "object", entries };
  } finally {
    stack.delete(value);
  }
}

function resolveNamespacePath(
  scope: CodeModeNamespaceScope,
  path: readonly string[],
): {
  target: unknown;
  parent: unknown;
} {
  let current: unknown = scope;
  let parent: unknown = undefined;
  for (const segment of path) {
    assertNamespacePathSegment(segment);
    parent = current;
    if (!isRecord(current) && !Array.isArray(current)) {
      return { target: undefined, parent };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { target: current, parent };
}

function readScope(value: unknown, id: string): CodeModeNamespaceScope {
  if (!isRecord(value)) {
    throw new Error(`Code mode namespace "${id}" createScope must return an object.`);
  }
  return value;
}

/** Creates the runtime descriptor/invocation layer for visible namespaces. */
export async function createCodeModeNamespaceRuntime(
  ctx: CodeModeNamespaceContext,
  catalog: readonly CodeModeNamespaceCatalogEntry[] = [],
): Promise<CodeModeNamespaceRuntime> {
  const entries: CodeModeNamespaceRuntimeEntry[] = [];
  const mcpEntry = createMcpNamespaceEntry(catalog);
  if (mcpEntry) {
    entries.push(mcpEntry);
  }
  for (const registration of listCodeModeNamespaces()) {
    if (!registrationHasVisibleRequiredTools(registration, catalog)) {
      continue;
    }
    const scope = readScope(await registration.createScope(ctx), registration.id);
    const callablePaths = new Set<string>();
    entries.push({
      registration,
      callablePaths,
      scope,
      descriptor: {
        id: registration.id,
        globalName: registration.globalName,
        ...(registration.description?.trim()
          ? { description: registration.description.trim() }
          : {}),
        scope: serializeNamespaceScopeValue(scope, [], new WeakSet<object>(), callablePaths),
      },
    });
  }
  const byId = new Map(entries.map((entry) => [entry.registration.id, entry]));
  return {
    descriptors: entries.map((entry) => entry.descriptor),
    async invoke(namespaceId, path, args, executeTool) {
      const entry = byId.get(namespaceId);
      if (!entry) {
        throw new Error(`Unknown code mode namespace: ${namespaceId}`);
      }
      for (const segment of path) {
        assertNamespacePathSegment(segment);
      }
      if (!entry.callablePaths.has(namespacePathKey(path))) {
        throw new Error(`Code mode namespace path is not callable: ${path.join(".")}`);
      }
      const { target } = resolveNamespacePath(entry.scope, path);
      if (!isCodeModeNamespaceToolCall(target)) {
        throw new Error(`Code mode namespace path is not callable: ${path.join(".")}`);
      }
      const input = target.input ? await target.input(args) : (args[0] ?? {});
      if (target.local) {
        return toJsonSafe(input);
      }
      if (!target.catalogId && !entry.registration.requiredToolNames.includes(target.toolName)) {
        throw new Error(`Code mode namespace path targets undeclared tool: ${target.toolName}`);
      }
      return toJsonSafe(
        await executeTool({
          pluginId: entry.registration.pluginId,
          toolName: target.toolName,
          ...(target.catalogId ? { catalogId: target.catalogId } : {}),
          input,
          namespaceId,
          path: [...path],
        }),
      );
    },
  };
}
