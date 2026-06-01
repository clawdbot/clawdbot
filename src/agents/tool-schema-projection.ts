import type { AnyAgentTool } from "./tools/common.js";

export type RuntimeToolInputSchemaJson =
  | null
  | boolean
  | number
  | string
  | RuntimeToolInputSchemaJson[]
  | { [key: string]: RuntimeToolInputSchemaJson };

export type RuntimeToolInputSchemaProjection = {
  readonly schema: RuntimeToolInputSchemaJson;
  readonly violations: readonly string[];
};

export type RuntimeToolSchemaDiagnostic = {
  readonly toolName: string;
  readonly toolIndex: number;
  readonly violations: readonly string[];
};

export type RuntimeToolSchemaInspection<TTool extends Pick<AnyAgentTool, "name" | "parameters">> = {
  readonly tools: readonly TTool[];
  readonly diagnostics: readonly RuntimeToolSchemaDiagnostic[];
};

type RuntimeToolEntryRead<TTool extends Pick<AnyAgentTool, "name" | "parameters">> =
  | {
      readonly ok: true;
      readonly tool: TTool;
      readonly toolIndex: number;
    }
  | {
      readonly ok: false;
      readonly diagnostic: RuntimeToolSchemaDiagnostic;
    };

type ToolSchemaInspectionMode = "runtime" | "provider-normalizable";

function unreadableRuntimeToolEntry(
  toolIndex: number,
): RuntimeToolEntryRead<Pick<AnyAgentTool, "name" | "parameters">> {
  return {
    ok: false,
    diagnostic: {
      toolName: `tool[${toolIndex}]`,
      toolIndex,
      violations: [`tool[${toolIndex}] is unreadable`],
    },
  };
}

function readRuntimeToolEntries<TTool extends Pick<AnyAgentTool, "name" | "parameters">>(
  tools: readonly TTool[],
): RuntimeToolEntryRead<TTool>[] {
  let length: number;
  try {
    length = tools.length;
  } catch {
    return [unreadableRuntimeToolEntry(0) as RuntimeToolEntryRead<TTool>];
  }
  const entries: RuntimeToolEntryRead<TTool>[] = [];
  for (let toolIndex = 0; toolIndex < length; toolIndex += 1) {
    try {
      entries.push({ ok: true, tool: tools[toolIndex], toolIndex });
    } catch {
      entries.push(unreadableRuntimeToolEntry(toolIndex) as RuntimeToolEntryRead<TTool>);
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

function isJsonValue(value: unknown): value is RuntimeToolInputSchemaJson {
  if (value === null) {
    return true;
  }
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return true;
    case "object":
      if (Array.isArray(value)) {
        return value.every(isJsonValue);
      }
      return Object.values(value as Record<string, unknown>).every(isJsonValue);
    default:
      return false;
  }
}

function isJsonObject(value: RuntimeToolInputSchemaJson): value is {
  [key: string]: RuntimeToolInputSchemaJson;
} {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializeToolInputSchema(value: unknown, path: string): RuntimeToolInputSchemaProjection {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return {
      schema: {},
      violations: [`${path} is not JSON-serializable`],
    };
  }
  if (!text) {
    return {
      schema: {},
      violations: [`${path} is not JSON-serializable`],
    };
  }
  const parsed = JSON.parse(text) as unknown;
  if (!isJsonValue(parsed)) {
    return {
      schema: {},
      violations: [`${path} is not a JSON value`],
    };
  }
  return {
    schema: parsed,
    violations: [],
  };
}

function findDynamicSchemaKeywordViolations(
  schema: RuntimeToolInputSchemaJson,
  path: string,
): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((entry, index) =>
      findDynamicSchemaKeywordViolations(entry, `${path}[${index}]`),
    );
  }
  if (!isJsonObject(schema)) {
    return [];
  }
  const violations: string[] = [];
  for (const key of ["$dynamicRef", "$dynamicAnchor"] as const) {
    if (key in schema) {
      violations.push(`${path}.${key}`);
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    if (schemaMapKeywords.has(key) && isJsonObject(value)) {
      for (const [schemaName, childSchema] of Object.entries(value)) {
        violations.push(
          ...findDynamicSchemaKeywordViolations(childSchema, `${path}.${key}.${schemaName}`),
        );
      }
    } else {
      violations.push(...findDynamicSchemaKeywordViolations(value, `${path}.${key}`));
    }
  }
  return violations;
}

const schemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

export function projectRuntimeToolInputSchema(
  schema: unknown,
  path = "parameters",
): RuntimeToolInputSchemaProjection {
  const projection = serializeToolInputSchema(schema, path);
  const violations = [...projection.violations];
  if (!isJsonObject(projection.schema)) {
    violations.push(`${path} must be a JSON object schema`);
  } else if (projection.schema.type !== undefined && projection.schema.type !== "object") {
    violations.push(`${path}.type must be "object"`);
  }
  violations.push(...findDynamicSchemaKeywordViolations(projection.schema, path));
  return {
    schema: projection.schema,
    violations,
  };
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
  entries: readonly RuntimeToolEntryRead<TTool>[],
  mode: ToolSchemaInspectionMode,
): RuntimeToolSchemaInspection<TTool> {
  const diagnostics: RuntimeToolSchemaDiagnostic[] = [];
  const compatibleTools: TTool[] = [];
  for (const entry of entries) {
    if (!entry.ok) {
      diagnostics.push(entry.diagnostic);
      continue;
    }
    const diagnostic = inspectToolSchema(entry.tool, entry.toolIndex, mode);
    if (diagnostic) {
      diagnostics.push(diagnostic);
      continue;
    }
    compatibleTools.push(entry.tool);
  }
  return { tools: compatibleTools, diagnostics };
}

export function inspectRuntimeToolInputSchemas(
  tools: readonly Pick<AnyAgentTool, "name" | "parameters">[],
): RuntimeToolSchemaDiagnostic[] {
  return [...inspectToolEntries(readRuntimeToolEntries(tools), "runtime").diagnostics];
}

export function filterRuntimeCompatibleTools<
  TTool extends Pick<AnyAgentTool, "name" | "parameters">,
>(tools: readonly TTool[]): RuntimeToolSchemaInspection<TTool> {
  return inspectToolEntries(readRuntimeToolEntries(tools), "runtime");
}

export function filterProviderNormalizableTools<
  TTool extends Pick<AnyAgentTool, "name" | "parameters">,
>(tools: readonly TTool[]): RuntimeToolSchemaInspection<TTool> {
  return inspectToolEntries(readRuntimeToolEntries(tools), "provider-normalizable");
}
