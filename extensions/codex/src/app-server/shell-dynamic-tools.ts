import {
  pinExecToolTarget,
  type CodexScheduledToolProjectionFactory,
} from "openclaw/plugin-sdk/codex-mcp-projection";
import type { CodexPluginConfig } from "./config.js";
import { normalizeCodexDynamicToolName } from "./dynamic-tool-profile.js";

type OpenClawCodingToolsFactory =
  (typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"];
type OpenClawDynamicTool = ReturnType<OpenClawCodingToolsFactory>[number];

export const CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME = "node_exec";
export const CODEX_GATEWAY_EXEC_DYNAMIC_TOOL_NAME = "gateway_exec";
export const CODEX_GATEWAY_PROCESS_DYNAMIC_TOOL_NAME = "gateway_process";
const PROCESS_FOLLOWUP_TEXT =
  "Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.";

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

export function createNodeExecAliasDynamicTool(
  execTool: OpenClawDynamicTool,
  node?: string,
): OpenClawDynamicTool {
  const pinnedNode = node?.trim();
  const pinnedTool = pinExecToolTarget(execTool, {
    host: "node",
    ...(pinnedNode ? { node: pinnedNode } : {}),
  });
  const execute: OpenClawDynamicTool["execute"] = async (toolCallId, args, signal, onUpdate) => {
    const result = await pinnedTool.execute(toolCallId, args, signal, onUpdate);
    return {
      ...result,
      content: result.content.map((item) =>
        item.type === "text"
          ? Object.assign({}, item, {
              text: item.text.replace(
                PROCESS_FOLLOWUP_TEXT,
                "Remote-node background follow-up is unavailable. Wait for the command to complete.",
              ),
            })
          : item,
      ),
    };
  };
  return {
    ...pinnedTool,
    name: CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME,
    description: pinnedNode
      ? "Run a shell command to completion on the OpenClaw configured remote node for this session. This tool always uses OpenClaw host=node internally and follows the existing node exec approval and allowlist policy. Remote-node background follow-up is unavailable. Use Codex's native shell for local app-server work."
      : "Run a shell command to completion on an OpenClaw remote node. The sole connected node that can execute commands is selected automatically; select by name or id when several can. This tool always uses OpenClaw host=node internally and follows the existing node exec approval and allowlist policy. Remote-node background follow-up is unavailable. Use Codex's native shell for local app-server work.",
    execute,
  };
}

export function createGatewayExecProjection(
  createProjection: CodexScheduledToolProjectionFactory,
  execTool: OpenClawDynamicTool,
  params: { processAliasAvailable: boolean; ask?: "always" },
): OpenClawDynamicTool {
  return createProjection(execTool, {
    kind: "exec",
    name: CODEX_GATEWAY_EXEC_DYNAMIC_TOOL_NAME,
    description:
      "Run a shell command through OpenClaw on the Gateway host for OpenClaw-managed Gateway environment access, including Secret Store agent-readable environment values and protected egress sentinels. Native Codex shell remains preferred for ordinary local work. This tool always uses OpenClaw host=gateway internally and follows Gateway exec approval and allowlist policy.",
    followupText: params.processAliasAvailable
      ? "Use gateway_process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up."
      : "Background session follow-up is unavailable because gateway_process is not exposed. Rerun without background=true and set yieldMs high enough to wait for completion.",
    ...(params.ask ? { ask: params.ask } : {}),
  });
}

export function createGatewayProcessProjection(
  createProjection: CodexScheduledToolProjectionFactory,
  processTool: OpenClawDynamicTool,
): OpenClawDynamicTool {
  return createProjection(processTool, {
    kind: "process",
    name: CODEX_GATEWAY_PROCESS_DYNAMIC_TOOL_NAME,
    description:
      "Manage background shell sessions in the existing per-session OpenClaw process scope: list, poll, log, write, send-keys, submit, paste, kill, clear, or remove. Use for gateway_exec follow-up; use native Codex shell session handling for ordinary local work.",
  });
}
