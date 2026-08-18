/** Materializes connected node-hosted plugin tools for agent runs. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listConnectedNodePluginTools } from "../gateway/node-plugin-tool-snapshot.js";
import {
  NODE_MCP_TOOL_CALL_GATEWAY_TIMEOUT_MS,
  NODE_MCP_TOOL_CALL_TIMEOUT_MS,
  NODE_MCP_TOOLS_CALL_COMMAND,
} from "../infra/node-commands.js";
import { setPluginToolMeta } from "../plugins/tools.js";
import { sanitizeServerName } from "./agent-bundle-mcp-names.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import { projectMcpCallToolResult } from "./mcp-content.js";
import type { AgentToolResult } from "./runtime/index.js";
import { DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY, normalizeToolPolicyName } from "./tool-policy.js";
import { jsonResult } from "./tools/common.js";
import type { AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

const NODE_PLUGIN_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const NODE_PLUGIN_TOOL_NAME_MAX_LENGTH = 64;
const NODE_MCP_PLUGIN_ID = "node-mcp";

type MaterializedNodeToolEntry = ReturnType<typeof listConnectedNodePluginTools>[number] & {
  command: string;
  normalizedName: string;
};

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
  return isRecord(value) && Array.isArray(value.content);
}

function readNodeInvokePayload(value: unknown): unknown {
  return isRecord(value) && "payload" in value ? value.payload : value;
}

function mapMcpPayloadToAgentToolResult(payload: unknown): AgentToolResult<unknown> {
  if (!isRecord(payload)) {
    return jsonResult(payload);
  }
  return projectMcpCallToolResult(payload, payload);
}

function normalizePolicyNames(values: readonly string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => normalizeToolPolicyName(value)).filter(Boolean));
}

function toolPolicyAllows(params: {
  pluginId: string;
  toolName: string;
  exposedToolName?: string;
  allowlist: Set<string>;
  denylist: ReturnType<typeof compileGlobPatterns>;
  registered: boolean;
}): boolean {
  const pluginId = normalizeToolPolicyName(params.pluginId);
  const toolName = normalizeToolPolicyName(params.toolName);
  const exposedToolName = normalizeToolPolicyName(params.exposedToolName ?? params.toolName);
  if (
    matchesAnyGlobPattern(pluginId, params.denylist) ||
    matchesAnyGlobPattern(toolName, params.denylist) ||
    matchesAnyGlobPattern(exposedToolName, params.denylist) ||
    matchesAnyGlobPattern("group:plugins", params.denylist)
  ) {
    return false;
  }
  if (params.allowlist.size === 0 || params.allowlist.has(DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY)) {
    return true;
  }
  // pluginId is node-supplied for unregistered descriptors, so it must not
  // satisfy pluginId-scoped allowlist entries (a node could claim "github").
  // The reserved node-mcp id is safe: real plugins can never register it.
  const pluginIdTrusted = params.registered || pluginId === "node-mcp";
  return (
    params.allowlist.has("*") ||
    params.allowlist.has("group:plugins") ||
    (pluginIdTrusted && params.allowlist.has(pluginId)) ||
    params.allowlist.has(toolName) ||
    params.allowlist.has(exposedToolName)
  );
}

function describeNodeToolLocation(params: {
  description: string;
  displayName?: string;
  nodeId: string;
}): string {
  const label = params.displayName?.trim() || params.nodeId;
  return `${params.description} (node: ${label})`;
}

function sanitizeToolNameFragment(value: string): string {
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

function isProviderSafeToolName(value: string): boolean {
  return NODE_PLUGIN_TOOL_NAME_RE.test(value);
}

function prependToolNameFragment(baseName: string, fragment: string, suffix: string): string {
  const prefix = `${fragment}_`;
  const maxBaseLength = Math.max(
    1,
    NODE_PLUGIN_TOOL_NAME_MAX_LENGTH - prefix.length - suffix.length,
  );
  return `${prefix}${baseName.slice(0, maxBaseLength)}${suffix}`;
}

function resolveUniqueToolName(params: {
  baseName: string;
  normalizedName: string;
  duplicateCount: number;
  nodeId: string;
  existingNormalized: Set<string>;
}): string | null {
  if (params.duplicateCount === 1 && !params.existingNormalized.has(params.normalizedName)) {
    return params.baseName;
  }
  const nodeFragment = sanitizeToolNameFragment(params.nodeId);
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : `_${index + 1}`;
    const candidate = prependToolNameFragment(params.baseName, nodeFragment, suffix);
    const normalized = normalizeToolPolicyName(candidate);
    if (
      isProviderSafeToolName(candidate) &&
      normalized &&
      !params.existingNormalized.has(normalized)
    ) {
      return candidate;
    }
  }
  return null;
}

export function createNodePluginTools(params: {
  existingToolNames?: Set<string>;
  toolAllowlist?: string[];
  toolDenylist?: string[];
  agentSessionKey?: string;
}): AnyAgentTool[] {
  const existingNormalized = new Set(
    [...(params.existingToolNames ?? [])].map((name) => normalizeToolPolicyName(name)),
  );
  const allowlist = normalizePolicyNames(params.toolAllowlist);
  const denylist = compileGlobPatterns({
    raw: params.toolDenylist,
    normalize: normalizeToolPolicyName,
  });
  const entries: MaterializedNodeToolEntry[] = [];
  const nameCounts = new Map<string, number>();
  for (const entry of listConnectedNodePluginTools()) {
    const descriptor = entry.descriptor;
    const command = descriptor.command?.trim();
    const normalizedName = normalizeToolPolicyName(descriptor.name);
    if (!command || !normalizedName) {
      continue;
    }
    entries.push({ ...entry, command, normalizedName });
    nameCounts.set(normalizedName, (nameCounts.get(normalizedName) ?? 0) + 1);
  }

  const tools: AnyAgentTool[] = [];
  for (const entry of entries) {
    const descriptor = entry.descriptor;
    const toolName = resolveUniqueToolName({
      baseName: descriptor.name,
      normalizedName: entry.normalizedName,
      duplicateCount: nameCounts.get(entry.normalizedName) ?? 1,
      nodeId: entry.nodeId,
      existingNormalized,
    });
    if (!toolName) {
      continue;
    }
    if (
      !toolPolicyAllows({
        pluginId: descriptor.pluginId,
        toolName: descriptor.name,
        exposedToolName: toolName,
        allowlist,
        denylist,
        registered: entry.registered,
      })
    ) {
      continue;
    }
    existingNormalized.add(normalizeToolPolicyName(toolName));
    const mcpTool = descriptor.command === NODE_MCP_TOOLS_CALL_COMMAND ? descriptor.mcp : undefined;
    const tool: AnyAgentTool = {
      name: toolName,
      label: toolName,
      description: describeNodeToolLocation({
        description: descriptor.description,
        displayName: entry.displayName,
        nodeId: entry.nodeId,
      }),
      parameters: descriptor.parameters as never,
      ...(mcpTool ? { executionMode: "sequential" as const } : {}),
      execute: async (toolCallId, toolParams, signal) => {
        const raw = await callGatewayTool(
          "node.invoke",
          mcpTool ? { timeoutMs: NODE_MCP_TOOL_CALL_GATEWAY_TIMEOUT_MS } : {},
          {
            nodeId: entry.nodeId,
            command: entry.command,
            params: mcpTool
              ? {
                  server: mcpTool.server,
                  tool: mcpTool.tool,
                  arguments: toolParams,
                }
              : toolParams,
            ...(mcpTool ? { timeoutMs: NODE_MCP_TOOL_CALL_TIMEOUT_MS } : {}),
            idempotencyKey: toolCallId,
            ...(params.agentSessionKey ? { sessionKey: params.agentSessionKey } : {}),
          },
          { scopes: ["operator.write"], ...(signal ? { signal } : {}) },
        );
        const payload = readNodeInvokePayload(raw);
        if (mcpTool) {
          return mapMcpPayloadToAgentToolResult(payload);
        }
        return isAgentToolResult(payload) ? payload : jsonResult(payload);
      },
    };
    setPluginToolMeta(tool, {
      pluginId: descriptor.pluginId,
      optional: false,
      ...(descriptor.mcp
        ? {
            mcp: {
              serverName: descriptor.mcp.server,
              safeServerName: sanitizeServerName(descriptor.mcp.server, new Set<string>()),
              toolName: descriptor.mcp.tool,
              operation: "tool",
              ...(descriptor.pluginId === NODE_MCP_PLUGIN_ID && mcpTool
                ? {
                    node: {
                      id: entry.nodeId,
                      ...(entry.displayName?.trim()
                        ? { displayName: entry.displayName.trim() }
                        : {}),
                    },
                  }
                : {}),
            },
          }
        : {}),
    });
    tools.push(tool);
  }
  return tools;
}
