import { isOpenAIGpt56Model, projectRuntimeToolInputSchema } from "@openclaw/ai/internal/openai";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
// Anthropic-family tool payload compatibility wraps provider tool payload shapes.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { StreamFn } from "../../../agents/runtime/index.js";
import { streamSimple } from "../../stream.js";
type AnthropicToolSchemaMode = "openai-functions";
type AnthropicToolChoiceMode = "openai-string-modes";

type AnthropicToolPayloadCompatibilityOptions = {
  toolSchemaMode?: AnthropicToolSchemaMode;
  toolChoiceMode?: AnthropicToolChoiceMode;
};

type PayloadFieldRead = { ok: true; value: unknown } | { ok: false };

type OpenAiToolProjection = {
  readonly kind?: "custom" | "function";
  readonly name?: string;
  readonly projectedKind?: "custom" | "function";
  readonly tool: Record<string, unknown>;
};

type OpenAiFunctionToolsProjection = {
  readonly customFunctionNames: ReadonlySet<string>;
  readonly customNames: ReadonlySet<string>;
  readonly functionNames: ReadonlySet<string>;
  readonly tools: readonly Record<string, unknown>[];
};

function readPayloadField(record: Record<string, unknown>, field: string): PayloadFieldRead {
  try {
    return { ok: true, value: Reflect.get(record, field) };
  } catch {
    return { ok: false };
  }
}

function isProviderSupportedSchemaViolation(violation: string): boolean {
  return violation.endsWith(".$dynamicRef") || violation.endsWith(".$dynamicAnchor");
}

function projectJsonObjectSchema(
  schema: unknown,
  path: string,
): Record<string, unknown> | undefined {
  const projection = projectRuntimeToolInputSchema(schema, path);
  if (
    !isRecord(projection.schema) ||
    projection.violations.some((violation) => !isProviderSupportedSchemaViolation(violation))
  ) {
    return undefined;
  }
  const properties = projection.schema.properties;
  const required = projection.schema.required;
  if (
    (properties !== undefined && properties !== null && !isRecord(properties)) ||
    (required !== undefined &&
      required !== null &&
      (!Array.isArray(required) || required.some((entry) => typeof entry !== "string")))
  ) {
    return undefined;
  }
  const normalizedSchema = { ...projection.schema };
  if (properties === null) {
    delete normalizedSchema.properties;
  }
  if (required === null) {
    delete normalizedSchema.required;
  }
  return normalizedSchema;
}

function snapshotJsonRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) {
      return undefined;
    }
    const snapshot = JSON.parse(serialized) as unknown;
    return isRecord(snapshot) ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

function snapshotToolMetadata(tool: Record<string, unknown>): Record<string, unknown> | undefined {
  let fields: string[];
  try {
    fields = Object.keys(tool);
  } catch {
    return undefined;
  }
  const metadata: Record<string, unknown> = {};
  for (const field of fields) {
    if (field === "function" || field === "type") {
      continue;
    }
    const read = readPayloadField(tool, field);
    if (!read.ok) {
      continue;
    }
    try {
      const serialized = JSON.stringify(read.value);
      if (serialized !== undefined) {
        metadata[field] = JSON.parse(serialized) as unknown;
      }
    } catch {
      // Provider extensions are optional; keep the usable function definition.
    }
  }
  return metadata;
}

function hasOpenAiAnthropicToolPayloadCompatFlag(model: { compat?: unknown }): boolean {
  if (!model.compat || typeof model.compat !== "object" || Array.isArray(model.compat)) {
    return false;
  }

  return (
    (model.compat as { requiresOpenAiAnthropicToolPayload?: unknown })
      .requiresOpenAiAnthropicToolPayload === true
  );
}

function requiresAnthropicToolPayloadCompatibilityForModel(
  model: {
    api?: unknown;
    compat?: unknown;
  },
  options?: AnthropicToolPayloadCompatibilityOptions,
): boolean {
  if (model.api !== "anthropic-messages") {
    return false;
  }
  return (
    Boolean(options?.toolSchemaMode || options?.toolChoiceMode) ||
    hasOpenAiAnthropicToolPayloadCompatFlag(model)
  );
}

