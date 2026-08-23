import type { CodexPluginConfig } from "./config.js";
import { normalizeCodexDynamicToolName } from "./dynamic-tool-profile.js";

type OpenClawCodingToolsFactory =
  (typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"];
type OpenClawDynamicTool = ReturnType<OpenClawCodingToolsFactory>[number];

export const CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME = "node_exec";
export const CODEX_NODE_PROCESS_DYNAMIC_TOOL_NAME = "node_process";
const CODEX_NODE_EXEC_POLICY_PARAMETER_NAMES = new Set(["host", "security", "ask"]);

/** Returns true when plugin config explicitly removes any named dynamic tool. */
export function isCodexDynamicToolExcluded(
  config: Pick<CodexPluginConfig, "codexDynamicToolsExclude">,
  names: readonly string[],
): boolean {
  const normalizedNames = new Set(names.map((name) => normalizeCodexDynamicToolName(name)));
  return (config.codexDynamicToolsExclude ?? []).some((name) =>
    normalizedNames.has(normalizeCodexDynamicToolName(name)),
  );
}

export function createNodeExecDynamicTool(
  execTool: OpenClawDynamicTool,
  configuredNode: string | undefined,
): OpenClawDynamicTool {
  const pinnedNode = configuredNode?.trim();
  return {
    ...execTool,
    name: CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME,
    description: pinnedNode
      ? "Run a shell command on the OpenClaw configured remote node for this session. This tool always uses OpenClaw host=node internally and follows the existing node exec approval and allowlist policy. Use node_process for follow-up on backgrounded node_exec sessions. Use Codex's native shell for local app-server work."
      : "Run a shell command on an OpenClaw remote node. Select the node by name or id when multiple nodes are available. This tool always uses OpenClaw host=node internally and follows the existing node exec approval and allowlist policy. Use node_process for follow-up on backgrounded node_exec sessions. Use Codex's native shell for local app-server work.",
    parameters: hideNodeExecDynamicToolParameters(execTool.parameters, {
      hideNode: Boolean(pinnedNode),
    }),
    execute: async (toolCallId, args, signal, onUpdate) => {
      const result = await execTool.execute(
        toolCallId,
        pinNodeExecDynamicToolArgs(args, pinnedNode),
        signal,
        onUpdate,
      );
      return {
        ...result,
        content: result.content.map((item) =>
          item.type === "text"
            ? Object.assign({}, item, {
                text: item.text.replace(
                  "Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
                  "Use node_process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.",
                ),
              })
            : item,
        ),
      };
    },
  };
}

export function createNodeProcessDynamicTool(
  processTool: OpenClawDynamicTool,
): OpenClawDynamicTool {
  return {
    ...processTool,
    name: CODEX_NODE_PROCESS_DYNAMIC_TOOL_NAME,
    description:
      "Manage node_exec sessions that were started on OpenClaw remote nodes: list, poll, log, write, send-keys, submit, paste, kill, clear, or remove. Use only for node_exec follow-up; use Codex's native shell session handling for local app-server work.",
  };
}

function pinNodeExecDynamicToolArgs(args: unknown, configuredNode: string | undefined): unknown {
  const source =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const { host: _host, security: _security, ask: _ask, node: requestedNode, ...rest } = source;
  const node = configuredNode ?? (typeof requestedNode === "string" ? requestedNode.trim() : "");
  return {
    ...rest,
    host: "node",
    ...(node ? { node } : {}),
  };
}

function hideNodeExecDynamicToolParameters(
  parameters: OpenClawDynamicTool["parameters"],
  options: { hideNode: boolean },
) {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return parameters;
  }
  const schema = parameters as Record<string, unknown>;
  const rawProperties = schema.properties;
  if (!rawProperties || typeof rawProperties !== "object" || Array.isArray(rawProperties)) {
    return parameters;
  }
  const nextProperties = Object.fromEntries(
    Object.entries(rawProperties).filter(
      ([name]) =>
        !CODEX_NODE_EXEC_POLICY_PARAMETER_NAMES.has(normalizeCodexDynamicToolName(name)) &&
        !(options.hideNode && normalizeCodexDynamicToolName(name) === "node"),
    ),
  );
  const rawRequired = schema.required;
  const nextRequired = Array.isArray(rawRequired)
    ? rawRequired.filter(
        (name) =>
          typeof name !== "string" ||
          (!CODEX_NODE_EXEC_POLICY_PARAMETER_NAMES.has(normalizeCodexDynamicToolName(name)) &&
            !(options.hideNode && normalizeCodexDynamicToolName(name) === "node")),
      )
    : rawRequired;
  return {
    ...schema,
    properties: nextProperties,
    ...(Array.isArray(rawRequired) ? { required: nextRequired } : {}),
  };
}
