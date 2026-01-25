/**
 * Type declarations for clawdbot/plugin-sdk
 *
 * These are minimal declarations to satisfy TypeScript.
 * The actual types come from the clawdbot package at runtime.
 */

declare module 'clawdbot/plugin-sdk' {
  import type { Static, TSchema } from '@sinclair/typebox';

  export interface PluginLogger {
    debug?: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  }

  export interface ClawdbotConfig {
    [key: string]: unknown;
  }

  export interface PluginRuntime {
    tools: {
      createMemorySearchTool: (opts: unknown) => unknown;
    };
    [key: string]: unknown;
  }

  export interface ClawdbotPluginToolContext {
    config?: ClawdbotConfig;
    workspaceDir?: string;
    agentDir?: string;
    agentId?: string;
    sessionKey?: string;
    messageChannel?: string;
    agentAccountId?: string;
    sandboxed?: boolean;
  }

  export interface ToolResult {
    content: Array<{ type: string; text: string }>;
    details?: Record<string, unknown>;
  }

  export interface AgentTool<TParams extends TSchema = TSchema> {
    name: string;
    label?: string;
    description: string;
    parameters: TParams;
    execute: (
      toolCallId: string,
      params: Static<TParams>,
      ctx?: ClawdbotPluginToolContext
    ) => Promise<ToolResult> | ToolResult;
  }

  export interface ClawdbotPluginApi {
    id: string;
    name: string;
    version?: string;
    description?: string;
    source: string;
    config: ClawdbotConfig;
    pluginConfig?: Record<string, unknown>;
    runtime: PluginRuntime;
    logger: PluginLogger;

    registerTool: (tool: AgentTool | unknown, opts?: { name?: string; names?: string[] }) => void;

    registerHook: (
      events: string | string[],
      handler: (event: unknown, ctx: unknown) => unknown,
      opts?: unknown
    ) => void;

    registerHttpHandler: (handler: unknown) => void;
    registerChannel: (registration: unknown) => void;
    registerGatewayMethod: (method: string, handler: unknown) => void;
    registerCli: (registrar: unknown, opts?: unknown) => void;
    registerService: (service: unknown) => void;
    registerProvider: (provider: unknown) => void;
    registerCommand: (command: unknown) => void;
    resolvePath: (input: string) => string;

    on: <K extends string>(
      hookName: K,
      handler: (event: unknown, ctx: unknown) => unknown,
      opts?: { priority?: number }
    ) => void;
  }

  export function emptyPluginConfigSchema(): unknown;
}
