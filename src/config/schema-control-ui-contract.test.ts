import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { analyzeConfigSchema } from "../../ui/src/components/config-form.analyze.js";
import { isSupportedConfigValueValid } from "../../ui/src/components/config-form.constraints.js";
import type { JsonSchema } from "../../ui/src/components/config-form.shared.js";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";

type MixedUnion = {
  path: string;
  schema: JsonSchema;
  literals: unknown[];
};

function pathKey(path: string[]): string {
  return path.join(".");
}

function unionLiterals(schema: JsonSchema): unknown[] {
  const union = schema.anyOf ?? schema.oneOf;
  if (!union) {
    return [];
  }
  return union.flatMap((entry) => {
    if (Array.isArray(entry.enum)) {
      return entry.enum;
    }
    if (Object.hasOwn(entry, "const")) {
      return [entry.const];
    }
    return entry.type === "null" ? [null] : [];
  });
}

function isLiteralOnlyBranch(schema: JsonSchema): boolean {
  return Array.isArray(schema.enum) || Object.hasOwn(schema, "const") || schema.type === "null";
}

function collectMixedUnions(
  schema: JsonSchema,
  path: string[] = [],
  result: MixedUnion[] = [],
): MixedUnion[] {
  const union = schema.anyOf ?? schema.oneOf;
  const literals = unionLiterals(schema);
  if (union && literals.length > 0 && union.some((entry) => !isLiteralOnlyBranch(entry))) {
    result.push({ path: pathKey(path) || "<root>", schema, literals });
  }

  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    collectMixedUnions(child, [...path, key], result);
  }
  const items = schema.items;
  if (Array.isArray(items)) {
    items.forEach((item, index) => collectMixedUnions(item, [...path, String(index)], result));
  } else if (items) {
    collectMixedUnions(items, [...path, "*"], result);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    collectMixedUnions(schema.additionalProperties, [...path, "*"], result);
  }
  for (const branch of [
    ...(schema.allOf ?? []),
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
  ]) {
    collectMixedUnions(branch, path, result);
  }
  return result;
}

function schemaChildAtSegment(schema: JsonSchema, segment: string): JsonSchema | undefined {
  let direct: JsonSchema | undefined;
  if (segment === "*") {
    direct = Array.isArray(schema.items)
      ? undefined
      : schema.items ||
        (schema.additionalProperties && typeof schema.additionalProperties === "object"
          ? schema.additionalProperties
          : undefined);
  } else if (/^\d+$/u.test(segment) && Array.isArray(schema.items)) {
    direct = schema.items[Number(segment)];
  } else {
    direct = schema.properties?.[segment];
  }
  if (direct) {
    return direct;
  }
  for (const branch of [
    ...(schema.allOf ?? []),
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
  ]) {
    const nested = schemaChildAtSegment(branch, segment);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function schemaAtPath(schema: JsonSchema, path: string): JsonSchema | undefined {
  let current: JsonSchema | undefined = schema;
  for (const segment of path === "<root>" ? [] : path.split(".")) {
    if (!current) {
      return undefined;
    }
    current = schemaChildAtSegment(current, segment);
  }
  return current;
}

function isPathUnsupported(path: string, unsupportedPaths: string[]): boolean {
  return unsupportedPaths.some(
    (unsupportedPath) =>
      unsupportedPath === "<root>" ||
      path === unsupportedPath ||
      path.startsWith(`${unsupportedPath}.`),
  );
}

describe("generated config schema Control UI contract", () => {
  it("never drops accepted literals from mixed unions", () => {
    const rawSchema = computeBaseConfigSchemaResponse({
      generatedAt: "control-ui-contract",
    }).schema as JsonSchema;
    const analysis = analyzeConfigSchema(rawSchema);
    const mixedUnions = collectMixedUnions(rawSchema);

    expect(mixedUnions.length).toBeGreaterThan(0);
    const lossyPaths = mixedUnions.flatMap(({ path, schema, literals }) => {
      if (isPathUnsupported(path, analysis.unsupportedPaths)) {
        return [];
      }
      const analyzedSchema = analysis.schema ? schemaAtPath(analysis.schema, path) : undefined;
      return literals
        .filter((literal) => Value.Check(schema as never, literal))
        .filter(
          (literal) => !analyzedSchema || !isSupportedConfigValueValid(analyzedSchema, literal),
        )
        .map(() => path);
    });

    expect([...new Set(lossyPaths)].toSorted()).toEqual([]);
  });

  it("keeps native command settings editable as tri-state controls", () => {
    const rawSchema = computeBaseConfigSchemaResponse({
      generatedAt: "control-ui-contract",
    }).schema as JsonSchema;
    const analysis = analyzeConfigSchema(rawSchema);

    for (const path of ["commands.native", "commands.nativeSkills"]) {
      expect(isPathUnsupported(path, analysis.unsupportedPaths)).toBe(false);
      expect(analysis.schema ? schemaAtPath(analysis.schema, path) : undefined).toMatchObject({
        enum: [true, false, "auto"],
        default: "auto",
      });
    }
  });
});
