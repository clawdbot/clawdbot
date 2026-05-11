import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
type AnthropicToolSchemaMode = "openai-functions";
type AnthropicToolChoiceMode = "openai-string-modes";

type AnthropicToolPayloadCompatibilityOptions = {
  toolSchemaMode?: AnthropicToolSchemaMode;
  toolChoiceMode?: AnthropicToolChoiceMode;
};

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
): Record<string, unknown> | undefined {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    return undefined;
  }

  const toolObj = tool as Record<string, unknown>;
  if (toolObj.function && typeof toolObj.function === "object") {
    return toolObj;
  }

  const rawName = normalizeOptionalString(toolObj.name) ?? "";
  if (!rawName) {
    return toolObj;
  }

  const functionSpec: Record<string, unknown> = {
    name: rawName,
    parameters:
      toolObj.input_schema && typeof toolObj.input_schema === "object"
        ? toolObj.input_schema
        : toolObj.parameters && typeof toolObj.parameters === "object"
          ? toolObj.parameters
          : { type: "object", properties: {} },
  };

  if (typeof toolObj.description === "string" && toolObj.description.trim()) {
    functionSpec.description = toolObj.description;
  }
  if (typeof toolObj.strict === "boolean") {
    functionSpec.strict = toolObj.strict;
  }

  return {
    type: "function",
    function: functionSpec,
  };
}

function normalizeOpenAiStringModeAnthropicToolChoice(toolChoice: unknown): unknown {
  if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) {
    return toolChoice;
  }

  const choice = toolChoice as Record<string, unknown>;
  if (choice.type === "auto") {
    return "auto";
  }
  if (choice.type === "none") {
    return "none";
  }
  if (choice.type === "required" || choice.type === "any") {
    return "required";
  }
  if (choice.type === "tool" && typeof choice.name === "string" && choice.name.trim()) {
    return {
      type: "function",
      function: { name: choice.name.trim() },
    };
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
          if (
            Array.isArray(payloadObj.tools) &&
            usesOpenAiFunctionAnthropicToolSchemaForModel(model, options)
          ) {
            payloadObj.tools = payloadObj.tools
              .map((tool) => normalizeOpenAiFunctionAnthropicToolDefinition(tool))
              .filter((tool): tool is Record<string, unknown> => !!tool);
          }
          if (usesOpenAiStringModeAnthropicToolChoiceForModel(model, options)) {
            payloadObj.tool_choice = normalizeOpenAiStringModeAnthropicToolChoice(
              payloadObj.tool_choice,
            );
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
