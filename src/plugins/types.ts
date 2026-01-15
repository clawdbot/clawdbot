import type { IncomingMessage, ServerResponse } from "node:http";
import type { Command } from "commander";

import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ChannelDock } from "../channels/dock.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";

export type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type PluginConfigUiHint = {
  label?: string;
  help?: string;
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
};

export type PluginConfigValidation =
  | { ok: true; value?: unknown }
  | { ok: false; errors: string[] };

export type ClawdbotPluginConfigSchema = {
  safeParse?: (value: unknown) => {
    success: boolean;
    data?: unknown;
    error?: {
      issues?: Array<{ path: Array<string | number>; message: string }>;
    };
  };
  parse?: (value: unknown) => unknown;
  validate?: (value: unknown) => PluginConfigValidation;
  uiHints?: Record<string, PluginConfigUiHint>;
};

export type ClawdbotPluginToolContext = {
  config?: ClawdbotConfig;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
  sandboxed?: boolean;
};

export type ClawdbotPluginToolFactory = (
  ctx: ClawdbotPluginToolContext,
) => AnyAgentTool | AnyAgentTool[] | null | undefined;

export type ClawdbotPluginGatewayMethod = {
  method: string;
  handler: GatewayRequestHandler;
};

export type ClawdbotPluginHttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean> | boolean;

export type ClawdbotPluginCliContext = {
  program: Command;
  config: ClawdbotConfig;
  workspaceDir?: string;
  logger: PluginLogger;
};

export type ClawdbotPluginCliRegistrar = (ctx: ClawdbotPluginCliContext) => void | Promise<void>;

export type ClawdbotPluginServiceContext = {
  config: ClawdbotConfig;
  workspaceDir?: string;
  stateDir: string;
  logger: PluginLogger;
};

export type ClawdbotPluginService = {
  id: string;
  start: (ctx: ClawdbotPluginServiceContext) => void | Promise<void>;
  stop?: (ctx: ClawdbotPluginServiceContext) => void | Promise<void>;
};

export type ClawdbotPluginChannelRegistration = {
  plugin: ChannelPlugin;
  dock?: ChannelDock;
};

export type ClawdbotPluginDefinition = {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  configSchema?: ClawdbotPluginConfigSchema;
  register?: (api: ClawdbotPluginApi) => void | Promise<void>;
  activate?: (api: ClawdbotPluginApi) => void | Promise<void>;
};

export type ClawdbotPluginModule =
  | ClawdbotPluginDefinition
  | ((api: ClawdbotPluginApi) => void | Promise<void>);

export type ClawdbotPluginApi = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  config: ClawdbotConfig;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerTool: (
    tool: AnyAgentTool | ClawdbotPluginToolFactory,
    opts?: { name?: string; names?: string[] },
  ) => void;
  registerHttpHandler: (handler: ClawdbotPluginHttpHandler) => void;
  registerChannel: (registration: ClawdbotPluginChannelRegistration | ChannelPlugin) => void;
  registerGatewayMethod: (method: string, handler: GatewayRequestHandler) => void;
  registerCli: (registrar: ClawdbotPluginCliRegistrar, opts?: { commands?: string[] }) => void;
  registerService: (service: ClawdbotPluginService) => void;
  resolvePath: (input: string) => string;
};

export type PluginOrigin = "global" | "workspace" | "config";

export type PluginDiagnostic = {
  level: "warn" | "error";
  message: string;
  pluginId?: string;
  source?: string;
};
