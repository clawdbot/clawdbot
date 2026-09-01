// Builds base config schema metadata shared across generated config surfaces.
import { isSensitiveUrlConfigPath } from "@openclaw/net-policy/redact-sensitive-url";
import { VERSION } from "../version.js";
import { FIELD_HELP } from "./schema.help.js";
import type { ConfigUiHints } from "./schema.hints.js";
import {
  applySensitiveUrlHints,
  buildBaseHints,
  collectMatchingSchemaPaths,
  mapSensitivePaths,
} from "./schema.hints.js";
import { FIELD_LABELS } from "./schema.labels.js";
import {
  asSchemaObject,
  cloneSchema,
  type ConfigJsonSchemaObject as JsonSchemaObject,
} from "./schema.shared.js";
import { applyDerivedTags } from "./schema.tags.js";
import { applyResolvedConfigTierHints } from "./schema.tiers.js";
import { OpenClawSchema } from "./zod-schema.js";

type ConfigSchema = Record<string, unknown>;

/**
 * Recursively walk a JSON Schema object and apply field docs using dot-path
 * matching. Existing titles/descriptions (for example from Zod metadata) are
 * preserved.
 */
function applyFieldDocumentation(node: JsonSchemaObject, prefixes: readonly string[] = [""]): void {
  const props = node.properties;
  if (props) {
    for (const [key, child] of Object.entries(props)) {
      const childObj = asSchemaObject(child);
      if (!childObj) {
        continue;
      }
      const childPrefixes = prefixes.map((prefix) => (prefix ? `${prefix}.${key}` : key));
      applyNodeDocumentation(childObj, childPrefixes);
      applyFieldDocumentation(childObj, childPrefixes);
    }
  }
  // Handle additionalProperties (wildcard keys like "models.providers.*")
  if (node.additionalProperties && typeof node.additionalProperties === "object") {
    const addObj = asSchemaObject(node.additionalProperties);
    if (addObj) {
      const wildcardPrefixes = prefixes.map((prefix) => (prefix ? `${prefix}.*` : "*"));
      applyNodeDocumentation(addObj, wildcardPrefixes);
      applyFieldDocumentation(addObj, wildcardPrefixes);
    }
  }
  // Handle array items. Help/labels may use either "[]" notation
  // (bindings[].type) or wildcard "*" notation (agents.list.*.skills).
  if (node.items) {
    const itemsObj = asSchemaObject(node.items);
    if (itemsObj) {
      const itemPrefixes = Array.from(
        new Set(
          prefixes.flatMap((prefix) => {
            const arrayPath = prefix ? `${prefix}[]` : "[]";
            const wildcardAlias = prefix ? `${prefix}.*` : "*";
            return wildcardAlias === arrayPath ? [arrayPath] : [wildcardAlias, arrayPath];
          }),
        ),
      );
      applyNodeDocumentation(itemsObj, itemPrefixes);
      applyFieldDocumentation(itemsObj, itemPrefixes);
    }
  }
  // Recurse into composition branches (anyOf, oneOf, allOf) using the same
  // path aliases so union/intersection variants inherit the same field docs.
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = node[keyword];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        const branchObj = asSchemaObject(branch);
        if (branchObj) {
          applyFieldDocumentation(branchObj, prefixes);
        }
      }
    }
  }
}

function applyNodeDocumentation(node: JsonSchemaObject, pathCandidates: readonly string[]): void {
  for (const path of pathCandidates) {
    const title = FIELD_LABELS[path];
    if (!node.title && title) {
      node.title = title;
    }
    const description = FIELD_HELP[path];
    if (!node.description && description) {
      node.description = description;
    }
  }
}

type BaseConfigSchemaResponse = {
  schema: ConfigSchema;
  uiHints: ConfigUiHints;
  version: string;
  generatedAt: string;
};

type BaseConfigSchemaStablePayload = Omit<BaseConfigSchemaResponse, "generatedAt">;

function preparePublicSchema(schema: ConfigSchema): ConfigSchema {
  const next = cloneSchema(schema);
  const root = asSchemaObject(next);
  if (!root || !root.properties) {
    return next;
  }
  // Allow `$schema` in config files for editor tooling, but hide it from the
  // Control UI form schema so it does not show up as a configurable section.
  delete root.properties.$schema;
  if (Array.isArray(root.required)) {
    root.required = root.required.filter((key) => key !== "$schema");
  }
  const channelsNode = asSchemaObject(root.properties.channels);
  if (channelsNode) {
    // Keep plugin config permissive without advertising an untyped lookup wildcard.
    channelsNode.additionalProperties = true;
  }
  return next;
}

let baseConfigSchemaStablePayload: BaseConfigSchemaStablePayload | null = null;

function computeBaseConfigSchemaStablePayload(): BaseConfigSchemaStablePayload {
  if (baseConfigSchemaStablePayload) {
    return {
      schema: cloneSchema(baseConfigSchemaStablePayload.schema),
      uiHints: cloneSchema(baseConfigSchemaStablePayload.uiHints),
      version: baseConfigSchemaStablePayload.version,
    };
  }
  const schema = OpenClawSchema.toJSONSchema({
    io: "input",
    target: "draft-07",
    unrepresentable: "any",
  });
  schema.title = "OpenClawConfig";
  const schemaRoot = asSchemaObject(schema);
  if (schemaRoot) {
    applyFieldDocumentation(schemaRoot);
  }
  const baseHints = mapSensitivePaths(OpenClawSchema, "", buildBaseHints());
  const sensitiveUrlPaths = collectMatchingSchemaPaths(
    OpenClawSchema,
    "",
    isSensitiveUrlConfigPath,
  );
  const publicSchema = preparePublicSchema(schema);
  const stablePayload = {
    schema: publicSchema,
    uiHints: applyDerivedTags(
      applyResolvedConfigTierHints(
        publicSchema,
        applyDerivedTags(applySensitiveUrlHints(baseHints, sensitiveUrlPaths)),
      ),
    ),
    version: VERSION,
  } satisfies BaseConfigSchemaStablePayload;
  baseConfigSchemaStablePayload = stablePayload;
  return {
    schema: cloneSchema(stablePayload.schema),
    uiHints: cloneSchema(stablePayload.uiHints),
    version: stablePayload.version,
  };
}

export function computeBaseConfigSchemaResponse(params?: {
  generatedAt?: string;
}): BaseConfigSchemaResponse {
  const stablePayload = computeBaseConfigSchemaStablePayload();
  return {
    schema: stablePayload.schema,
    uiHints: stablePayload.uiHints,
    version: stablePayload.version,
    generatedAt: params?.generatedAt ?? new Date().toISOString(),
  };
}
