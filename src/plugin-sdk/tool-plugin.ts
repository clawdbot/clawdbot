import { Type, type Static, type TSchema } from "typebox";
import type { AgentToolResult, AgentToolUpdateCallback } from "../agents/runtime/index.js";
import { jsonResult, textResult } from "../agents/tools/common.js";
import type { PluginManifestActivation } from "../plugins/manifest.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "./plugin-entry.js";

const EMPTY_TOOL_PLUGIN_CONFIG_SCHEMA = Type.Object({}, { additionalProperties: false });

export const toolPluginMetadataSymbol = Symbol.for("openclaw.plugin-sdk.tool-plugin.metadata");

export type ToolPluginExecutionContext = {
  api: OpenClawPluginApi;
  signal?: AbortSignal;
  toolCallId: string;
  onUpdate?: AgentToolUpdateCallback;
  /**
   * Raw per-turn session key for the active request, when the runtime supplied
   * one (`agent:<agentId>:openai-user:<threadId>` for OpenAI-compatible callers).
   * This is bound PER TURN via the factory registration path below, so it is
   * concurrency-safe and never memoized module-globally.
   */
  sessionKey?: string;
  /**
   * The propfirm_manager BFF thread id for the CURRENT turn, parsed from
   * {@link sessionKey} (the substring after `openai-user:`). Undefined when the
   * caller did not supply an `openai-user:<thread_id>` session key. Plugins
   * forward this to the BFF as the `X-OpenClaw-Thread` header so the BFF can
   * identify which sub-agent (specialist) is calling and enforce its authority.
   */
  threadId?: string;
};

/**
 * Extract the propfirm_manager BFF thread id from a runtime session key.
 *
 * OpenAI-compatible callers (the propfirm BFF sends `user=<thread_id>`) yield a
 * session key of the form `agent:<agentId>:openai-user:<thread_id>`
 * (see `src/gateway/http-utils.ts` + `src/routing/session-key.ts`). The thread
 * id is everything AFTER the last `openai-user:` marker. Any other session-key
 * shape (Telegram/webchat/random-UUID mains) has no BFF thread id and returns
 * undefined so no misleading identity is stamped.
 */
export function extractThreadIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (typeof sessionKey !== "string" || sessionKey.length === 0) {
    return undefined;
  }
  const marker = "openai-user:";
  const idx = sessionKey.lastIndexOf(marker);
  if (idx < 0) {
    return undefined;
  }
  const threadId = sessionKey.slice(idx + marker.length).trim();
  return threadId.length > 0 ? threadId : undefined;
}

type ToolPluginConfig<TConfigSchema extends TSchema | undefined> = TConfigSchema extends TSchema
  ? Static<TConfigSchema>
  : Record<string, never>;

type ToolPluginToolFactory<TConfig> = <TParamsSchema extends TSchema>(
  definition: ToolPluginToolDefinition<TConfig, TParamsSchema>,
) => DefinedToolPluginTool;

export type ToolPluginFactoryContext<TConfig> = {
  api: OpenClawPluginApi;
  config: TConfig;
  toolContext: OpenClawPluginToolContext;
};

type ToolPluginToolDefinitionBase<TParamsSchema extends TSchema> = {
  name: string;
  label?: string;
  description: string;
  parameters: TParamsSchema;
  optional?: boolean;
};

export type ToolPluginToolDefinition<
  TConfig,
  TParamsSchema extends TSchema,
> = ToolPluginToolDefinitionBase<TParamsSchema> &
  (
    | {
        execute: (
          params: Static<TParamsSchema>,
          config: TConfig,
          context: ToolPluginExecutionContext,
        ) => unknown;
        factory?: never;
      }
    | {
        factory: (
          context: ToolPluginFactoryContext<TConfig>,
        ) => AnyAgentTool | AnyAgentTool[] | null | undefined;
        execute?: never;
      }
  );

type DefinedToolPluginTool = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  optional: boolean;
  execute?: (params: unknown, config: unknown, context: ToolPluginExecutionContext) => unknown;
  factory?: (
    context: ToolPluginFactoryContext<unknown>,
  ) => AnyAgentTool | AnyAgentTool[] | null | undefined;
};

export type ToolPluginStaticToolMetadata = {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchemaObject;
  optional?: boolean;
};

export type ToolPluginMetadata = {
  id: string;
  name: string;
  description: string;
  activation: PluginManifestActivation;
  configSchema: JsonSchemaObject;
  tools: ToolPluginStaticToolMetadata[];
};

