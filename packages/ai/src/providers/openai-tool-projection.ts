import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { projectRuntimeToolInputSchema } from "./tool-schema-json-projection.js";

type OpenAIToolDescriptor = {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly parameters: unknown;
};

type OpenAIProjectedTool = {
  readonly toolIndex: number;
  readonly name: string;
  readonly description?: string;
  readonly parameters: Record<string, unknown>;
};

type OpenAIToolProjectionDiagnostic = {
  readonly toolIndex: number;
  readonly toolName?: string;
  readonly violations: readonly string[];
};

export type OpenAIToolProjection = {
  readonly inputToolCount: number;
  readonly tools: readonly OpenAIProjectedTool[];
  readonly diagnostics: readonly OpenAIToolProjectionDiagnostic[];
};

type OpenAIResponsesToolChoice = ResponseCreateParamsStreaming["tool_choice"];
type OpenAIResponsesAllowedToolChoice = Extract<
  OpenAIResponsesToolChoice,
  { type: "allowed_tools" }
>;
type OpenAICompletionsSdkToolChoice =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming["tool_choice"];
type OpenAICompletionsAllowedToolChoice = Extract<
  OpenAICompletionsSdkToolChoice,
  { type: "allowed_tools" }
>;
export type OpenAICompletionsToolChoice = Exclude<
  OpenAICompletionsSdkToolChoice,
  { type: "custom" }
>;

function unreadableToolDiagnostic(toolIndex: number): OpenAIToolProjectionDiagnostic {
  return {
    toolIndex,
    violations: [`tool[${toolIndex}] is unreadable`],
  };
}

/** Snapshots direct/custom tool descriptors before OpenAI payload construction. */
export function projectOpenAITools(tools: readonly OpenAIToolDescriptor[]): OpenAIToolProjection {
  let inputToolCount: number;
  try {
    inputToolCount = tools.length;
  } catch {
    return {
      inputToolCount: 0,
      tools: [],
      diagnostics: [unreadableToolDiagnostic(0)],
    };
  }

  const projectedTools: OpenAIProjectedTool[] = [];
  const diagnostics: OpenAIToolProjectionDiagnostic[] = [];
  for (let toolIndex = 0; toolIndex < inputToolCount; toolIndex += 1) {
    let tool: OpenAIToolDescriptor;
    try {
      const candidate = tools[toolIndex];
      if (!candidate) {
        diagnostics.push(unreadableToolDiagnostic(toolIndex));
        continue;
      }
      tool = candidate;
    } catch {
      diagnostics.push(unreadableToolDiagnostic(toolIndex));
      continue;
    }

    let name: unknown;
    try {
      name = tool.name;
    } catch {
      diagnostics.push({
        toolIndex,
        violations: [`tool[${toolIndex}].name is unreadable`],
      });
      continue;
    }
    if (typeof name !== "string" || !name) {
      diagnostics.push({
        toolIndex,
        violations: [`tool[${toolIndex}].name is empty`],
      });
      continue;
    }

    let parameters: unknown;
    try {
      parameters = tool.parameters;
    } catch {
      diagnostics.push({
        toolIndex,
        toolName: name,
        violations: [`${name}.parameters is unreadable`],
      });
      continue;
    }
    const schemaProjection = projectRuntimeToolInputSchema(parameters ?? {}, `${name}.parameters`);
    if (!isRecord(schemaProjection.schema) || schemaProjection.violations.length > 0) {
      diagnostics.push({
        toolIndex,
        toolName: name,
        violations:
          schemaProjection.violations.length > 0
            ? schemaProjection.violations
            : [`${name}.parameters must be a JSON object schema`],
      });
      continue;
    }

    let descriptionValue: unknown;
    try {
      descriptionValue = tool.description;
    } catch {
      // Description is optional; preserve the usable function schema.
    }
    const description = typeof descriptionValue === "string" ? descriptionValue : undefined;
    projectedTools.push({
      toolIndex,
      name,
      ...(description !== undefined ? { description } : {}),
      parameters: schemaProjection.schema,
    });
  }

  return {
    inputToolCount,
    tools: projectedTools,
    diagnostics,
  };
}

function requireProjectedFunction(
  name: string,
  projection: OpenAIToolProjection,
  choiceLabel: string,
): void {
  if (!projection.tools.some((tool) => tool.name === name)) {
    throw new Error(`${choiceLabel} requested unavailable tool "${name}" after schema conversion`);
  }
}

