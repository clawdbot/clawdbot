/**
 * Registry and runtime projection for code-mode namespaces. Plugins register
 * namespaced tool scopes here; code mode receives descriptors, virtual API
 * files, and a guarded invocation runtime.
 */
import { tokTypes } from "acorn";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import type { PluginToolMcpMeta } from "../plugins/tools.js";
import { toCodeModeJsonSafe } from "./code-mode-json.js";
import {
  buildMcpApiResponse,
  buildMcpParamDocs,
  createMcpApiVirtualFiles,
  readMcpRequiredKeys,
  readMcpSchemaProperties,
  type CodeModeApiVirtualFile,
  type McpApiServerDoc,
} from "./code-mode-mcp-api.js";

export type { CodeModeApiVirtualFile } from "./code-mode-mcp-api.js";

const FORBIDDEN_NAMESPACE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const NAMESPACE_PATH_KEY_SEPARATOR = "\u0000";
const CODE_MODE_NAMESPACE_TOOL_CALL = Symbol.for("openclaw.codeMode.namespaceToolCall");
const RESERVED_NAMESPACE_GLOBALS = new Set([
  "ALL_TOOLS",
  "agents",
  "API",
  "Array",
  "Boolean",
  "catalog",
  "clearTimeout",
  "Date",
  "Error",
  "globalThis",
  "log",
  "json",
  "JSON",
  "Map",
  "Math",
  "MCP",
  "namespaces",
  "nodes",
  "Number",
  "Object",
  "Promise",
  "phase",
  "Set",
  "setTimeout",
  "skills",
  "String",
  "text",
  "tools",
  "yield_control",
]);
// API declarations use function names, so JS keywords and TypeScript's `enum`
// must be escaped even though those words are valid MCP tool identifiers.
const RESERVED_NAMESPACE_FUNCTION_IDENTIFIERS = new Set([
  ...Object.values(tokTypes).flatMap((token) => (token.keyword ? [token.keyword] : [])),
  "enum",
]);

/** Object installed into a code-mode namespace global. */
type CodeModeNamespaceScope = Record<string, unknown>;

/** Maps JavaScript namespace function arguments into a tool input payload. */
type CodeModeNamespaceToolInputMapper = (args: unknown[]) => unknown;

/** Marker object used inside namespace scopes to represent a tool invocation. */
type CodeModeNamespaceToolCall = {
  readonly [CODE_MODE_NAMESPACE_TOOL_CALL]: true;
  readonly toolName: string;
  readonly catalogId?: string;
  readonly local?: boolean;
  readonly input?: CodeModeNamespaceToolInputMapper;
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
  pluginId: string;
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
  mcp?: PluginToolMcpMeta;
};

/** Runtime dispatcher for invoking callable namespace paths. */
export type CodeModeNamespaceRuntime = {
  descriptors: CodeModeNamespaceDescriptor[];
  apiFiles: CodeModeApiVirtualFile[];
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
    RESERVED_NAMESPACE_FUNCTION_IDENTIFIERS.has(candidate) ||
    FORBIDDEN_NAMESPACE_PATH_SEGMENTS.has(candidate)
  ) {
    candidate = `${base}${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function mapMcpNamespaceInput(schema: unknown, args: unknown[]): unknown {
  if (args.length > 1) {
    throw new Error("MCP namespace tools accept one object argument.");
  }
  const firstArg = args[0];
  const input: Record<string, unknown> =
    firstArg === undefined ? {} : isRecord(firstArg) ? { ...firstArg } : {};
  if (firstArg !== undefined && !isRecord(firstArg)) {
    throw new Error("MCP namespace tools accept one object argument.");
  }
  for (const [key, descriptor] of Object.entries(readMcpSchemaProperties(schema))) {
    if (
      !isRecord(descriptor) ||
      !Object.hasOwn(descriptor, "default") ||
      (Object.hasOwn(input, key) && input[key] !== undefined)
    ) {
      continue;
    }
    // MCP schemas are untrusted; defining an own key keeps __proto__ a value, not a setter.
    Object.defineProperty(input, key, {
      value: descriptor.default,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  const missing = readMcpRequiredKeys(schema).filter(
    (key) => !Object.hasOwn(input, key) || input[key] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required MCP namespace argument${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    );
  }
  return input;
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

type McpNamespaceServer = {
  key: string;
  serverName: string;
  safeServerName: string;
  node?: NonNullable<NonNullable<CodeModeNamespaceCatalogEntry["mcp"]>["node"]>;
};

function mcpNamespaceServerKey(mcp: NonNullable<CodeModeNamespaceCatalogEntry["mcp"]>): string {
  return mcp.node
    ? JSON.stringify(["node", mcp.node.id, mcp.serverName])
    : JSON.stringify(["gateway", mcp.safeServerName]);
}

function sanitizeNodeFragment(value: string): string {
  const fragment = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  if (!fragment) {
    return "node";
  }
  return /^[a-z]/.test(fragment) ? fragment : `node_${fragment}`.slice(0, 32);
}

function assignMcpNamespaceServerNames(
  servers: readonly McpNamespaceServer[],
): Map<string, string> {
  const baseCounts = new Map<string, number>();
  const used = new Set<string>();
  const assignments = new Map<string, string>();
  for (const server of servers) {
    const normalized = server.safeServerName.toLowerCase();
    baseCounts.set(normalized, (baseCounts.get(normalized) ?? 0) + 1);
    if (!server.node) {
      assignments.set(server.key, server.safeServerName);
      used.add(normalized);
    }
  }
  for (const server of servers) {
    if (!server.node || (baseCounts.get(server.safeServerName.toLowerCase()) ?? 0) > 1) {
      continue;
    }
    assignments.set(server.key, server.safeServerName);
    used.add(server.safeServerName.toLowerCase());
  }
  for (const server of servers) {
    if (!server.node || assignments.has(server.key)) {
      continue;
    }
    const base = `${sanitizeNodeFragment(server.node.id)}_${server.safeServerName}`;
    let candidate = base;
    let index = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${base}_${index}`;
      index += 1;
    }
    assignments.set(server.key, candidate);
    used.add(candidate.toLowerCase());
  }
  return assignments;
}

