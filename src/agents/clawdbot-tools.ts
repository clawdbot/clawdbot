import type { ClawdbotConfig } from "../config/config.js";
import { resolvePluginTools } from "../plugins/tools.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import { createCanvasTool } from "./tools/canvas-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createMemoryGetTool, createMemorySearchTool } from "./tools/memory-tool.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";

export function createClawdbotTools(options?: {
  browserControlUrl?: string;
  allowHostBrowserControl?: boolean;
  allowedControlUrls?: string[];
  allowedControlHosts?: string[];
  allowedControlPorts?: number[];
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentDir?: string;
  sandboxRoot?: string;
  workspaceDir?: string;
  sandboxed?: boolean;
  config?: ClawdbotConfig;
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
}): AnyAgentTool[] {
  const imageTool = options?.agentDir?.trim()
    ? createImageTool({
        config: options?.config,
        agentDir: options.agentDir,
        sandboxRoot: options?.sandboxRoot,
      })
    : null;
  const memorySearchTool = createMemorySearchTool({
    config: options?.config,
    agentSessionKey: options?.agentSessionKey,
  });
  const memoryGetTool = createMemoryGetTool({
    config: options?.config,
    agentSessionKey: options?.agentSessionKey,
  });
  const webSearchTool = createWebSearchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
  });
  const webFetchTool = createWebFetchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
  });
  const tools: AnyAgentTool[] = [
    createBrowserTool({
      defaultControlUrl: options?.browserControlUrl,
      allowHostControl: options?.allowHostBrowserControl,
      allowedControlUrls: options?.allowedControlUrls,
      allowedControlHosts: options?.allowedControlHosts,
      allowedControlPorts: options?.allowedControlPorts,
    }),
    createCanvasTool(),
    createNodesTool(),
    createCronTool(),
    createMessageTool({
      agentAccountId: options?.agentAccountId,
      config: options?.config,
      currentChannelId: options?.currentChannelId,
      currentThreadTs: options?.currentThreadTs,
      replyToMode: options?.replyToMode,
      hasRepliedRef: options?.hasRepliedRef,
    }),
    createGatewayTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    createAgentsListTool({ agentSessionKey: options?.agentSessionKey }),
    createSessionsListTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
    }),
    createSessionsSendTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      sandboxed: options?.sandboxed,
    }),
    createSessionsSpawnTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      sandboxed: options?.sandboxed,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    ...(memorySearchTool && memoryGetTool ? [memorySearchTool, memoryGetTool] : []),
    ...(webSearchTool ? [webSearchTool] : []),
    ...(webFetchTool ? [webFetchTool] : []),
    ...(imageTool ? [imageTool] : []),
  ];

  const pluginTools = resolvePluginTools({
    context: {
      config: options?.config,
      workspaceDir: options?.workspaceDir,
      agentDir: options?.agentDir,
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
      sessionKey: options?.agentSessionKey,
      messageChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      sandboxed: options?.sandboxed,
    },
    existingToolNames: new Set(tools.map((tool) => tool.name)),
  });

  return [...tools, ...pluginTools];
}
