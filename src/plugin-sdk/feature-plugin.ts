/** Registers typed feature operations on existing host-owned tools, commands, and actions. */
import type { TSchema } from "typebox";
import type { AgentToolUpdateCallback } from "../agents/runtime/index.js";
import { jsonResult } from "../agents/tools/common.js";
import type { OpenClawPluginGatewayEvents } from "../plugins/gateway-events.js";
import {
  isPluginJsonValue,
  type PluginJsonValue,
  type PluginSessionActionContext,
} from "../plugins/host-hooks.js";
import type { PluginCommandContext, PluginCommandResult } from "../plugins/plugin-command.types.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import type {
  FeatureContract,
  FeatureEvent,
  FeatureEventName,
  FeatureInput,
  FeatureOperationName,
  FeatureOutput,
} from "./feature-contract.js";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "./plugin-entry.js";
import { toolPluginMetadataSymbol, type ToolPluginMetadata } from "./tool-plugin.js";

export type FeatureInvocationContext = { api: OpenClawPluginApi } & (
  | { source: "session-action"; action: PluginSessionActionContext }
  | {
      source: "tool";
      tool: OpenClawPluginToolContext;
      toolCallId: string;
      signal?: AbortSignal;
      onUpdate?: AgentToolUpdateCallback;
    }
  | { source: "command"; command: PluginCommandContext }
);

export type FeatureHandlers<C extends FeatureContract> = {
  [K in FeatureOperationName<C>]: (
    input: FeatureInput<C, K>,
    context: FeatureInvocationContext,
  ) => FeatureOutput<C, K> | Promise<FeatureOutput<C, K>>;
};

export type FeatureEventEmitter<C extends FeatureContract> = {
  emit: <K extends FeatureEventName<C>>(event: K, payload: FeatureEvent<C, K>) => void;
};

export type FeatureCommandAdapter<C extends FeatureContract, K extends FeatureOperationName<C>> = {
  name: string;
  description?: string;
  parse: (context: PluginCommandContext) => FeatureInput<C, K>;
  format?: (output: FeatureOutput<C, K>, context: PluginCommandContext) => PluginCommandResult;
};

export type DefineFeaturePluginOptions<C extends FeatureContract> = {
  contract: C;
  name: string;
  description: string;
  /** Registration is synchronous; long-lived work belongs to api.registerService. */
  setup: (api: OpenClawPluginApi, events: FeatureEventEmitter<C>) => FeatureHandlers<C>;
  commands?: Partial<{ [K in FeatureOperationName<C>]: FeatureCommandAdapter<C, K> }>;
};

class FeatureValidationError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "INVALID_OUTPUT",
    message: string,
  ) {
    super(message);
    this.name = "FeatureValidationError";
  }
}

function validateFeatureValue(
  schema: TSchema,
  value: unknown,
  key: string,
  direction: "input" | "output",
): PluginJsonValue {
  const code = direction === "input" ? "INVALID_INPUT" : "INVALID_OUTPUT";
  if (!isPluginJsonValue(value)) {
    throw new FeatureValidationError(code, `Feature ${direction} must be bounded JSON`);
  }
  const validation = validateJsonSchemaValue({
    // SAFETY: the contract supplies a TypeBox schema; canonical validation rejects unsupported schema shapes.
    schema: schema as JsonSchemaObject,
    cacheKey: key,
    value,
  });
  if (!validation.ok) {
    const detail = validation.errors
      .map((error) => error.text)
      .join("; ")
      .slice(0, 512);
    throw new FeatureValidationError(
      code,
      `Feature ${direction} does not match its schema: ${detail}`,
    );
  }
  return value;
}