function mcpNodeLabel(node: NonNullable<McpNamespaceServer["node"]>): string {
  return (node.displayName?.trim() || node.id).replace(/\s+/gu, " ").slice(0, 128);
}

function createMcpNamespaceModel(
  catalog: readonly CodeModeNamespaceCatalogEntry[],
): McpNamespaceModel | undefined {
  const mcpEntries = catalog
    .filter((entry) => entry.source === "mcp" && entry.id && entry.mcp)
    .toSorted((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
  if (mcpEntries.length === 0) {
    return undefined;
  }
  const serversByKey = new Map<string, McpNamespaceServer>();
  for (const entry of mcpEntries) {
    const mcp = entry.mcp;
    if (!mcp) {
      continue;
    }
    const key = mcpNamespaceServerKey(mcp);
    if (!serversByKey.has(key)) {
      serversByKey.set(key, {
        key,
        serverName: mcp.serverName,
        safeServerName: mcp.safeServerName,
        ...(mcp.node ? { node: mcp.node } : {}),
      });
    }
  }
  const servers = [...serversByKey.values()].toSorted((a, b) => a.key.localeCompare(b.key));
  const assignedServerNames = assignMcpNamespaceServerNames(servers);
  const serverIdentifiers = new Map<string, string>();
  const usedServerIdentifiers = new Set<string>();
  for (const server of servers) {
    const safeServerName = assignedServerNames.get(server.key) ?? server.safeServerName;
    serverIdentifiers.set(
      server.key,
      uniqueIdentifier(toIdentifier(safeServerName, "server"), usedServerIdentifiers),
    );
  }
  const usedToolIdentifiers = new Map<string, Set<string>>();
  const root = Object.create(null) as CodeModeNamespaceScope;
  const serverDocs = new Map<string, McpApiServerDoc>();
  for (const entry of mcpEntries) {
    const mcp = entry.mcp;
    if (!mcp || !entry.id) {
      continue;
    }
    const serverKey = mcpNamespaceServerKey(mcp);
    const serverIdentifier =
      serverIdentifiers.get(serverKey) ?? uniqueIdentifier("server", usedServerIdentifiers);
    const serverScope = scopeAtPath(root, [serverIdentifier]);
    serverScope.$serverName = mcp.serverName;
    let serverDoc = serverDocs.get(serverIdentifier);
    if (!serverDoc) {
      serverDoc = {
        identifier: serverIdentifier,
        serverName: mcp.serverName,
        ...(mcp.node ? { nodeLabel: mcpNodeLabel(mcp.node) } : {}),
        tools: [],
      };
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
  const docs = [...serverDocs.values()]
    .map((server) =>
      Object.assign({}, server, {
        tools: server.tools.toSorted((a, b) => a.method.localeCompare(b.method)),
      }),
    )
    .toSorted((a, b) => a.identifier.localeCompare(b.identifier));
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

const SWARM_AGENTS_API_CONTENT = `type AgentJsonSchema = Record<string, unknown>;

interface AgentRunOptions {
  label?: string;
  model?: string;
  thinking?: string;
  fastMode?: boolean | "auto";
  agentId?: string;
  schema?: AgentJsonSchema;
  phase?: string;
}

interface AgentsApi {
  run(prompt: string, options?: AgentRunOptions & { schema?: undefined }): Promise<string>;
  run<T>(prompt: string, options: AgentRunOptions & { schema: AgentJsonSchema }): Promise<T>;
}

/** Spawn collector agents concurrently. */
declare const agents: Readonly<AgentsApi>;
/** Publish a phase heading for this swarm. */
declare function phase(title: string): void;
/** Publish a progress note for this swarm. */
declare function log(message: string): void;

// Fan-out: const reports = await Promise.all(prompts.map((prompt) => agents.run(prompt)));
// Gate: while (!ready) { ready = await agents.run("Check readiness") === "ready"; }
// Cycle: for (let pass = 0; pass < 3; pass++) draft = await agents.run("Improve: " + draft);
// Schema: const fact = await agents.run<{ answer: string }>("Research", { schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } });
`;

function createMcpNamespaceEntry(model: McpNamespaceModel): CodeModeNamespaceRuntimeEntry {
  const { root: scope } = model;
  const callablePaths = new Set<string>();
  return {
    pluginId: "bundle-mcp",
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
  const model = createMcpNamespaceModel(catalog);
  if (!model) {
    return [];
  }
  const servers = model.docs.map(
    (server) => `${server.identifier}${server.nodeLabel ? ` (node: ${server.nodeLabel})` : ""}`,
  );
  if (servers.length === 0) {
    return [];
  }
  // Node-backed servers keep the gateway-style name when unique. Collisions
  // use the existing node-id fragment prefix idiom, then a numeric suffix.
  return [
    "- MCP: MCP server tools grouped by server.",
    `Read API files such as mcp/index.d.ts and mcp/<server>.d.ts for TypeScript-style MCP headers; visible servers: ${servers.join(", ")}. Node-backed name collisions use a sanitized node-id fragment prefix.`,
    "Call MCP tools as MCP.<server>.<tool>({ ...input }) with one object argument matching the header.",
  ];
}

/** Builds system-prompt text describing visible code-mode namespace globals. */
export function describeCodeModeNamespacesForPrompt(
  catalog?: readonly CodeModeNamespaceCatalogEntry[],
): string {
  if (!catalog) {
    return "";
  }
  const mcpPrompt = describeMcpNamespaceForPrompt(catalog);
  if (mcpPrompt.length === 0) {
    return "";
  }
  const lines = ["MCP namespace globals are available in code mode:"];
  lines.push(...mcpPrompt);
  return lines.join("\n");
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
      `Code mode namespace function at ${path.join(".") || "(root)"} is not serializable.`,
    );
  }
  if (value === null || typeof value !== "object") {
    return { kind: "value", value: toCodeModeJsonSafe(value) };
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

/** Creates the runtime descriptor/invocation layer for visible namespaces. */
export function createCodeModeNamespaceRuntime(
  catalog: readonly CodeModeNamespaceCatalogEntry[] = [],
): CodeModeNamespaceRuntime {
  const model = createMcpNamespaceModel(catalog);
  const entries = model ? [createMcpNamespaceEntry(model)] : [];
  const byId = new Map(entries.map((entry) => [entry.descriptor.id, entry]));
  return {
    descriptors: entries.map((entry) => entry.descriptor),
    apiFiles: [
      {
        path: "agents.d.ts",
        description: "Swarm collector globals and orchestration idioms.",
        content: SWARM_AGENTS_API_CONTENT,
        bytes: Buffer.byteLength(SWARM_AGENTS_API_CONTENT, "utf8"),
      },
      ...createMcpApiVirtualFiles(model?.docs ?? []),
    ],
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
        return toCodeModeJsonSafe(input);
      }
      if (!target.catalogId) {
        throw new Error(`Code mode namespace path has no catalog tool: ${path.join(".")}`);
      }
      return toCodeModeJsonSafe(
        await executeTool({
          pluginId: entry.pluginId,
          toolName: target.toolName,
          catalogId: target.catalogId,
          input,
          namespaceId,
          path: [...path],
        }),
      );
    },
  };
}
