import type { ConfigUiHints } from "../api/types.ts";
import { hintForPath, type JsonSchema } from "./config-form.shared.ts";

type ConfigSchemaTierSplit = {
  common: JsonSchema | null;
  advanced: JsonSchema | null;
  commonLeafCount: number;
  advancedLeafCount: number;
};

type TierProjection = {
  schema: JsonSchema | null;
  leaves: Set<string>;
};

function projectSchemaTier(params: {
  schema: JsonSchema;
  path: string[];
  advanced: boolean;
  hints: ConfigUiHints;
}): TierProjection {
  const { schema, path, advanced, hints } = params;
  const leaves = new Set<string>();
  if (Array.isArray(schema.items) || schema.additionalProperties === true) {
    const tier = hintForPath(path, hints)?.advanced ?? true;
    if (tier !== advanced) {
      return { schema: null, leaves };
    }
    leaves.add(path.join("."));
    return { schema, leaves };
  }
  const properties: Record<string, JsonSchema> = {};
  let hasSchemaChildren = false;

  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    hasSchemaChildren = true;
    const projected = projectSchemaTier({
      schema: child,
      path: [...path, key],
      advanced,
      hints,
    });
    if (projected.schema) {
      properties[key] = projected.schema;
    }
    for (const leaf of projected.leaves) {
      leaves.add(leaf);
    }
  }

  let additionalProperties = schema.additionalProperties;
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    hasSchemaChildren = true;
    const projected = projectSchemaTier({
      schema: schema.additionalProperties,
      path: [...path, "*"],
      advanced,
      hints,
    });
    additionalProperties = projected.schema ?? undefined;
    for (const leaf of projected.leaves) {
      leaves.add(leaf);
    }
  }

  let items = schema.items;
  if (schema.items) {
    hasSchemaChildren = true;
    const sourceItems = [schema.items];
    const projectedItems = sourceItems
      .map((item) => projectSchemaTier({ schema: item, path: [...path, "*"], advanced, hints }))
      .filter((projection) => projection.schema !== null);
    items = projectedItems[0]?.schema ?? undefined;
    for (const projection of projectedItems) {
      for (const leaf of projection.leaves) {
        leaves.add(leaf);
      }
    }
  }

  const projectBranches = (branches: JsonSchema[] | undefined): JsonSchema[] | undefined => {
    if (!branches) {
      return undefined;
    }
    hasSchemaChildren = true;
    const projected = branches
      .map((branch) => projectSchemaTier({ schema: branch, path, advanced, hints }))
      .filter((projection) => projection.schema !== null);
    for (const projection of projected) {
      for (const leaf of projection.leaves) {
        leaves.add(leaf);
      }
    }
    return projected.length > 0
      ? projected.map((projection) => projection.schema as JsonSchema)
      : undefined;
  };

  const anyOf = projectBranches(schema.anyOf);
  const oneOf = projectBranches(schema.oneOf);
  const allOf = projectBranches(schema.allOf);

  if (!hasSchemaChildren) {
    const pathString = path.join(".");
    const tier = hintForPath(path, hints)?.advanced ?? true;
    if (tier !== advanced) {
      return { schema: null, leaves };
    }
    leaves.add(pathString);
    return { schema, leaves };
  }

  const hasProjectedChildren =
    Object.keys(properties).length > 0 ||
    (additionalProperties !== undefined && additionalProperties !== false) ||
    (Array.isArray(items) ? items.length > 0 : Boolean(items)) ||
    Boolean(anyOf?.length || oneOf?.length || allOf?.length);
  if (!hasProjectedChildren) {
    return { schema: null, leaves };
  }

  const required = schema.required?.filter((key) => Object.hasOwn(properties, key));
  return {
    schema: {
      ...schema,
      ...(schema.properties ? { properties } : {}),
      ...(schema.required ? { required } : {}),
      ...(schema.additionalProperties !== undefined ? { additionalProperties } : {}),
      ...(schema.items !== undefined ? { items } : {}),
      ...(schema.anyOf ? { anyOf } : {}),
      ...(schema.oneOf ? { oneOf } : {}),
      ...(schema.allOf ? { allOf } : {}),
    },
    leaves,
  };
}

/** Split one schema section into common and advanced projections. */
export function splitConfigSchemaByTier(params: {
  schema: JsonSchema;
  path: string[];
  hints: ConfigUiHints;
}): ConfigSchemaTierSplit {
  const common = projectSchemaTier({ ...params, advanced: false });
  const advanced = projectSchemaTier({ ...params, advanced: true });
  return {
    common: common.schema,
    advanced: advanced.schema,
    commonLeafCount: common.leaves.size,
    advancedLeafCount: advanced.leaves.size,
  };
}
