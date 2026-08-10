// OpenCode Zen stream adapter handles provider-specific Responses wire compatibility.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  streamSimple,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const WEB_SEARCH = "web_search";
const WEB_SEARCH_ALIAS = "openclaw_web_search";

type ProviderStream = Awaited<ReturnType<StreamFn>>;
type DynamicFields = Map<string, Array<readonly [name: string, jsonValues: boolean]>>;
type TransformState = { fields: DynamicFields; alias?: string };

function payloadFunctions(payload: Record<string, unknown>): Record<string, unknown>[] {
  const choice = isRecord(payload.tool_choice) ? payload.tool_choice : undefined;
  const candidates = [
    ...(Array.isArray(payload.tools) ? payload.tools : []),
    ...(Array.isArray(payload.input) ? payload.input : []),
    ...(Array.isArray(choice?.tools) ? choice.tools : []),
    choice,
  ];
  return candidates.filter(
    (item): item is Record<string, unknown> =>
      isRecord(item) &&
      (item.type === "function" || item.type === "function_call") &&
      typeof item.name === "string",
  );
}

function rewriteDynamicRecordSchemas(payload: Record<string, unknown>): DynamicFields {
  const fieldsByTool: DynamicFields = new Map();
  for (const tool of payloadFunctions(payload)) {
    if (tool.type !== "function" || !isRecord(tool.parameters)) {
      continue;
    }
    const properties = tool.parameters.properties;
    if (!isRecord(properties)) {
      continue;
    }
    const fields: Array<readonly [string, boolean]> = [];
    for (const [name, schema] of Object.entries(properties)) {
      if (!isRecord(schema)) {
        continue;
      }
      const patterns = schema.patternProperties;
      if (
        (isRecord(schema.properties) && Object.keys(schema.properties).length > 0) ||
        !isRecord(patterns) ||
        Object.keys(patterns).length !== 1 ||
        !Object.hasOwn(patterns, "^.*$")
      ) {
        continue;
      }
      const valueSchema = patterns["^.*$"];
      const jsonValues = !isRecord(valueSchema) || valueSchema.type !== "string";
      const description = typeof schema.description === "string" ? `${schema.description} ` : "";
      properties[name] = {
        ...schema,
        type: "array",
        description: `${description}Provide as key/value entries.${jsonValues ? " JSON-encode every value, including strings." : ""}`,
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            value: jsonValues
              ? {
                  type: "string",
                  description: "JSON-encoded value, including JSON encoding for string values.",
                }
              : valueSchema,
          },
          required: ["key", "value"],
          additionalProperties: false,
        },
        properties: undefined,
        patternProperties: undefined,
        additionalProperties: undefined,
        required: undefined,
      };
      fields.push([name, jsonValues]);
    }
    fieldsByTool.set(tool.name as string, fields);
  }
  return fieldsByTool;
}

function transformArguments(
  toolName: string,
  args: Record<string, unknown>,
  fields: DynamicFields,
  toWire: boolean,
): void {
  for (const [name, jsonValues] of fields.get(toolName) ?? []) {
    const value = args[name];
    if (toWire) {
      if (isRecord(value)) {
        args[name] = Object.entries(value).map(([key, item]) => ({
          key,
          value: jsonValues || typeof item !== "string" ? (JSON.stringify(item) ?? "null") : item,
        }));
      }
      continue;
    }
    if (!Array.isArray(value)) {
      continue;
    }
    const entries: Array<[string, unknown]> = [];
    const keys = new Set<string>();
    let valid = true;
    for (const entry of value) {
      if (
        !isRecord(entry) ||
        typeof entry.key !== "string" ||
        typeof entry.value !== "string" ||
        keys.has(entry.key)
      ) {
        valid = false;
        break;
      }
      keys.add(entry.key);
      let item: unknown = entry.value;
      if (jsonValues) {
        try {
          item = JSON.parse(entry.value) as unknown;
        } catch {
          valid = false;
          break;
        }
      }
      entries.push([entry.key, item]);
    }
    if (valid) {
      args[name] = Object.fromEntries(entries);
    }
  }
}

