import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { projectRuntimeToolInputSchema } from "./tool-schema-json-projection.js";

type AnthropicToolDescriptor = {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
};

type AnthropicProjectedTool = {
  readonly originalName: string;
  readonly wireName: string;
  readonly description?: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Record<string, unknown>;
    readonly required: string[];
  };
};

export type AnthropicToolProjection = {
  readonly inputToolCount: number;
  readonly unavailableOriginalNames: ReadonlySet<string>;
  readonly tools: readonly AnthropicProjectedTool[];
};

type AnthropicParallelToolChoice = {
  readonly disable_parallel_tool_use?: boolean;
};

export type AnthropicProjectedToolChoice =
  | ({ readonly type: "auto" } & AnthropicParallelToolChoice)
  | ({ readonly type: "any" } & AnthropicParallelToolChoice)
  | { readonly type: "none" }
  | ({ readonly type: "tool"; readonly name: string } & AnthropicParallelToolChoice);

function isProviderSupportedViolation(violation: string): boolean {
  return violation.endsWith(".$dynamicRef") || violation.endsWith(".$dynamicAnchor");
}

const schemaValueKeywords = new Set([
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const schemaArrayKeywords = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

function normalizeAnthropicJsonSchema(schema: unknown): unknown {
  if (!isRecord(schema)) {
    return schema;
  }

  let changed = false;
  const normalized: Record<string, unknown> = { ...schema };
  for (const [key, value] of Object.entries(schema)) {
    if (schemaValueKeywords.has(key) && !Array.isArray(value)) {
      const next = normalizeAnthropicJsonSchema(value);
      normalized[key] = next;
      changed ||= next !== value;
      continue;
    }
    if (schemaArrayKeywords.has(key) && Array.isArray(value)) {
      const next = value.map(normalizeAnthropicJsonSchema);
      normalized[key] = next;
      changed ||= next.some((entry, index) => entry !== value[index]);
      continue;
    }
    if (schemaMapKeywords.has(key) && isRecord(value)) {
      const next = Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => [
          entryKey,
          normalizeAnthropicJsonSchema(entryValue),
        ]),
      );
      normalized[key] = next;
      changed ||= Object.entries(value).some(
        ([entryKey, entryValue]) => next[entryKey] !== entryValue,
      );
    }
  }

  if (Array.isArray(schema.items)) {
    normalized.prefixItems = schema.items.map(normalizeAnthropicJsonSchema);
    const additionalItems = schema.additionalItems;
    if (typeof additionalItems === "boolean" || isRecord(additionalItems)) {
      normalized.items = normalizeAnthropicJsonSchema(additionalItems);
    } else {
      delete normalized.items;
    }
    delete normalized.additionalItems;
    changed = true;
  }

  return changed ? normalized : schema;
}

/** Snapshots direct/custom tool descriptors before Anthropic payload construction. */
export function projectAnthropicTools(
  tools: readonly AnthropicToolDescriptor[],
  toWireName: (name: string) => string,
): AnthropicToolProjection {
  const projectedTools: AnthropicProjectedTool[] = [];
  const unavailableOriginalNames = new Set<string>();
  for (const tool of tools) {
    let projectedTool: AnthropicProjectedTool;
    let originalName: string | undefined;
    try {
      const name = tool.name;
      originalName = name;
      if (!name) {
        continue;
      }
      const schemaProjection = projectRuntimeToolInputSchema(tool.parameters, `${name}.parameters`);
      if (
        !isRecord(schemaProjection.schema) ||
        schemaProjection.violations.some((violation) => !isProviderSupportedViolation(violation))
      ) {
        unavailableOriginalNames.add(name);
        continue;
      }
      const anthropicSchema = normalizeAnthropicJsonSchema(schemaProjection.schema);
      if (!isRecord(anthropicSchema)) {
        unavailableOriginalNames.add(name);
        continue;
      }
      const properties = anthropicSchema.properties;
      const required = anthropicSchema.required;
      if (
        (properties !== undefined && properties !== null && !isRecord(properties)) ||
        (required !== undefined &&
          required !== null &&
          (!Array.isArray(required) || required.some((entry) => typeof entry !== "string")))
      ) {
        unavailableOriginalNames.add(name);
        continue;
      }
      let description: string | undefined;
      try {
        description = typeof tool.description === "string" ? tool.description : undefined;
      } catch {
        // Description is optional; keep the usable tool schema.
      }
      const wireName = toWireName(name);
      projectedTool = {
        originalName: name,
        wireName,
        ...(description ? { description } : {}),
        inputSchema: {
          type: "object",
          properties: (properties ?? {}) as Record<string, unknown>,
          required: (required ?? []) as string[],
        },
      };
    } catch {
      // Direct/custom tool arrays can bypass the runtime quarantine.
      if (originalName) {
        unavailableOriginalNames.add(originalName);
      }
      continue;
    }
    const conflictingTool = projectedTools.find(
      (entry) => entry.wireName === projectedTool.wireName,
    );
    if (conflictingTool && conflictingTool.originalName !== projectedTool.originalName) {
      throw new Error(
        `Anthropic tool names "${conflictingTool.originalName}" and "${projectedTool.originalName}" both map to "${projectedTool.wireName}"`,
      );
    }
    projectedTools.push(projectedTool);
  }
  return {
    inputToolCount: tools.length,
    unavailableOriginalNames,
    tools: projectedTools,
  };
}

/** Keeps forced Anthropic tool choices aligned with the projected wire names. */
export function reconcileAnthropicToolChoice(
  choice: AnthropicProjectedToolChoice,
  projection: AnthropicToolProjection,
): AnthropicProjectedToolChoice | undefined {
  if (projection.inputToolCount === 0) {
    return choice;
  }
  if (choice.type === "tool") {
    const requestedName = choice.name;
    const originalMatch = projection.tools.find((tool) => tool.originalName === requestedName);
    if (originalMatch) {
      return { ...choice, name: originalMatch.wireName };
    }
    if (projection.unavailableOriginalNames.has(requestedName)) {
      throw new Error(
        `Anthropic tool_choice requested unavailable tool "${requestedName}" after schema conversion`,
      );
    }
    const matchedTool = projection.tools.find((tool) => tool.wireName === requestedName);
    if (!matchedTool) {
      throw new Error(
        `Anthropic tool_choice requested unavailable tool "${requestedName}" after schema conversion`,
      );
    }
    return { ...choice, name: matchedTool.wireName };
  }
  if (projection.tools.length === 0) {
    if (choice.type === "auto") {
      return undefined;
    }
    if (choice.type === "any") {
      throw new Error(
        "Anthropic tool_choice requires a tool, but no tools survived schema conversion",
      );
    }
  }
  return choice;
}

/** Maps Claude Code wire names without trusting every direct/custom descriptor. */
export function resolveOriginalAnthropicToolName(
  name: string,
  projection: AnthropicToolProjection | undefined,
): string {
  return projection?.tools.find((tool) => tool.wireName === name)?.originalName ?? name;
}
