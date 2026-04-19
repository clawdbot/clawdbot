import { isSensitiveUrlConfigPath } from "../shared/net/redact-sensitive-url.js";
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
import { asSchemaObject, cloneSchema } from "./schema.shared.js";
import { applyDerivedTags } from "./schema.tags.js";
import { OpenClawSchema } from "./zod-schema.js";

type ConfigSchema = Record<string, unknown>;

type FieldDocumentation = {
  titles: Record<string, string>;
  descriptions: Record<string, string>;
};

type JsonSchemaObject = Record<string, unknown> & {
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: JsonSchemaObject | boolean;
  items?: JsonSchemaObject | JsonSchemaObject[];
  anyOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
  allOf?: JsonSchemaObject[];
};

const LEGACY_HIDDEN_PUBLIC_PATHS = ["hooks.internal.handlers"] as const;

const asJsonSchemaObject = (value: unknown): JsonSchemaObject | null =>
  asSchemaObject(value) as JsonSchemaObject | null;

function buildFieldDocumentation(): FieldDocumentation {
  const titles: Record<string, string> = {};
  for (const [key, value] of Object.entries(FIELD_LABELS)) {
    if (value) {
      titles[key] = value;
    }
  }

  const descriptions: Record<string, string> = {};
  for (const [key, value] of Object.entries(FIELD_HELP)) {
    if (value) {
      descriptions[key] = value;
    }
  }

  return { titles, descriptions };
}

/**
 * Recursively walk a JSON Schema object and apply field docs using dot-path
 * matching. Existing titles/descriptions (for example from Zod metadata) are
 * preserved.
 */
function applyFieldDocumentation(
  node: JsonSchemaObject,
  documentation: FieldDocumentation,
  prefixes: readonly string[] = [""],
): void {
  const props = node.properties;
  if (props) {
    for (const [key, child] of Object.entries(props)) {
      const childObj = asJsonSchemaObject(child);
      if (!childObj) {
        continue;
      }
      const childPrefixes = prefixes.map((prefix) => (prefix ? `${prefix}.${key}` : key));
      applyNodeDocumentation(childObj, documentation, childPrefixes);
      applyFieldDocumentation(childObj, documentation, childPrefixes);
    }
  }
  // Handle additionalProperties (wildcard keys like "models.providers.*")
  if (node.additionalProperties && typeof node.additionalProperties === "object") {
    const addObj = asJsonSchemaObject(node.additionalProperties);
    if (addObj) {
      const wildcardPrefixes = prefixes.map((prefix) => (prefix ? `${prefix}.*` : "*"));
      applyNodeDocumentation(addObj, documentation, wildcardPrefixes);
      applyFieldDocumentation(addObj, documentation, wildcardPrefixes);
    }
  }
  // Handle array items. Help/labels may use either "[]" notation
  // (bindings[].type) or wildcard "*" notation (agents.list.*.skills).
  if (node.items) {
    const itemsObj = asJsonSchemaObject(node.items);
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
      applyNodeDocumentation(itemsObj, documentation, itemPrefixes);
      applyFieldDocumentation(itemsObj, documentation, itemPrefixes);
    }
  }
  // Recurse into composition branches (anyOf, oneOf, allOf) using the same
  // path aliases so union/intersection variants inherit the same field docs.
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = node[keyword];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        const branchObj = asJsonSchemaObject(branch);
        if (branchObj) {
          applyFieldDocumentation(branchObj, documentation, prefixes);
        }
      }
    }
  }
}

function applyNodeDocumentation(
  node: JsonSchemaObject,
  documentation: FieldDocumentation,
  pathCandidates: readonly string[],
): void {
  if (!node.title) {
    for (const path of pathCandidates) {
      const title = documentation.titles[path];
      if (title) {
        node.title = title;
        break;
      }
    }
  }

  if (!node.description) {
    for (const path of pathCandidates) {
      const description = documentation.descriptions[path];
      if (description) {
        node.description = description;
        break;
      }
    }
  }
}

export type BaseConfigSchemaResponse = {
  schema: ConfigSchema;
  uiHints: ConfigUiHints;
  version: string;
  generatedAt: string;
};

type BaseConfigSchemaStablePayload = Omit<BaseConfigSchemaResponse, "generatedAt">;

function stripChannelSchema(schema: ConfigSchema): ConfigSchema {
  const next = cloneSchema(schema);
  const root = asJsonSchemaObject(next);
  if (!root || !root.properties) {
    return next;
  }
  // Allow `$schema` in config files for editor tooling, but hide it from the
  // Control UI form schema so it does not show up as a configurable section.
  delete root.properties.$schema;
  if (Array.isArray(root.required)) {
    root.required = root.required.filter((key) => key !== "$schema");
  }
  const channelsNode = asJsonSchemaObject(root.properties.channels);
  if (channelsNode) {
    channelsNode.properties = {};
    channelsNode.required = [];
    channelsNode.additionalProperties = true;
  }
  return next;
}

function stripObjectPropertyPath(schema: ConfigSchema, path: readonly string[]): void {
  const root = asJsonSchemaObject(schema);
  if (!root || path.length === 0) {
    return;
  }

  let current: JsonSchemaObject | null = root;
  for (const segment of path.slice(0, -1)) {
    current = asJsonSchemaObject(current?.properties?.[segment]);
    if (!current) {
      return;
    }
  }

  const key = path[path.length - 1];
  if (!current?.properties || !key) {
    return;
  }
  delete current.properties[key];
  if (Array.isArray(current.required)) {
    current.required = current.required.filter((entry) => entry !== key);
  }
}

function stripLegacyCompatSchemaPaths(schema: ConfigSchema): ConfigSchema {
  const next = cloneSchema(schema);
  for (const path of LEGACY_HIDDEN_PUBLIC_PATHS) {
    stripObjectPropertyPath(next, path.split("."));
  }
  return next;
}

function stripLegacyCompatHints(hints: ConfigUiHints): ConfigUiHints {
  const next: ConfigUiHints = { ...hints };
  for (const path of LEGACY_HIDDEN_PUBLIC_PATHS) {
    for (const key of Object.keys(next)) {
      if (key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}[`)) {
        delete next[key];
      }
    }
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
    target: "draft-07",
    unrepresentable: "any",
  });
  schema.title = "OpenClawConfig";
  const schemaRoot = asJsonSchemaObject(schema);
  if (schemaRoot) {
    applyFieldDocumentation(schemaRoot, buildFieldDocumentation());
  }
  const baseHints = mapSensitivePaths(OpenClawSchema, "", buildBaseHints());
  const sensitiveUrlPaths = collectMatchingSchemaPaths(
    OpenClawSchema,
    "",
    isSensitiveUrlConfigPath,
  );
  const stablePayload = {
    schema: stripLegacyCompatSchemaPaths(stripChannelSchema(schema)),
    uiHints: stripLegacyCompatHints(
      applyDerivedTags(applySensitiveUrlHints(baseHints, sensitiveUrlPaths)),
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