/** One implementation serves each declared surface without relaying through privileged RPC. */
export function defineFeaturePlugin<C extends FeatureContract>(
  definition: DefineFeaturePluginOptions<C>,
) {
  const { contract } = definition;
  const operations = Object.entries(contract.operations).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  const entry = definePluginEntry({
    id: contract.pluginId,
    name: definition.name,
    description: definition.description,
    register(api) {
      if (api.id !== contract.pluginId) {
        throw new Error("Feature contract must belong to the registering plugin");
      }
      let gatewayEvents: OpenClawPluginGatewayEvents | undefined;
      const events: FeatureEventEmitter<C> = {
        emit(event, payload) {
          const schema = contract.events[event];
          if (!schema || !gatewayEvents) {
            throw new Error(
              "Feature event emitter is unavailable until its Gateway service starts",
            );
          }
          const value = validateFeatureValue(
            schema,
            payload,
            `feature:${contract.pluginId}:event:${event}`,
            "output",
          );
          gatewayEvents.emit(event, value, { scope: "operator.read" });
        },
      };
      if (Object.keys(contract.events).length > 0) {
        api.registerService({
          id: `${contract.pluginId}:feature-events`,
          start(context) {
            gatewayEvents = context.gatewayEvents;
          },
          stop() {
            gatewayEvents = undefined;
          },
        });
      }
      const handlers = definition.setup(api, events);
      for (const [id, operation] of operations) {
        // SAFETY: id comes from this contract's own operations entries.
        const name = id as FeatureOperationName<C>;
        const handler = handlers[name];
        if (typeof handler !== "function") {
          throw new Error(`Feature operation ${id} is missing its handler`);
        }
        const invoke = async (input: unknown, context: FeatureInvocationContext) => {
          const signal = context.source === "tool" ? context.signal : undefined;
          signal?.throwIfAborted();
          const value = validateFeatureValue(
            operation.input,
            input,
            `feature:${contract.pluginId}:${id}:input`,
            "input",
          );
          // SAFETY: validateFeatureValue checked this value against the same operation's input schema.
          const result = await handler(value as FeatureInput<C, typeof name>, context);
          signal?.throwIfAborted();
          return validateFeatureValue(
            operation.output,
            result,
            `feature:${contract.pluginId}:${id}:output`,
            "output",
          );
        };
        const requiredScope = operation.kind === "query" ? "operator.read" : "operator.write";
        api.registerSessionAction({
          id,
          description: operation.description,
          // SAFETY: registerSessionAction validates the schema as bounded JSON before retaining it.
          schema: operation.input as PluginJsonValue,
          requiredScopes: [requiredScope],
          async handler(action) {
            try {
              return {
                ok: true,
                result: await invoke(action.payload, { source: "session-action", action, api }),
              };
            } catch (error) {
              if (error instanceof FeatureValidationError) {
                return { ok: false, error: error.message, code: error.code };
              }
              throw error;
            }
          },
        });
        if (operation.tool) {
          const tool = operation.tool;
          api.registerTool(
            (toolContext) => ({
              name: tool.name,
              label: tool.label ?? tool.name,
              description: operation.description,
              parameters: operation.input,
              outputSchema: operation.output,
              execute: async (toolCallId, input, signal, onUpdate) =>
                jsonResult(
                  await invoke(input, {
                    source: "tool",
                    tool: toolContext,
                    toolCallId,
                    signal,
                    onUpdate,
                    api,
                  }),
                ),
            }),
            { name: tool.name, ...(tool.optional ? { optional: true } : {}) },
          );
        }
        const command = definition.commands?.[name];
        if (command) {
          api.registerCommand({
            name: command.name,
            description: command.description ?? operation.description,
            acceptsArgs: true,
            requireAuth: true,
            requiredScopes: [requiredScope],
            async handler(context) {
              const output = await invoke(command.parse(context), {
                source: "command",
                command: context,
                api,
              });
              if (command.format) {
                // SAFETY: invoke validates output against this operation's schema before returning it.
                return command.format(output as FeatureOutput<C, typeof name>, context);
              }
              return { text: JSON.stringify(output, null, 2) };
            },
          });
        }
      }
    },
  });
  const metadata: ToolPluginMetadata = {
    id: contract.pluginId,
    name: definition.name,
    description: definition.description,
    activation: { onStartup: true },
    configSchema: entry.configSchema.jsonSchema ?? { type: "object", additionalProperties: false },
    tools: operations.flatMap(([, operation]) =>
      operation.tool
        ? [
            {
              name: operation.tool.name,
              label: operation.tool.label ?? operation.tool.name,
              description: operation.description,
              // SAFETY: metadata retains the same TypeBox input schema used by runtime validation.
              parameters: operation.input as JsonSchemaObject,
              // SAFETY: metadata retains the same TypeBox output schema used by runtime validation.
              outputSchema: operation.output as JsonSchemaObject,
              ...(operation.tool.optional ? { optional: true } : {}),
            },
          ]
        : [],
    ),
  };
  Object.defineProperty(entry, toolPluginMetadataSymbol, { value: metadata, enumerable: false });
  return entry;
}
