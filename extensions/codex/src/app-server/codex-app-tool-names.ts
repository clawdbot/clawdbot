import { Buffer } from "node:buffer";
/**
 * Port of the model-visible naming Codex applies to `codex_apps` tools
 * (codex-rs `codex-mcp/src/codex_apps.rs`, `codex-mcp/src/tools.rs`, and
 * `utils/plugins/src/mcp_connector.rs`, rust-v0.153.4). Codex does not expose
 * these names over the app-server protocol, so OpenClaw derives them from the
 * same connector metadata and raw tool names it does.
 */
import { createHash } from "node:crypto";
import { CODEX_APPS_MCP_SERVER, type CodexAppServerTool } from "./app-tool-inventory.js";

const MCP_TOOL_NAME_PREFIX = "mcp__";
const MCP_TOOL_NAME_DELIMITER = "__";
// codex-rs/codex-mcp/src/tools.rs at rust-v0.153.4: `MAX_TOOL_NAME_LENGTH: usize = 128`.
const MAX_TOOL_NAME_LENGTH = 128;
const CALLABLE_NAME_HASH_LEN = 12;

/** `sanitize_name`: lowercase ASCII alphanumerics, everything else `_`, trimmed, `app` if empty. */
export function sanitizeCodexConnectorName(name: string): string {
  let slug = "";
  for (const character of name) {
    slug += /^[A-Za-z0-9]$/.test(character) ? character.toLowerCase() : "-";
  }
  slug = slug.replace(/^-+|-+$/g, "");
  return (slug || "app").replaceAll("-", "_");
}

/** `sanitize_responses_api_tool_name`: ASCII alphanumerics and `_` survive, everything else becomes `_`. */
function sanitizeResponsesApiToolName(name: string): string {
  let sanitized = "";
  for (const character of name) {
    sanitized += /^[A-Za-z0-9_]$/.test(character) ? character : "_";
  }
  return sanitized || "_";
}

/** `normalize_codex_apps_callable_name`: strip the sanitized connector name (then id) prefix. */
function normalizeCallableName(tool: CodexAppServerTool): string {
  const toolName = sanitizeCodexConnectorName(tool.name);
  for (const raw of [tool.connectorName, tool.connectorId]) {
    const prefix = raw?.trim();
    if (!prefix) {
      continue;
    }
    const sanitizedPrefix = sanitizeCodexConnectorName(prefix);
    if (toolName.startsWith(sanitizedPrefix) && toolName.length > sanitizedPrefix.length) {
      return toolName.slice(sanitizedPrefix.length);
    }
  }
  return toolName;
}

/** `normalize_codex_apps_callable_namespace`. */
function normalizeCallableNamespace(tool: CodexAppServerTool): string {
  return tool.connectorName === undefined
    ? CODEX_APPS_MCP_SERVER
    : `${CODEX_APPS_MCP_SERVER}${MCP_TOOL_NAME_DELIMITER}${sanitizeCodexConnectorName(tool.connectorName)}`;
}

