// OpenAI Responses tool helpers convert runtime tools to Responses API schemas.
import { createHash } from "node:crypto";
import type { Tool as OpenAITool } from "openai/resources/responses/responses.js";
import { resolveOpenAIStrictToolSetting } from "../../agents/openai-strict-tool-setting.js";
import {
  findOpenAIStrictToolSchemaDiagnostics,
  normalizeOpenAIStrictToolParameters,
  resolveOpenAIStrictToolFlagForInventory,
} from "../../agents/openai-tool-schema.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { Model, Tool } from "../types.js";

/** Options for converting internal tool schemas to OpenAI Responses function tools. */
export interface ConvertResponsesToolsOptions {
  strict?: boolean | null;
  model?: Model;
  supportsStrictMode?: boolean;
}

type OpenAIToolSchemaCompat = Parameters<typeof normalizeOpenAIStrictToolParameters>[2];
type ResponsesFunctionTool = {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean | null;
};

// Converts OpenClaw tool schemas to OpenAI Responses tools, including strict-mode compatibility.
const log = createSubsystemLogger("llm/openai-responses");
const MAX_STRICT_TOOL_DOWNGRADE_DIAGNOSTIC_KEYS = 64;
const loggedStrictToolDowngradeDiagnosticKeys = new Set<string>();

/** Converts tools to deterministic OpenAI Responses function tool definitions. */
export function convertResponsesTools(
  tools: Tool[],
  options?: ConvertResponsesToolsOptions,
): OpenAITool[] {
  const strictSetting = resolveResponsesStrictToolSetting(options);
  const strict = resolveResponsesStrictToolFlag(tools, strictSetting, options?.model);
  // Sort tools before request construction so prompt-cache bytes stay deterministic.
  return sortResponsesToolsByName(tools).map((tool) => {
    const result: ResponsesFunctionTool = {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: normalizeOpenAIStrictToolParameters(
        tool.parameters,
        strict === true,
        options?.model?.compat as OpenAIToolSchemaCompat,
      ) as Record<string, unknown>,
    };
    if (strict !== undefined) {
      result.strict = strict;
    }
    return result as OpenAITool;
  });
}

function resolveResponsesStrictToolSetting(
  options: ConvertResponsesToolsOptions | undefined,
): boolean | null | undefined {
  if (options?.strict !== undefined) {
    return options.strict;
  }
  if (options?.model) {
    return resolveOpenAIStrictToolSetting(options.model, {
      transport: "stream",
      supportsStrictMode: options.supportsStrictMode,
    });
  }
  return false;
}

function resolveResponsesStrictToolFlag(
  tools: Tool[],
  strictSetting: boolean | null | undefined,
  model: Model | undefined,
): boolean | undefined {
  const strict = resolveOpenAIStrictToolFlagForInventory(tools, strictSetting);
  if (strictSetting === true && strict === false && model && log.isEnabled("debug", "any")) {
    const diagnostics = findOpenAIStrictToolSchemaDiagnostics(tools);
    if (shouldLogStrictToolDowngradeDiagnostic(diagnostics, model)) {
      const sample = diagnostics.slice(0, 5).map((entry) => ({
        tool: entry.toolName ?? `tool[${entry.toolIndex}]`,
        violations: entry.violations.slice(0, 8),
      }));
      log.debug(
        `OpenAI responses tool schema strict mode downgraded to strict=false for ` +
          `${model.provider ?? "unknown"}/${model.id ?? "unknown"} because ` +
          `${diagnostics.length} tool schema(s) are not strict-compatible`,
        {
          provider: model.provider,
          model: model.id,
          incompatibleToolCount: diagnostics.length,
          sample,
        },
      );
    }
  }
  return strict;
}

function shouldLogStrictToolDowngradeDiagnostic(
  diagnostics: ReturnType<typeof findOpenAIStrictToolSchemaDiagnostics>,
  model: Model,
): boolean {
  // Strict downgrade diagnostics can repeat per turn; hash details and cap memory.
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        provider: model.provider,
        model: model.id,
        diagnostics: diagnostics.map((entry) => ({
          toolIndex: entry.toolIndex,
          toolName: entry.toolName ?? null,
          violations: entry.violations,
        })),
      }),
    )
    .digest("hex");
  if (loggedStrictToolDowngradeDiagnosticKeys.has(key)) {
    return false;
  }
  if (loggedStrictToolDowngradeDiagnosticKeys.size >= MAX_STRICT_TOOL_DOWNGRADE_DIAGNOSTIC_KEYS) {
    loggedStrictToolDowngradeDiagnosticKeys.clear();
  }
  loggedStrictToolDowngradeDiagnosticKeys.add(key);
  return true;
}

function compareToolText(left: string | undefined, right: string | undefined): number {
  const leftText = left ?? "";
  const rightText = right ?? "";
  if (leftText < rightText) {
    return -1;
  }
  if (leftText > rightText) {
    return 1;
  }
  return 0;
}

function sortResponsesToolsByName<T extends { name?: string; description?: string }>(
  tools: readonly T[],
): T[] {
  return tools.toSorted(
    (left, right) =>
      compareToolText(left.name, right.name) ||
      compareToolText(left.description, right.description),
  );
}
