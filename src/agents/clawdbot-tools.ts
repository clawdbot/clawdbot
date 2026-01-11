import type { ClawdbotConfig } from "../config/config.js";
import type { GatewayMessageProvider } from "../utils/message-provider.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import { createCanvasTool } from "./tools/canvas-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createVoiceCallTool } from "./tools/voice-call-tool.js";

export function createClawdbotTools(options?: {
  browserControlUrl?: string;
  allowHostBrowserControl?: boolean;
  agentSessionKey?: string;
  agentProvider?: GatewayMessageProvider;
  agentAccountId?: string;
  agentDir?: string;
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
  const imageTool = createImageTool({
    config: options?.config,
    agentDir: options?.agentDir,
  });
  return [
    createBrowserTool({
      defaultControlUrl: options?.browserControlUrl,
      allowHostControl: options?.allowHostBrowserControl,
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
    createVoiceCallTool(),
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
      agentProvider: options?.agentProvider,
      sandboxed: options?.sandboxed,
    }),
    createSessionsSpawnTool({
      agentSessionKey: options?.agentSessionKey,
      agentProvider: options?.agentProvider,
      sandboxed: options?.sandboxed,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    ...(imageTool ? [imageTool] : []),
  ];
}