function sha1Hex(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function hashSuffix(rawIdentity: string): string {
  return `_${sha1Hex(rawIdentity).slice(0, CALLABLE_NAME_HASH_LEN)}`;
}

function appendNamespaceHashSuffix(namespace: string, rawIdentity: string): string {
  return namespace.endsWith(MCP_TOOL_NAME_DELIMITER)
    ? `${namespace.slice(0, -MCP_TOOL_NAME_DELIMITER.length)}${hashSuffix(rawIdentity)}${MCP_TOOL_NAME_DELIMITER}`
    : `${namespace}${hashSuffix(rawIdentity)}`;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateName(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}

function fitCallablePartsWithHash(
  namespace: string,
  toolName: string,
  rawIdentity: string,
  reservedLength: number,
): [string, string] {
  const suffix = hashSuffix(rawIdentity);
  const maxToolLength = Math.max(
    0,
    MAX_TOOL_NAME_LENGTH - (byteLength(namespace) + reservedLength),
  );
  if (maxToolLength >= suffix.length) {
    return [namespace, `${truncateName(toolName, maxToolLength - suffix.length)}${suffix}`];
  }
  const maxNamespaceLength = Math.max(0, MAX_TOOL_NAME_LENGTH - (suffix.length + reservedLength));
  return [truncateName(namespace, maxNamespaceLength), suffix];
}

function uniqueCallableParts(
  namespace: string,
  toolName: string,
  rawIdentity: string,
  usedNames: Set<string>,
  reservedLength: number,
): [string, string] {
  const modelName = `${namespace}${toolName}`;
  if (byteLength(modelName) + reservedLength <= MAX_TOOL_NAME_LENGTH && !usedNames.has(modelName)) {
    usedNames.add(modelName);
    return [namespace, toolName];
  }
  for (let attempt = 0; ; attempt += 1) {
    const hashInput = attempt === 0 ? rawIdentity : `${rawIdentity}\0${attempt}`;
    const [fitNamespace, fitName] = fitCallablePartsWithHash(
      namespace,
      toolName,
      hashInput,
      reservedLength,
    );
    const candidate = `${fitNamespace}${fitName}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return [fitNamespace, fitName];
    }
  }
}

type Candidate = {
  tool: CodexAppServerTool;
  rawNamespaceIdentity: string;
  rawToolIdentity: string;
  namespace: string;
  name: string;
};

/**
 * `normalize_tools_for_model_with_prefix` for the `codex_apps` server: returns the
 * model-visible name of every tool, computed over the whole inventory so that
 * collision hashing and length fitting match what Codex sends the model.
 */
export function resolveCodexAppModelToolNames(
  tools: readonly CodexAppServerTool[],
): Map<CodexAppServerTool, string> {
  const seenRawIdentities = new Set<string>();
  const candidates: Candidate[] = [];
  for (const tool of tools) {
    const callableNamespace = normalizeCallableNamespace(tool);
    const rawNamespaceIdentity = `${CODEX_APPS_MCP_SERVER}\0${callableNamespace}\0${tool.connectorId}`;
    const rawToolIdentity = `${rawNamespaceIdentity}\0${normalizeCallableName(tool)}\0${tool.name}`;
    if (seenRawIdentities.has(rawToolIdentity)) {
      continue;
    }
    seenRawIdentities.add(rawToolIdentity);
    const sanitizedNamespace = sanitizeResponsesApiToolName(callableNamespace);
    candidates.push({
      tool,
      rawNamespaceIdentity,
      rawToolIdentity,
      namespace: sanitizedNamespace.startsWith(MCP_TOOL_NAME_PREFIX)
        ? sanitizedNamespace
        : `${MCP_TOOL_NAME_PREFIX}${sanitizedNamespace}`,
      name: sanitizeResponsesApiToolName(normalizeCallableName(tool)),
    });
  }
  const namespaceIdentities = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const identities = namespaceIdentities.get(candidate.namespace) ?? new Set<string>();
    identities.add(candidate.rawNamespaceIdentity);
    namespaceIdentities.set(candidate.namespace, identities);
  }
  for (const candidate of candidates) {
    if ((namespaceIdentities.get(candidate.namespace)?.size ?? 0) > 1) {
      candidate.namespace = appendNamespaceHashSuffix(
        candidate.namespace,
        candidate.rawNamespaceIdentity,
      );
    }
  }
  const toolIdentities = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const key = `${candidate.namespace}\0${candidate.name}`;
    const identities = toolIdentities.get(key) ?? new Set<string>();
    identities.add(candidate.rawToolIdentity);
    toolIdentities.set(key, identities);
  }
  for (const candidate of candidates) {
    if ((toolIdentities.get(`${candidate.namespace}\0${candidate.name}`)?.size ?? 0) > 1) {
      candidate.name = `${candidate.name}${hashSuffix(candidate.rawToolIdentity)}`;
    }
  }
  candidates.sort((left, right) =>
    left.rawToolIdentity < right.rawToolIdentity
      ? -1
      : left.rawToolIdentity > right.rawToolIdentity
        ? 1
        : 0,
  );
  const usedNames = new Set<string>();
  const modelNames = new Map<CodexAppServerTool, string>();
  for (const candidate of candidates) {
    const [namespace, name] = uniqueCallableParts(
      candidate.namespace,
      candidate.name,
      candidate.rawToolIdentity,
      usedNames,
      MCP_TOOL_NAME_DELIMITER.length,
    );
    modelNames.set(candidate.tool, `${namespace}${name}`);
  }
  return modelNames;
}

/**
 * Model-visible tool names grouped by connector id, for the whole inventory at once.
 * The flat name the model sees and calls is `namespace + name` with no separator
 * (`flat_tool_name` in codex-rs/core/src/tools/mod.rs); the `__`-joined form in
 * `join_tool_name` (core/src/tools/handlers/mcp.rs) is used only for hook names.
 */
export function resolveCodexAppModelToolNamesByConnector(
  toolsByConnector: ReadonlyMap<string, readonly CodexAppServerTool[]>,
): Map<string, string[]> {
  const modelNames = resolveCodexAppModelToolNames([...toolsByConnector.values()].flat());
  return new Map(
    [...toolsByConnector].map(([connectorId, tools]) => [
      connectorId,
      tools.flatMap((tool) => {
        const modelName = modelNames.get(tool);
        return modelName === undefined ? [] : [modelName];
      }),
    ]),
  );
}
