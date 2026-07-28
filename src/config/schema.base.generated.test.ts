// Verifies generated base config schema snapshots and sensitive redaction.
import { SENSITIVE_URL_HINT_TAG } from "@openclaw/net-policy/redact-sensitive-url";
import { describe, expect, it } from "vitest";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";

type TestJsonSchema = {
  additionalProperties?: TestJsonSchema | boolean;
  allOf?: TestJsonSchema[];
  anyOf?: TestJsonSchema[];
  const?: unknown;
  enum?: unknown[];
  items?: TestJsonSchema | TestJsonSchema[];
  oneOf?: TestJsonSchema[];
  properties?: Record<string, TestJsonSchema>;
  type?: unknown;
};

const BASE_CONFIG_SCHEMA = computeBaseConfigSchemaResponse({
  generatedAt: "2026-05-05T00:00:00.000Z",
});
const BASE_SCHEMA = BASE_CONFIG_SCHEMA.schema as TestJsonSchema;

const METADATA_KEYS = new Set(["default", "description", "nullable", "tags", "title", "x-tags"]);

function schemaAt(schema: TestJsonSchema, path: string[]): TestJsonSchema | undefined {
  let node: TestJsonSchema | undefined = schema;
  for (const segment of path) {
    if (!node) {
      return undefined;
    }
    if (segment === "[]") {
      node = Array.isArray(node.items) ? node.items[0] : node.items;
    } else if (segment === "*") {
      node = typeof node.additionalProperties === "object" ? node.additionalProperties : undefined;
    } else {
      node = node.properties?.[segment];
    }
  }
  return node;
}

function sortedAnyOfTypes(node: TestJsonSchema | undefined): string[] {
  return (node?.anyOf ?? [])
    .map((branch) => String(branch.type))
    .toSorted((left, right) => left.localeCompare(right));
}

function itemSchema(node: TestJsonSchema | undefined): TestJsonSchema | undefined {
  return Array.isArray(node?.items) ? node.items[0] : node?.items;
}

function expectAnyOfTypes(path: string[], expectedTypes: string[]): TestJsonSchema[] {
  const node = schemaAt(BASE_SCHEMA, path);
  expect(node, path.join(".")).toBeDefined();
  expect(sortedAnyOfTypes(node), path.join(".")).toEqual(expectedTypes);
  return node?.anyOf ?? [];
}

function hasOnlyMetadataKeys(schema: TestJsonSchema): boolean {
  return Object.keys(schema).every((key) => METADATA_KEYS.has(key));
}

function collectMetadataOnlyCompositionBranches(
  schema: TestJsonSchema,
  path: string[] = [],
  hits: string[] = [],
): string[] {
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    for (const [index, branch] of (schema[keyword] ?? []).entries()) {
      const branchPath = `${path.join(".") || "<root>"}.${keyword}[${index}]`;
      if (hasOnlyMetadataKeys(branch)) {
        hits.push(branchPath);
      }
      collectMetadataOnlyCompositionBranches(branch, [branchPath], hits);
    }
  }

  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    collectMetadataOnlyCompositionBranches(child, [...path, key], hits);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    collectMetadataOnlyCompositionBranches(schema.additionalProperties, [...path, "*"], hits);
  }
  const items = Array.isArray(schema.items) ? schema.items : schema.items ? [schema.items] : [];
  for (const [index, child] of items.entries()) {
    collectMetadataOnlyCompositionBranches(child, [...path, `items[${index}]`], hits);
  }

  return hits;
}

describe("base config schema", () => {
  it("is deterministic for a fixed generatedAt timestamp", () => {
    expect(
      computeBaseConfigSchemaResponse({
        generatedAt: BASE_CONFIG_SCHEMA.generatedAt,
      }),
    ).toEqual(BASE_CONFIG_SCHEMA);
  });

  it("includes explicit URL-secret tags for sensitive URL fields", () => {
    expect(BASE_CONFIG_SCHEMA.uiHints["mcp.servers.*.url"]?.tags).toContain(SENSITIVE_URL_HINT_TAG);
    expect(BASE_CONFIG_SCHEMA.uiHints["models.providers.*.baseUrl"]?.tags).toContain(
      SENSITIVE_URL_HINT_TAG,
    );
  });

  it("omits legacy compatibility paths from the public schema payload", () => {
    const rootProperties = (
      BASE_CONFIG_SCHEMA.schema as {
        properties?: Record<string, unknown>;
      }
    ).properties;
    const hooksInternalProperties = (
      BASE_CONFIG_SCHEMA.schema as {
        properties?: {
          hooks?: {
            properties?: {
              internal?: {
                properties?: Record<string, unknown>;
              };
            };
          };
        };
      }
    ).properties?.hooks?.properties?.internal?.properties;
    const uiHints = BASE_CONFIG_SCHEMA.uiHints as Record<string, unknown>;

    expect(rootProperties?.canvasHost).toBeUndefined();
    expect(hooksInternalProperties?.handlers).toBeUndefined();
    expect(uiHints.canvasHost).toBeUndefined();
    expect(uiHints["hooks.internal.handlers"]).toBeUndefined();
  });

  it("includes generation and voice models in the public schema payload", () => {
    const agentDefaultsProperties = (
      BASE_CONFIG_SCHEMA.schema as {
        properties?: {
          agents?: {
            properties?: {
              defaults?: {
                properties?: Record<string, unknown>;
              };
            };
          };
        };
      }
    ).properties?.agents?.properties?.defaults?.properties;
    const uiHints = BASE_CONFIG_SCHEMA.uiHints as Record<string, unknown>;

    expect(agentDefaultsProperties).toHaveProperty("mediaModels");
    expect(agentDefaultsProperties).toHaveProperty("voiceModel");
    expect(uiHints).toHaveProperty("agents.defaults.mediaModels.video.primary");
    expect(uiHints).toHaveProperty("agents.defaults.mediaModels.video.fallbacks");
    expect(uiHints).toHaveProperty("agents.defaults.voiceModel.primary");
    expect(uiHints).toHaveProperty("agents.defaults.voiceModel.fallbacks");
  });

  it("publishes accepted input shapes for transform-backed config fields", () => {
    for (const path of [
      ["agents", "defaults", "sandbox", "docker", "setupCommand"],
      ["agents", "entries", "*", "sandbox", "docker", "setupCommand"],
    ]) {
      const branches = expectAnyOfTypes(path, ["array", "string"]);
      expect(itemSchema(branches.find((branch) => branch.type === "array"))?.type).toBe("string");
    }

    const codexAllowedDomains = schemaAt(BASE_SCHEMA, [
      "tools",
      "web",
      "search",
      "openaiCodex",
      "allowedDomains",
    ]);
    expect(codexAllowedDomains?.type).toBe("array");
    expect(itemSchema(codexAllowedDomains)?.type).toBe("string");

    const codexUserLocation = schemaAt(BASE_SCHEMA, [
      "tools",
      "web",
      "search",
      "openaiCodex",
      "userLocation",
    ]);
    expect(codexUserLocation?.type).toBe("object");
    expect(codexUserLocation?.properties?.country?.type).toBe("string");
    expect(codexUserLocation?.properties?.region?.type).toBe("string");
    expect(codexUserLocation?.properties?.city?.type).toBe("string");
    expect(codexUserLocation?.properties?.timezone?.type).toBe("string");
  });

  it("does not publish metadata-only composition branches", () => {
    expect(collectMetadataOnlyCompositionBranches(BASE_SCHEMA)).toEqual([]);
  });
});