function usesOpenAiFunctionAnthropicToolSchemaForModel(
  model: {
    compat?: unknown;
  },
  options?: AnthropicToolPayloadCompatibilityOptions,
): boolean {
  return (
    options?.toolSchemaMode === "openai-functions" || hasOpenAiAnthropicToolPayloadCompatFlag(model)
  );
}

function usesOpenAiStringModeAnthropicToolChoiceForModel(
  model: {
    compat?: unknown;
  },
  options?: AnthropicToolPayloadCompatibilityOptions,
): boolean {
  return (
    options?.toolChoiceMode === "openai-string-modes" ||
    hasOpenAiAnthropicToolPayloadCompatFlag(model)
  );
}

function normalizeOpenAiFunctionAnthropicToolDefinition(
  tool: unknown,
): OpenAiToolProjection | undefined {
  if (!isRecord(tool)) {
    return undefined;
  }

  const functionField = readPayloadField(tool, "function");
  if (!functionField.ok) {
    return undefined;
  }
  if (isRecord(functionField.value)) {
    const nameField = readPayloadField(functionField.value, "name");
    if (!nameField.ok) {
      return undefined;
    }
    const name = normalizeOptionalString(nameField.value) ?? undefined;
    if (!name) {
      return undefined;
    }
    const parametersField = readPayloadField(functionField.value, "parameters");
    if (!parametersField.ok) {
      return undefined;
    }
    const parameters =
      parametersField.value === undefined
        ? undefined
        : projectJsonObjectSchema(parametersField.value, `${name}.parameters`);
    if (parametersField.value !== undefined && !parameters) {
      return undefined;
    }
    const functionSpec: Record<string, unknown> = {
      name,
      ...(parameters ? { parameters } : {}),
    };
    const descriptionField = readPayloadField(functionField.value, "description");
    if (
      descriptionField.ok &&
      typeof descriptionField.value === "string" &&
      descriptionField.value.trim()
    ) {
      functionSpec.description = descriptionField.value;
    }
    const strictField = readPayloadField(functionField.value, "strict");
    if (strictField.ok && (typeof strictField.value === "boolean" || strictField.value === null)) {
      functionSpec.strict = strictField.value;
    }
    const metadata = snapshotToolMetadata(tool);
    if (!metadata) {
      return undefined;
    }
    return {
      kind: "function",
      name,
      projectedKind: "function",
      tool: {
        ...metadata,
        type: "function",
        function: functionSpec,
      },
    };
  }

  const nameField = readPayloadField(tool, "name");
  if (!nameField.ok) {
    return undefined;
  }
  const rawName = normalizeOptionalString(nameField.value) ?? "";
  if (!rawName) {
    const snapshot = snapshotJsonRecord(tool);
    if (!snapshot) {
      return undefined;
    }
    if (snapshot.type === "custom" && isRecord(snapshot.custom)) {
      const name = normalizeOptionalString(snapshot.custom.name) ?? undefined;
      if (!name) {
        return undefined;
      }
      const inputSchema = snapshot.custom.input_schema;
      if (inputSchema === undefined) {
        return { kind: "custom", name, projectedKind: "custom", tool: snapshot };
      }
      const parameters = projectJsonObjectSchema(inputSchema, `${name}.input_schema`);
      if (!parameters) {
        return undefined;
      }
      const functionSpec: Record<string, unknown> = { name, parameters };
      if (typeof snapshot.custom.description === "string" && snapshot.custom.description.trim()) {
        functionSpec.description = snapshot.custom.description;
      }
      return {
        kind: "custom",
        name,
        projectedKind: "function",
        tool: { type: "function", function: functionSpec },
      };
    }
    return { tool: snapshot };
  }

  const inputSchemaField = readPayloadField(tool, "input_schema");
  if (!inputSchemaField.ok) {
    return undefined;
  }
  let parameters: unknown = { type: "object", properties: {} };
  if (isRecord(inputSchemaField.value)) {
    parameters = projectJsonObjectSchema(inputSchemaField.value, `${rawName}.input_schema`);
    if (!parameters) {
      return undefined;
    }
  } else {
    const parametersField = readPayloadField(tool, "parameters");
    if (!parametersField.ok) {
      return undefined;
    }
    if (isRecord(parametersField.value)) {
      parameters = projectJsonObjectSchema(parametersField.value, `${rawName}.parameters`);
      if (!parameters) {
        return undefined;
      }
    } else if (inputSchemaField.value !== undefined || parametersField.value !== undefined) {
      return undefined;
    }
  }
  const functionSpec: Record<string, unknown> = {
    name: rawName,
    parameters,
  };

  const descriptionField = readPayloadField(tool, "description");
  if (
    descriptionField.ok &&
    typeof descriptionField.value === "string" &&
    descriptionField.value.trim()
  ) {
    functionSpec.description = descriptionField.value;
  }
  const strictField = readPayloadField(tool, "strict");
  if (strictField.ok && typeof strictField.value === "boolean") {
    functionSpec.strict = strictField.value;
  }

  return {
    kind: "function",
    name: rawName,
    projectedKind: "function",
    tool: {
      type: "function",
      function: functionSpec,
    },
  };
}

