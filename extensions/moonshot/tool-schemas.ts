// Moonshot tool-schema normalization for the "moonshot flavored json schema" contract.
import type {
  AnyAgentTool,
  ProviderNormalizeToolSchemasContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord as readRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

// Draft-07 `dependencies` is the union of the modern `dependentSchemas` and
// `dependentRequired`: each value is either a subschema or a list of property names.
// Walking it is safe for both, because the list form holds strings and a string is
// not a record, so it round-trips unchanged.
const SCHEMA_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "$defs",
  "definitions",
]);

const SCHEMA_VALUE_KEYS = new Set([
  "items",
  "additionalItems",
  "prefixItems",
  "additionalProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "then",
  "else",
  "if",
  "not",
  "contains",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentSchema",
]);

/** Own-property assignment so an own `__proto__` key from an MCP server stays an own key. */
function setOwnKey(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** Declared types of a schema node, or null when it declares none we can safely move. */
function readSchemaTypes(schema: Record<string, unknown>): string[] | null {
  const type = schema.type;
  if (typeof type === "string") {
    return [type];
  }
  if (Array.isArray(type) && type.length > 0 && type.every((entry) => typeof entry === "string")) {
    return type as string[];
  }
  return null;
}

/**
 * JSON Schema treats `integer` as a numeric subtype: every integer value already satisfies
 * `number`, so a branch typed `integer` is no wider than a `number` parent even though the
 * literal strings differ.
 */
function isBranchTypeCompatible(branchType: string, parentTypeSet: Set<string>): boolean {
  return parentTypeSet.has(branchType) || (branchType === "integer" && parentTypeSet.has("number"));
}

/**
 * Only move a parent `type` when every branch keeps the same value set: untyped branches inherit
 * it, and already-typed branches must be no wider than the parent.
 *
 * `$ref` and boolean branches have an unknown type, and a branch that is itself a union would need
 * `type` as an item of the outer union while forbidding it as the parent of its own — no rewrite
 * satisfies Moonshot there, so those nodes keep the schema the server sent.
 */
function canPushTypeIntoBranches(branches: unknown[], parentTypes: string[]): boolean {
  const parentTypeSet = new Set(parentTypes);
  return (
    branches.length > 0 &&
    branches.every((branch) => {
      const record = readRecord(branch);
      if (!record || "$ref" in record) {
        return false;
      }
      if (Array.isArray(record.anyOf) || Array.isArray(record.oneOf)) {
        return false;
      }
      const branchTypes = readSchemaTypes(record);
      return branchTypes === null
        ? !("type" in record)
        : branchTypes.every((entry) => isBranchTypeCompatible(entry, parentTypeSet));
    })
  );
}

/**
 * Moonshot rejects the whole request when an `anyOf` branch omits `type`, demanding the type sit on
 * the branches instead of the parent. Parent keywords and union branches are conjunctive, so moving
 * the parent `type` into every untyped branch accepts the identical value set while satisfying that
 * contract. Only `anyOf` is rewritten because only `anyOf` is evidenced by the provider error.
 */
function normalizeMoonshotSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(normalizeMoonshotSchema);
  }
  const record = readRecord(schema);
  if (!record) {
    return schema;
  }

  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SCHEMA_MAP_KEYS.has(key) && readRecord(value)) {
      const mapped: Record<string, unknown> = {};
      for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
        setOwnKey(mapped, entryKey, normalizeMoonshotSchema(entryValue));
      }
      setOwnKey(next, key, mapped);
      continue;
    }
    if (SCHEMA_VALUE_KEYS.has(key)) {
      setOwnKey(next, key, normalizeMoonshotSchema(value));
      continue;
    }
    setOwnKey(next, key, value);
  }

  const parentTypes = readSchemaTypes(next);
  const branches = next.anyOf;
  if (!parentTypes || !Array.isArray(branches) || !canPushTypeIntoBranches(branches, parentTypes)) {
    return next;
  }

  const parentType = next.type;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (key !== "type") {
      setOwnKey(result, key, value);
    }
  }
  setOwnKey(
    result,
    "anyOf",
    branches.map((branch) => {
      const branchRecord = branch as Record<string, unknown>;
      if ("type" in branchRecord) {
        return branchRecord;
      }
      const typedBranch: Record<string, unknown> = {};
      setOwnKey(typedBranch, "type", parentType);
      for (const [key, value] of Object.entries(branchRecord)) {
        setOwnKey(typedBranch, key, value);
      }
      return typedBranch;
    }),
  );
  return result;
}

/**
 * Runs on every tool the runner registers, including MCP tools materialized after the base tool
 * set, which is where the rejected schemas in practice come from.
 */
export function normalizeMoonshotToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): AnyAgentTool[] {
  return ctx.tools.map((tool) => {
    if (!tool.parameters || typeof tool.parameters !== "object") {
      return tool;
    }
    return {
      ...tool,
      parameters: normalizeMoonshotSchema(tool.parameters) as AnyAgentTool["parameters"],
    };
  });
}
