// OpenCode Zen stream adapter handles provider-specific Responses wire compatibility.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  streamSimple,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const WEB_SEARCH_TOOL_NAME = "web_search";
// OpenCode reserves this name for the native Responses web-search tool and
// rejects custom functions that use it, so keep the alias inside the wire boundary.
const WEB_SEARCH_WIRE_ALIAS_PREFIX = "openclaw_web_search";

type ProviderStream = Awaited<ReturnType<StreamFn>>;
type DynamicRecordField = {
  name: string;
  jsonValues: boolean;
};
type DynamicRecordFieldsByTool = Map<string, DynamicRecordField[]>;

function buildDynamicRecordWireSchema(
  schema: Record<string, unknown>,
  valueSchema: unknown,
  jsonValues: boolean,
): Record<string, unknown> {
  const description = typeof schema.description === "string" ? `${schema.description} ` : "";
  return {
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
}

function rewriteDynamicRecordToolSchemas(payload: Record<string, unknown>) {
  const fieldsByTool: DynamicRecordFieldsByTool = new Map();
  if (!Array.isArray(payload.tools)) {
    return fieldsByTool;
  }
  for (const tool of payload.tools) {
    if (
      !isRecord(tool) ||
      tool.type !== "function" ||
      typeof tool.name !== "string" ||
      !isRecord(tool.parameters)
    ) {
      continue;
    }
    const properties = tool.parameters.properties;
    if (!isRecord(properties)) {
      continue;
    }
    const fields: DynamicRecordField[] = [];
    for (const [name, fieldSchema] of Object.entries(properties)) {
      if (!isRecord(fieldSchema)) {
        continue;
      }
      const namedProperties = isRecord(fieldSchema.properties)
        ? Object.keys(fieldSchema.properties)
        : [];
      const patternProperties = fieldSchema.patternProperties;
      if (
        namedProperties.length > 0 ||
        !isRecord(patternProperties) ||
        Object.keys(patternProperties).length !== 1 ||
        !Object.hasOwn(patternProperties, "^.*$")
      ) {
        continue;
      }
      const valueSchema = patternProperties["^.*$"];
      const jsonValues = !isRecord(valueSchema) || valueSchema.type !== "string";
      properties[name] = buildDynamicRecordWireSchema(fieldSchema, valueSchema, jsonValues);
      fields.push({ name, jsonValues });
    }
    if (fields.length > 0) {
      fieldsByTool.set(tool.name, fields);
    }
  }
  return fieldsByTool;
}

function transformDynamicRecordArguments(
  toolName: string,
  args: Record<string, unknown>,
  fieldsByTool: DynamicRecordFieldsByTool,
  direction: "to-wire" | "from-wire",
): void {
  for (const field of fieldsByTool.get(toolName) ?? []) {
    const value = args[field.name];
    if (direction === "to-wire") {
      if (!isRecord(value)) {
        continue;
      }
      args[field.name] = Object.entries(value).map(([key, entryValue]) => ({
        key,
        value: field.jsonValues
          ? (JSON.stringify(entryValue) ?? "null")
          : typeof entryValue === "string"
            ? entryValue
            : (JSON.stringify(entryValue) ?? "null"),
      }));
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
      let entryValue: unknown = entry.value;
      if (field.jsonValues) {
        try {
          entryValue = JSON.parse(entry.value) as unknown;
        } catch {
          valid = false;
          break;
        }
      }
      entries.push([entry.key, entryValue]);
    }
    if (valid) {
      args[field.name] = Object.fromEntries(entries);
    }
  }
}

function transformFunctionCallArguments(
  call: Record<string, unknown>,
  fieldsByTool: DynamicRecordFieldsByTool,
  direction: "to-wire" | "from-wire",
): void {
  if (typeof call.name !== "string") {
    return;
  }
  if (typeof call.arguments === "string") {
    try {
      const args = JSON.parse(call.arguments) as unknown;
      if (isRecord(args)) {
        transformDynamicRecordArguments(call.name, args, fieldsByTool, direction);
        call.arguments = JSON.stringify(args);
      }
    } catch {
      // Leave partial or malformed arguments unchanged for normal validation.
    }
  } else if (isRecord(call.arguments)) {
    transformDynamicRecordArguments(call.name, call.arguments, fieldsByTool, direction);
  }
}

function encodeDynamicRecordReplayArguments(
  payload: Record<string, unknown>,
  fieldsByTool: DynamicRecordFieldsByTool,
): void {
  if (!Array.isArray(payload.input)) {
    return;
  }
  for (const item of payload.input) {
    if (isRecord(item) && item.type === "function_call") {
      transformFunctionCallArguments(item, fieldsByTool, "to-wire");
    }
  }
}

function selectWebSearchWireAlias(payload: Record<string, unknown>): string | undefined {
  const functionNames = new Set<string>();
  let needsAlias = false;
  const collectNames = (value: unknown, expectedType: "function" | "function_call") => {
    if (!Array.isArray(value)) {
      return;
    }
    for (const item of value) {
      if (isRecord(item) && item.type === expectedType && typeof item.name === "string") {
        functionNames.add(item.name);
        needsAlias ||= item.name === WEB_SEARCH_TOOL_NAME;
      }
    }
  };
  collectNames(payload.tools, "function");
  collectNames(payload.input, "function_call");
  if (
    isRecord(payload.tool_choice) &&
    payload.tool_choice.type === "function" &&
    typeof payload.tool_choice.name === "string"
  ) {
    functionNames.add(payload.tool_choice.name);
    needsAlias ||= payload.tool_choice.name === WEB_SEARCH_TOOL_NAME;
  }
  if (!needsAlias) {
    return undefined;
  }
  let suffix = 1;
  let alias = WEB_SEARCH_WIRE_ALIAS_PREFIX;
  while (functionNames.has(alias)) {
    suffix += 1;
    alias = `${WEB_SEARCH_WIRE_ALIAS_PREFIX}_${suffix}`;
  }
  return alias;
}

function aliasWebSearchInPayload(
  payload: Record<string, unknown>,
  wireAlias: string | undefined,
): void {
  if (!wireAlias) {
    return;
  }
  const aliasNames = (value: unknown, expectedType: "function" | "function_call") => {
    if (!Array.isArray(value)) {
      return;
    }
    for (const item of value) {
      if (isRecord(item) && item.type === expectedType && item.name === WEB_SEARCH_TOOL_NAME) {
        item.name = wireAlias;
      }
    }
  };
  aliasNames(payload.tools, "function");
  aliasNames(payload.input, "function_call");
  if (
    isRecord(payload.tool_choice) &&
    payload.tool_choice.type === "function" &&
    payload.tool_choice.name === WEB_SEARCH_TOOL_NAME
  ) {
    payload.tool_choice.name = wireAlias;
  }
}

function restoreToolCallsInMessage(
  message: AssistantMessage,
  fieldsByTool: DynamicRecordFieldsByTool,
  webSearchWireAlias: string | undefined,
): void {
  for (const block of message.content) {
    if (block.type !== "toolCall") {
      continue;
    }
    if (webSearchWireAlias && block.name === webSearchWireAlias) {
      block.name = WEB_SEARCH_TOOL_NAME;
    }
    transformDynamicRecordArguments(block.name, block.arguments, fieldsByTool, "from-wire");
  }
}

function restoreToolCallsInEvent(
  event: AssistantMessageEvent,
  fieldsByTool: DynamicRecordFieldsByTool,
  webSearchWireAlias: string | undefined,
): void {
  if ("partial" in event && event.partial) {
    restoreToolCallsInMessage(event.partial, fieldsByTool, webSearchWireAlias);
  }
  if (event.type === "toolcall_end") {
    if (webSearchWireAlias && event.toolCall.name === webSearchWireAlias) {
      event.toolCall.name = WEB_SEARCH_TOOL_NAME;
    }
    transformDynamicRecordArguments(
      event.toolCall.name,
      event.toolCall.arguments,
      fieldsByTool,
      "from-wire",
    );
  } else if (event.type === "done") {
    restoreToolCallsInMessage(event.message, fieldsByTool, webSearchWireAlias);
  } else if (event.type === "error") {
    restoreToolCallsInMessage(event.error, fieldsByTool, webSearchWireAlias);
  }
}

function wrapOpencodeResponseStream(
  stream: ProviderStream,
  fieldsByTool: DynamicRecordFieldsByTool,
  resolveWebSearchWireAlias: () => string | undefined,
) {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of stream) {
        restoreToolCallsInEvent(event, fieldsByTool, resolveWebSearchWireAlias());
        yield event;
      }
    },
    async result() {
      const message = await stream.result();
      restoreToolCallsInMessage(message, fieldsByTool, resolveWebSearchWireAlias());
      return message;
    },
  } satisfies ProviderStream;
}

export function wrapOpencodeProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  const underlying = ctx.streamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.api !== "openai-responses") {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    const fieldsByTool: DynamicRecordFieldsByTool = new Map();
    let webSearchWireAlias: string | undefined;
    const maybeStream = underlying(model, context, {
      ...options,
      async onPayload(payload, payloadModel) {
        const replacement = await originalOnPayload?.(payload, payloadModel);
        const finalPayload = replacement ?? payload;
        fieldsByTool.clear();
        webSearchWireAlias = undefined;
        if (isRecord(finalPayload)) {
          for (const [toolName, fields] of rewriteDynamicRecordToolSchemas(finalPayload)) {
            fieldsByTool.set(toolName, fields);
          }
          encodeDynamicRecordReplayArguments(finalPayload, fieldsByTool);
          webSearchWireAlias = selectWebSearchWireAlias(finalPayload);
          aliasWebSearchInPayload(finalPayload, webSearchWireAlias);
        }
        return finalPayload;
      },
    });
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapOpencodeResponseStream(stream, fieldsByTool, () => webSearchWireAlias),
      );
    }
    return wrapOpencodeResponseStream(maybeStream, fieldsByTool, () => webSearchWireAlias);
  };
}
