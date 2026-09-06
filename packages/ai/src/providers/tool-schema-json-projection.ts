import { types as utilTypes } from "node:util";
import { isRecord as isJsonObject } from "@openclaw/normalization-core/record-coerce";

/** JSON-safe schema value used when projecting runtime tool parameters. */
export type RuntimeToolInputSchemaJson =
  | null
  | boolean
  | number
  | string
  | RuntimeToolInputSchemaJson[]
  | { [key: string]: RuntimeToolInputSchemaJson };

/** Projected runtime tool schema plus validation violations. */
export type RuntimeToolInputSchemaProjection = {
  readonly schema: RuntimeToolInputSchemaJson;
  readonly violations: readonly string[];
};

function isNonFiniteNumberValue(value: unknown): boolean {
  if (typeof value === "number") {
    return !Number.isFinite(value);
  }
  if (value === null || typeof value !== "object" || !utilTypes.isNumberObject(value)) {
    return false;
  }
  return !Number.isFinite(Number.prototype.valueOf.call(value));
}

function serializeToolInputSchema(value: unknown, path: string): RuntimeToolInputSchemaProjection {
  const nonFiniteNumber = {
    path: null as string | null,
  };
  const paths = new WeakMap<object, string>();
  let isRoot = true;
  let text: string | undefined;
  try {
    text = JSON.stringify(value, function (this: object, key, entry) {
      const invalidNumber = nonFiniteNumber.path === null && isNonFiniteNumberValue(entry);
      if (invalidNumber || (entry && typeof entry === "object")) {
        const holderPath = paths.get(this);
        const entryPath = isRoot
          ? path
          : holderPath === undefined
            ? `${path}.${key}`
            : Array.isArray(this)
              ? `${holderPath}[${key}]`
              : `${holderPath}.${key}`;
        if (invalidNumber) {
          nonFiniteNumber.path = entryPath;
        } else {
          paths.set(entry, entryPath);
        }
      }
      isRoot = false;
      return entry;
    });
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
  if (nonFiniteNumber.path !== null) {
    const violationPath = nonFiniteNumber.path;
    return {
      schema: {},
      violations: [`${violationPath} is not JSON-serializable`],
    };
  }
  return {
    schema: JSON.parse(text) as RuntimeToolInputSchemaJson,
    violations: [],
  };
}

const schemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

function inspectJsonSchema(
  schema: RuntimeToolInputSchemaJson,
  path: string,
  violations: string[],
): boolean {
  if (Array.isArray(schema)) {
    return schema.every((entry, index) =>
      inspectJsonSchema(entry, `${path}[${index}]`, violations),
    );
  }
  if (!isJsonObject(schema)) {
    // Raw JSON numeric literals can overflow during parsing without passing
    // through the stringify replacer's non-finite number check.
    return typeof schema !== "number" || Number.isFinite(schema);
  }
  for (const key of ["$dynamicRef", "$dynamicAnchor"] as const) {
    if (key in schema) {
      violations.push(`${path}.${key}`);
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      return false;
    }
    if (!value || typeof value !== "object") {
      continue;
    }
    if (schemaMapKeywords.has(key) && isJsonObject(value)) {
      for (const [schemaName, childSchema] of Object.entries(value)) {
        if (!inspectJsonSchema(childSchema, `${path}.${key}.${schemaName}`, violations)) {
          return false;
        }
      }
    } else if (!inspectJsonSchema(value, `${path}.${key}`, violations)) {
      return false;
    }
  }
  return true;
}

/** Projects one runtime tool input schema to JSON and reports runtime incompatibilities. */
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
  if (!inspectJsonSchema(projection.schema, path, violations)) {
    return { schema: {}, violations: [`${path} is not a JSON value`] };
  }
  return {
    schema: projection.schema,
    violations,
  };
}
