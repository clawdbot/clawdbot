import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";

const FORBIDDEN_NAMESPACE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const NAMESPACE_PATH_KEY_SEPARATOR = "\u0000";
const CODE_MODE_NAMESPACE_TOOL_CALL = Symbol.for("openclaw.codeMode.namespaceToolCall");
const RESERVED_NAMESPACE_GLOBALS = new Set([
  "ALL_TOOLS",
  "Array",
  "Boolean",
  "Date",
  "Error",
  "globalThis",
  "json",
  "JSON",
  "Map",
  "Math",
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

export type CodeModeNamespaceScope = Record<string, unknown>;

export type CodeModeNamespaceToolInputMapper = (args: unknown[]) => unknown;

export type CodeModeNamespaceToolCall = {
  readonly [CODE_MODE_NAMESPACE_TOOL_CALL]: true;
  readonly toolName: string;
  readonly input?: CodeModeNamespaceToolInputMapper;
};

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

export type RegisteredCodeModeNamespace = CodeModeNamespaceRegistration & {
  pluginId: string;
};

export type SerializedCodeModeNamespaceValue =
  | { kind: "array"; items: SerializedCodeModeNamespaceValue[] }
  | { kind: "function"; path: string[] }
  | { kind: "object"; entries: Array<[string, SerializedCodeModeNamespaceValue]> }
  | { kind: "value"; value: unknown };

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
  name: string;
  sourceName?: string;
};

export type CodeModeNamespaceRuntime = {
  descriptors: CodeModeNamespaceDescriptor[];
  invoke(
    namespaceId: string,
    path: string[],
    args: unknown[],
    executeTool: (params: {
      pluginId: string;
      toolName: string;
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

export function unregisterCodeModeNamespace(namespaceId: string): boolean {
  return registryState.registrations.delete(namespaceId.trim());
}

export function listCodeModeNamespaces(): RegisteredCodeModeNamespace[] {
  return [...registryState.registrations.values()].toSorted((a, b) => a.id.localeCompare(b.id));
}

export function clearCodeModeNamespacesForTest(): void {
  registryState.registrations.clear();
}

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

export function describeCodeModeNamespacesForPrompt(
  ctx: CodeModeNamespaceContext,
  catalog?: readonly CodeModeNamespaceCatalogEntry[],
): string {
  if (!catalog) {
    return "";
  }
  const registrations = filterRegistrationsByVisibleTools(catalog);
  if (registrations.length === 0) {
    return "";
  }
  const lines = ["Registered namespace globals are available in code mode:"];
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

export async function createCodeModeNamespaceRuntime(
  ctx: CodeModeNamespaceContext,
  catalog: readonly CodeModeNamespaceCatalogEntry[] = [],
): Promise<CodeModeNamespaceRuntime> {
  const entries: CodeModeNamespaceRuntimeEntry[] = [];
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
      if (!entry.registration.requiredToolNames.includes(target.toolName)) {
        throw new Error(`Code mode namespace path targets undeclared tool: ${target.toolName}`);
      }
      const input = target.input ? await target.input(args) : (args[0] ?? {});
      return toJsonSafe(
        await executeTool({
          pluginId: entry.registration.pluginId,
          toolName: target.toolName,
          input,
          namespaceId,
          path: [...path],
        }),
      );
    },
  };
}