/** Keeps Responses tool choices aligned with surviving function schemas. */
export function reconcileOpenAIResponsesToolChoice(
  choice: OpenAIResponsesToolChoice,
  projection: OpenAIToolProjection,
): OpenAIResponsesToolChoice | undefined {
  if (choice === "auto") {
    return projection.tools.length > 0 ? choice : undefined;
  }
  if (choice === "required") {
    if (projection.tools.length === 0) {
      throw new Error(
        "OpenAI Responses tool_choice requires a tool, but no tools survived schema conversion",
      );
    }
    return choice;
  }
  if (choice === "none" || !isRecord(choice)) {
    return choice;
  }
  const choiceType = choice.type;
  if (choiceType === "function") {
    const functionName = choice.name;
    if (typeof functionName !== "string") {
      return choice;
    }
    requireProjectedFunction(functionName, projection, "OpenAI Responses tool_choice");
    return { type: "function", name: functionName };
  }
  if (choiceType !== "allowed_tools") {
    return choice;
  }

  const mode = choice.mode;
  const tools = choice.tools;
  if ((mode !== "auto" && mode !== "required") || !Array.isArray(tools)) {
    return choice;
  }
  const normalizedAllowedTools: OpenAIResponsesAllowedToolChoice["tools"] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || tool.type !== "function") {
      normalizedAllowedTools.push(tool);
      continue;
    }
    const functionName = tool.name;
    if (
      typeof functionName === "string" &&
      projection.tools.some((projectedTool) => projectedTool.name === functionName)
    ) {
      normalizedAllowedTools.push({ type: "function", name: functionName });
    }
  }
  if (normalizedAllowedTools.length === 0) {
    if (mode === "auto") {
      return "none";
    }
    throw new Error(
      "OpenAI Responses tool_choice requires a tool, but no allowed tools survived schema conversion",
    );
  }
  return {
    type: "allowed_tools",
    mode,
    tools: normalizedAllowedTools,
  };
}

/** Keeps Chat Completions tool choices aligned with surviving function schemas. */
export function reconcileOpenAICompletionsToolChoice(
  choice: OpenAICompletionsSdkToolChoice,
  projection: OpenAIToolProjection,
): OpenAICompletionsSdkToolChoice | undefined {
  if (choice === "auto") {
    return projection.tools.length > 0 ? choice : undefined;
  }
  if (choice === "required") {
    if (projection.tools.length === 0) {
      throw new Error(
        "OpenAI Chat Completions tool_choice requires a tool, but no tools survived schema conversion",
      );
    }
    return choice;
  }
  if (choice === "none" || !isRecord(choice)) {
    return choice;
  }
  const choiceType = choice.type;
  if (choiceType === "custom") {
    throw new Error(
      "OpenAI Chat Completions custom tool_choice is unsupported because this adapter emits function tools only",
    );
  }
  if (choiceType === "function") {
    const functionChoice = choice.function;
    if (!isRecord(functionChoice)) {
      return choice;
    }
    const functionName = functionChoice.name;
    if (typeof functionName !== "string") {
      return choice;
    }
    requireProjectedFunction(functionName, projection, "OpenAI Chat Completions tool_choice");
    return { type: "function", function: { name: functionName } };
  }
  if (choiceType !== "allowed_tools") {
    return choice;
  }

  const allowedConfig = choice.allowed_tools;
  if (!isRecord(allowedConfig)) {
    return choice;
  }
  const mode = allowedConfig.mode;
  const tools = allowedConfig.tools;
  if ((mode !== "auto" && mode !== "required") || !Array.isArray(tools)) {
    return choice;
  }
  const normalizedAllowedTools: OpenAICompletionsAllowedToolChoice["allowed_tools"]["tools"] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || tool.type !== "function") {
      continue;
    }
    const functionChoice = tool.function;
    const functionName = isRecord(functionChoice) ? functionChoice.name : undefined;
    if (
      typeof functionName === "string" &&
      projection.tools.some((projectedTool) => projectedTool.name === functionName)
    ) {
      normalizedAllowedTools.push({
        type: "function",
        function: { name: functionName },
      });
    }
  }
  if (normalizedAllowedTools.length === 0) {
    if (mode === "auto") {
      return "none";
    }
    throw new Error(
      "OpenAI Chat Completions tool_choice requires a tool, but no allowed tools survived schema conversion",
    );
  }
  return {
    type: "allowed_tools",
    allowed_tools: {
      mode,
      tools: normalizedAllowedTools,
    },
  };
}
