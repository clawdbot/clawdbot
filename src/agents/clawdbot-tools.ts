import type { ClawdbotConfig } from "../config/config.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import { createCanvasTool } from "./tools/canvas-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createDiscordTool } from "./tools/discord-tool.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSlackTool } from "./tools/slack-tool.js";
import { createTelegramTool } from "./tools/telegram-tool.js";
import { createWhatsAppTool } from "./tools/whatsapp-tool.js";

export function createClawdbotTools(options?: {
  browserControlUrl?: string;
  agentSessionKey?: string;
  agentProvider?: string;
  agentAccountId?: string;
  agentDir?: string;
  sandboxed?: boolean;
  config?: ClawdbotConfig;
}): AnyAgentTool[] {
  const imageTool = createImageTool({
    config: options?.config,
    agentDir: options?.agentDir,
  });
  return [
    createBrowserTool({ defaultControlUrl: options?.browserControlUrl }),
    createCanvasTool(),
    createNodesTool(),
    createCronTool(),
    createDiscordTool(),
    createSlackTool({
      agentAccountId: options?.agentAccountId,
      config: options?.config,
    }),
    createTelegramTool(),
    createWhatsAppTool(),
    createGatewayTool({ agentSessionKey: options?.agentSessionKey }),
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
    ...(imageTool ? [imageTool] : []),
  ];
}
