import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "typebox";
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
  onUpdate?: AgentToolUpdateCallback<unknown>;
};

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
        api.registerTool(
          {
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
                }),
              ),
          },
          tool.optional ? { optional: true } : undefined,
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