function projectOpenAiFunctionAnthropicTools(
  tools: readonly unknown[],
): OpenAiFunctionToolsProjection {
  const projectedTools: Record<string, unknown>[] = [];
  const customFunctionNames = new Set<string>();
  const customNames = new Set<string>();
  const functionNames = new Set<string>();
  for (const tool of tools) {
    const projection = normalizeOpenAiFunctionAnthropicToolDefinition(tool);
    if (!projection) {
      continue;
    }
    projectedTools.push(projection.tool);
    if (projection.kind === "custom" && projection.name) {
      customNames.add(projection.name);
      if (projection.projectedKind === "function") {
        customFunctionNames.add(projection.name);
      }
    } else if (projection.kind === "function" && projection.name) {
      functionNames.add(projection.name);
    }
  }
  return {
    customFunctionNames,
    customNames,
    functionNames,
    tools: projectedTools,
  };
}

function isProjectedToolAvailable(
  projection: OpenAiFunctionToolsProjection | undefined,
  kind: "custom" | "function",
  name: string,
): boolean {
  return (
    !projection || (kind === "custom" ? projection.customNames : projection.functionNames).has(name)
  );
}

function projectToolChoiceKind(
  projection: OpenAiFunctionToolsProjection,
  kind: "custom" | "function",
  name: string,
): "custom" | "function" {
  return kind === "custom" && projection.customFunctionNames.has(name) ? "function" : kind;
}

function normalizeAllowedToolChoice(
  choice: Record<string, unknown>,
  toolProjection: OpenAiFunctionToolsProjection | undefined,
): unknown {
  if (!toolProjection || !isRecord(choice.allowed_tools)) {
    return choice;
  }
  const mode = choice.allowed_tools.mode;
  if ((mode !== "auto" && mode !== "required") || !Array.isArray(choice.allowed_tools.tools)) {
    return choice;
  }
  const tools = choice.allowed_tools.tools.flatMap<Record<string, unknown>>((tool) => {
    const snapshot = snapshotJsonRecord(tool);
    if (!snapshot) {
      return [];
    }
    const kind =
      snapshot.type === "custom" || snapshot.type === "function" ? snapshot.type : undefined;
    const definition = kind && isRecord(snapshot[kind]) ? snapshot[kind] : undefined;
    const name = definition ? (normalizeOptionalString(definition.name) ?? "") : "";
    if (!kind || !name || !isProjectedToolAvailable(toolProjection, kind, name)) {
      return [];
    }
    return projectToolChoiceKind(toolProjection, kind, name) === "function"
      ? [{ type: "function", function: { name } }]
      : [{ type: "custom", custom: { name } }];
  });
  if (tools.length === 0) {
    if (mode === "auto") {
      return "none";
    }
    throw new Error(
      "OpenAI-compatible Anthropic tool_choice requires a tool, but no allowed tools survived payload conversion",
    );
  }
  return {
    type: "allowed_tools",
    allowed_tools: { mode, tools },
  };
}

