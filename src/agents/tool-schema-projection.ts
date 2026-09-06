import { projectRuntimeToolInputSchema } from "@openclaw/ai/internal/openai";
/**
 * Projects agent tool schemas into JSON-safe runtime shapes and diagnostics.
 * Provider/runtime dispatch uses this module to drop incompatible tools before
 * sending schemas to model APIs.
 */
import type { AnyAgentTool } from "./tools/common.js";

export { projectRuntimeToolInputSchema } from "@openclaw/ai/internal/openai";
export type {
  RuntimeToolInputSchemaJson,
  RuntimeToolInputSchemaProjection,
} from "@openclaw/ai/internal/openai";

/** Diagnostic for one incompatible runtime tool schema. */
export type RuntimeToolSchemaDiagnostic = {
  readonly toolName: string;
  readonly toolIndex: number;
  readonly violations: readonly string[];
};

/** Runtime tool list split into compatible tools and schema diagnostics. */
type RuntimeToolSchemaInspection<TTool extends Pick<AnyAgentTool, "name" | "parameters">> = {
  readonly tools: TTool[];
  readonly diagnostics: readonly RuntimeToolSchemaDiagnostic[];
};

type ToolSchemaInspectionMode = "runtime" | "provider-normalizable";

function unreadableRuntimeToolDiagnostic(toolIndex: number): RuntimeToolSchemaDiagnostic {
  return {
    toolName: `tool[${toolIndex}]`,
    toolIndex,
    violations: [`tool[${toolIndex}] is unreadable`],
  };
}

function readRuntimeToolEntries<TTool extends Pick<AnyAgentTool, "name" | "parameters">>(
  tools: readonly TTool[],
): (TTool | undefined)[] {
  let length: number;
  try {
    length = tools.length;
  } catch {
    return [undefined];
  }
  // Snapshot every entry before schema getters can mutate the source array.
  const entries: (TTool | undefined)[] = [];
  for (let toolIndex = 0; toolIndex < length; toolIndex += 1) {
    try {
      entries.push(tools.at(toolIndex));
    } catch {
      entries.push(undefined);
    }
  }
  return entries;
}

function readToolProjectionField<TField extends "name" | "parameters">(
  tool: Pick<AnyAgentTool, "name" | "parameters">,
  field: TField,
):
  | { readable: true; value: Pick<AnyAgentTool, "name" | "parameters">[TField] }
  | { readable: false } {
  try {
    return { readable: true, value: tool[field] };
  } catch {
    return { readable: false };
  }
}

function inspectToolSchema(
  tool: Pick<AnyAgentTool, "name" | "parameters">,
  toolIndex: number,
  mode: ToolSchemaInspectionMode,
): RuntimeToolSchemaDiagnostic | undefined {
  const nameRead = readToolProjectionField(tool, "name");
  const toolName =
    nameRead.readable && typeof nameRead.value === "string" && nameRead.value
      ? nameRead.value
      : `tool[${toolIndex}]`;
  const descriptorViolations = nameRead.readable ? [] : [`${toolName}.name is unreadable`];
  const parametersRead = readToolProjectionField(tool, "parameters");
  if (!parametersRead.readable) {
    return {
      toolName,
      toolIndex,
      violations: [...descriptorViolations, `${toolName}.parameters is unreadable`],
    };
  }
  if (mode === "provider-normalizable" && parametersRead.value === undefined) {
    return descriptorViolations.length > 0
      ? { toolName, toolIndex, violations: descriptorViolations }
      : undefined;
  }

  const schemaPath = `${toolName}.parameters`;
  const projection = projectRuntimeToolInputSchema(parametersRead.value, schemaPath);
  const projectionViolations =
    mode === "runtime"
      ? projection.violations
      : projection.violations.filter(
          (violation) =>
            violation !== `${schemaPath}.$dynamicRef` &&
            violation !== `${schemaPath}.$dynamicAnchor` &&
            !violation.endsWith(".$dynamicRef") &&
            !violation.endsWith(".$dynamicAnchor"),
        );
  const violations = [...descriptorViolations, ...projectionViolations];
  return violations.length > 0 ? { toolName, toolIndex, violations } : undefined;
}

function inspectToolEntries<TTool extends Pick<AnyAgentTool, "name" | "parameters">>(
  entries: readonly (TTool | undefined)[],
  mode: ToolSchemaInspectionMode,
): RuntimeToolSchemaInspection<TTool> {
  const diagnostics: RuntimeToolSchemaDiagnostic[] = [];
  const compatibleTools: TTool[] = [];
  for (let toolIndex = 0; toolIndex < entries.length; toolIndex += 1) {
    const tool = entries[toolIndex];
    if (tool === undefined) {
      diagnostics.push(unreadableRuntimeToolDiagnostic(toolIndex));
      continue;
    }
    const diagnostic = inspectToolSchema(tool, toolIndex, mode);
    if (diagnostic) {
      diagnostics.push(diagnostic);
      continue;
    }
    compatibleTools.push(tool);
  }
  return { tools: compatibleTools, diagnostics };
}

/** Inspects runtime tool schemas and returns diagnostics without filtering tools. */
export function inspectRuntimeToolInputSchemas(
  tools: readonly Pick<AnyAgentTool, "name" | "parameters">[],
): RuntimeToolSchemaDiagnostic[] {
  return [...inspectToolEntries(readRuntimeToolEntries(tools), "runtime").diagnostics];
}

/** Filters tools to those with schemas accepted by the runtime as-is. */
export function filterRuntimeCompatibleTools<
  TTool extends Pick<AnyAgentTool, "name" | "parameters">,
>(tools: readonly TTool[]): RuntimeToolSchemaInspection<TTool> {
  return inspectToolEntries(readRuntimeToolEntries(tools), "runtime");
}

/** Filters tools to those that providers can normalize before dispatch. */
export function filterProviderNormalizableTools<
  TTool extends Pick<AnyAgentTool, "name" | "parameters">,
>(tools: readonly TTool[]): RuntimeToolSchemaInspection<TTool> {
  return inspectToolEntries(readRuntimeToolEntries(tools), "provider-normalizable");
}