function transformCall(
  call: Record<string, unknown>,
  state: TransformState,
  toWire: boolean,
): void {
  if (typeof call.name !== "string") {
    return;
  }
  let toolName = call.name;
  if (!toWire && state.alias && toolName === state.alias) {
    call.name = toolName = WEB_SEARCH;
  }
  const serialized = typeof call.arguments === "string";
  try {
    const args = serialized
      ? (JSON.parse(call.arguments as string) as unknown)
      : !toWire && isRecord(call.arguments)
        ? { ...call.arguments }
        : call.arguments;
    if (isRecord(args)) {
      transformArguments(toolName, args, state.fields, toWire);
      call.arguments = serialized ? JSON.stringify(args) : args;
    }
  } catch {
    // Leave partial or malformed arguments unchanged for normal validation.
  }
}

function aliasWebSearch(payload: Record<string, unknown>): string | undefined {
  const functions = payloadFunctions(payload);
  const names = new Set(functions.map((item) => item.name as string));
  if (!names.has(WEB_SEARCH)) {
    return undefined;
  }
  let alias = WEB_SEARCH_ALIAS;
  for (let suffix = 2; names.has(alias); suffix += 1) {
    alias = `${WEB_SEARCH_ALIAS}_${suffix}`;
  }
  for (const item of functions) {
    if (item.name === WEB_SEARCH) {
      item.name = alias;
    }
  }
  return alias;
}

function restoreMessage(message: AssistantMessage, state: TransformState): AssistantMessage {
  const restored = { ...message, content: message.content.map((block) => ({ ...block })) };
  for (const block of restored.content) {
    if (block.type === "toolCall") {
      transformCall(block as unknown as Record<string, unknown>, state, false);
    }
  }
  return restored;
}

function restoreEvent(event: AssistantMessageEvent, state: TransformState): AssistantMessageEvent {
  const restored = { ...event };
  if ("partial" in restored && restored.partial) {
    restored.partial = restoreMessage(restored.partial, state);
  }
  if (restored.type === "toolcall_delta") {
    const call = restored.partial.content[restored.contentIndex];
    if (call?.type === "toolCall" && (state.fields.get(call.name)?.length ?? 0) > 0) {
      // Dynamic-record wire JSON is not prefix-compatible with restored object JSON.
      // Defer argument bytes so consumers emit one canonical payload at toolcall_end.
      restored.delta = "";
    }
  } else if (restored.type === "toolcall_end") {
    restored.toolCall = { ...restored.toolCall };
    transformCall(restored.toolCall as unknown as Record<string, unknown>, state, false);
  } else if (restored.type === "done") {
    restored.message = restoreMessage(restored.message, state);
  } else if (restored.type === "error") {
    restored.error = restoreMessage(restored.error, state);
  }
  return restored;
}

function wrapResponseStream(stream: ProviderStream, state: TransformState): ProviderStream {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of stream) {
        yield restoreEvent(event, state);
      }
    },
    async result() {
      return restoreMessage(await stream.result(), state);
    },
  };
}

export function wrapOpencodeProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  const underlying = ctx.streamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.api !== "openai-responses") {
      return underlying(model, context, options);
    }
    const originalOnPayload = options?.onPayload;
    const state: TransformState = { fields: new Map() };
    const maybeStream = underlying(model, context, {
      ...options,
      async onPayload(payload, payloadModel) {
        const finalPayload = (await originalOnPayload?.(payload, payloadModel)) ?? payload;
        state.fields = new Map();
        state.alias = undefined;
        if (isRecord(finalPayload)) {
          state.fields = rewriteDynamicRecordSchemas(finalPayload);
          for (const call of payloadFunctions(finalPayload)) {
            if (call.type === "function_call") {
              transformCall(call, state, true);
            }
          }
          state.alias = aliasWebSearch(finalPayload);
        }
        return finalPayload;
      },
    });
    const wrap = (stream: ProviderStream) => wrapResponseStream(stream, state);
    return maybeStream && typeof maybeStream === "object" && "then" in maybeStream
      ? Promise.resolve(maybeStream).then(wrap)
      : wrap(maybeStream);
  };
}