export type DefineToolPluginOptions<TConfigSchema extends TSchema | undefined = undefined> = {
  id: string;
  name: string;
  description: string;
  activation?: PluginManifestActivation;
  configSchema?: TConfigSchema;
  tools: (
    tool: ToolPluginToolFactory<ToolPluginConfig<TConfigSchema>>,
  ) => readonly DefinedToolPluginTool[];
};

export type DefinedToolPluginEntry = ReturnType<typeof definePluginEntry> & {
  [toolPluginMetadataSymbol]: ToolPluginMetadata;
};

function wrapToolPluginResult(result: unknown): AgentToolResult<unknown> {
  if (typeof result === "string") {
    return textResult(result, result);
  }
  return jsonResult(result);
}

function createToolPluginToolFactory<TConfig>(): ToolPluginToolFactory<TConfig> {
  return ((definition: ToolPluginToolDefinition<TConfig, TSchema>) => ({
    name: definition.name,
    label: definition.label ?? definition.name,
    description: definition.description,
    parameters: definition.parameters,
    optional: definition.optional === true,
    execute: definition.execute as DefinedToolPluginTool["execute"],
    factory: definition.factory as DefinedToolPluginTool["factory"],
  })) as ToolPluginToolFactory<TConfig>;
}

export function defineToolPlugin<TConfigSchema extends TSchema | undefined = undefined>(
  definition: DefineToolPluginOptions<TConfigSchema>,
): DefinedToolPluginEntry {
  const configSchema = (definition.configSchema ??
    EMPTY_TOOL_PLUGIN_CONFIG_SCHEMA) as JsonSchemaObject;
  const pluginConfigSchema = buildJsonPluginConfigSchema(configSchema);
  const normalizedConfigSchema = pluginConfigSchema.jsonSchema ?? configSchema;
  const tools = [
    ...definition.tools(createToolPluginToolFactory<ToolPluginConfig<TConfigSchema>>()),
  ];
  const activation = definition.activation ?? { onStartup: true };
  const metadata: ToolPluginMetadata = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    activation,
    configSchema: normalizedConfigSchema,
    tools: tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters as JsonSchemaObject,
      ...(tool.optional ? { optional: true } : {}),
    })),
  };

  const entry = definePluginEntry({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    configSchema: pluginConfigSchema,
    register(api) {
      const config = (api.pluginConfig ?? {}) as ToolPluginConfig<TConfigSchema>;
      for (const tool of tools) {
        const opts = {
          name: tool.name,
          ...(tool.optional ? { optional: true } : {}),
        };
        if (tool.factory) {
          api.registerTool(
            (toolContext) =>
              tool.factory?.({
                api,
                config,
                toolContext,
              }),
            opts,
          );
          continue;
        }
        const execute = tool.execute;
        if (!execute) {
          throw new Error(`tool plugin tool ${tool.name} must define execute or factory`);
        }
        // Register via the FACTORY form (a function of the per-turn tool context)
        // rather than a bare tool object. The registry wraps a bare object as
        // `(_ctx) => tool`, which DISCARDS the per-turn context and would leave
        // execute-form plugins with no per-turn identity. Running through the
        // factory keeps the live `toolContext` (with `sessionKey`) in scope so we
        // can surface the current turn's BFF thread id to `execute`. The factory
        // is re-invoked per turn with the live context (see
        // `src/plugins/tools.ts`), so `threadId`/`sessionKey` are bound PER TURN
        // in this closure and are concurrency-safe — never memoized module-globally.
        api.registerTool(
          (toolContext) => ({
            name: tool.name,
            label: tool.label,
            description: tool.description,
            parameters: tool.parameters,
            execute: async (toolCallId, params, signal, onUpdate) =>
              wrapToolPluginResult(
                await execute(params, config, {
                  api,
                  signal,
                  toolCallId,
                  onUpdate,
                  sessionKey: toolContext.sessionKey,
                  threadId: extractThreadIdFromSessionKey(toolContext.sessionKey),
                }),
              ),
          }),
          { name: tool.name, ...(tool.optional ? { optional: true } : {}) },
        );
      }
    },
  }) as DefinedToolPluginEntry;

  Object.defineProperty(entry, toolPluginMetadataSymbol, {
    value: metadata,
    enumerable: false,
  });
  return entry;
}

export function getToolPluginMetadata(entry: unknown): ToolPluginMetadata | undefined {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const metadata = (entry as { [toolPluginMetadataSymbol]?: unknown })[toolPluginMetadataSymbol];
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  return metadata as ToolPluginMetadata;
}