function normalizeOpenAiStringModeAnthropicToolChoice(
  toolChoice: unknown,
  toolProjection?: OpenAiFunctionToolsProjection,
): unknown {
  if (typeof toolChoice === "string") {
    if (toolChoice === "auto" && toolProjection?.tools.length === 0) {
      return undefined;
    }
    if (toolChoice === "required" && toolProjection?.tools.length === 0) {
      throw new Error(
        "OpenAI-compatible Anthropic tool_choice requires a tool, but no tools survived payload conversion",
      );
    }
    return toolChoice;
  }
  if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) {
    return toolChoice;
  }

  const choice = toolChoice as Record<string, unknown>;
  if (choice.type === "auto") {
    if (toolProjection?.tools.length === 0) {
      return undefined;
    }
    return "auto";
  }
  if (choice.type === "none") {
    return "none";
  }
  if (choice.type === "required" || choice.type === "any") {
    if (toolProjection && toolProjection.tools.length === 0) {
      throw new Error(
        "OpenAI-compatible Anthropic tool_choice requires a tool, but no tools survived payload conversion",
      );
    }
    return "required";
  }
  if (choice.type === "tool" && typeof choice.name === "string" && choice.name.trim()) {
    const name = choice.name.trim();
    if (!isProjectedToolAvailable(toolProjection, "function", name)) {
      throw new Error(
        `OpenAI-compatible Anthropic tool_choice requested unavailable tool "${name}" after payload conversion`,
      );
    }
    return {
      type: "function",
      function: { name },
    };
  }
  if (choice.type === "function" && isRecord(choice.function)) {
    const name = normalizeOptionalString(choice.function.name) ?? "";
    if (name && !isProjectedToolAvailable(toolProjection, "function", name)) {
      throw new Error(
        `OpenAI-compatible Anthropic tool_choice requested unavailable tool "${name}" after payload conversion`,
      );
    }
    if (name) {
      return {
        type: "function",
        function: { name },
      };
    }
  }
  if (choice.type === "custom" && isRecord(choice.custom)) {
    const name = normalizeOptionalString(choice.custom.name) ?? "";
    if (name && !isProjectedToolAvailable(toolProjection, "custom", name)) {
      throw new Error(
        `OpenAI-compatible Anthropic tool_choice requested unavailable tool "${name}" after payload conversion`,
      );
    }
    if (name) {
      return toolProjection && projectToolChoiceKind(toolProjection, "custom", name) === "function"
        ? { type: "function", function: { name } }
        : { type: "custom", custom: { name } };
    }
  }
  if (choice.type === "allowed_tools") {
    return normalizeAllowedToolChoice(choice, toolProjection);
  }

  return toolChoice;
}

/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
export function createAnthropicToolPayloadCompatibilityWrapper(
  baseStreamFn: StreamFn | undefined,
  options?: AnthropicToolPayloadCompatibilityOptions,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, streamOptions) => {
    const originalOnPayload = streamOptions?.onPayload;
    return underlying(model, context, {
      ...streamOptions,
      onPayload: (payload) => {
        if (
          payload &&
          typeof payload === "object" &&
          requiresAnthropicToolPayloadCompatibilityForModel(model, options)
        ) {
          const payloadObj = payload as Record<string, unknown>;
          let toolProjection: OpenAiFunctionToolsProjection | undefined;
          if (
            Array.isArray(payloadObj.tools) &&
            usesOpenAiFunctionAnthropicToolSchemaForModel(model, options)
          ) {
            toolProjection = projectOpenAiFunctionAnthropicTools(payloadObj.tools);
            if (toolProjection.tools.length > 0) {
              payloadObj.tools = toolProjection.tools;
            } else {
              delete payloadObj.tools;
            }
          }
          if (usesOpenAiStringModeAnthropicToolChoiceForModel(model, options)) {
            const toolChoice = normalizeOpenAiStringModeAnthropicToolChoice(
              payloadObj.tool_choice,
              toolProjection,
            );
            if (toolChoice === undefined) {
              delete payloadObj.tool_choice;
            } else {
              payloadObj.tool_choice = toolChoice;
            }
          }
          if (
            isOpenAIGpt56Model(model) &&
            toolProjection?.tools.some((tool) => tool.type === "function")
          ) {
            // GPT-5.6 Chat Completions rejects function tools while reasoning
            // is enabled and defaults reasoning on when the field is omitted.
            payloadObj.reasoning_effort = "none";
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
export function createOpenAIAnthropicToolPayloadCompatibilityWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  return createAnthropicToolPayloadCompatibilityWrapper(baseStreamFn, {
    toolSchemaMode: "openai-functions",
    toolChoiceMode: "openai-string-modes",
  });
}
