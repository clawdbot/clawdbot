// Verifies channels documented as exposing health-monitor overrides accept the key.
import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";
import { validateJsonSchemaValue } from "../schema-validator.js";

/**
 * The channels docs/gateway/health.md lists as exposing the per-channel
 * health-monitor override. The gateway supervisor reads the key for every
 * started account, so rejecting it refuses the whole config.
 */
const HEALTH_MONITOR_CHANNELS = [
  "discord",
  "googlechat",
  "imessage",
  "irc",
  "msteams",
  "signal",
  "slack",
  "telegram",
  "whatsapp",
] as const;

type JsonSchemaLike = {
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
  anyOf?: unknown[];
  oneOf?: unknown[];
  allOf?: unknown[];
};

function asSchema(value: unknown): JsonSchemaLike | undefined {
  return value && typeof value === "object" ? (value as JsonSchemaLike) : undefined;
}

/**
 * A closed schema without the key is what makes config loading fail. Some
 * channels (twitch) publish composed alternatives instead of one flat object,
 * so a config is refused only when every alternative refuses the key.
 */
function rejectsKey(schema: JsonSchemaLike | undefined, key: string): boolean {
  if (!schema) {
    return false;
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    return alternatives.every((branch) => rejectsKey(asSchema(branch), key));
  }
  // allOf is an intersection: the value must satisfy every component, so one
  // closed component that omits the key still refuses it at config load.
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.some((branch) => rejectsKey(asSchema(branch), key));
  }
  if (schema.additionalProperties !== false) {
    return false;
  }
  return !Object.hasOwn(schema.properties ?? {}, key);
}

/**
 * Resolves a property's sub-schema across composed alternatives. The parent key
 * existing is not the documented contract; `healthMonitor.enabled` is, and a
 * strict empty object would satisfy the parent check while refusing that leaf.
 */
function propertySchema(
  schema: JsonSchemaLike | undefined,
  key: string,
): JsonSchemaLike | undefined {
  if (!schema) {
    return undefined;
  }
  const direct = asSchema(schema.properties?.[key]);
  if (direct) {
    return direct;
  }
  for (const branch of [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ]) {
    const nested = propertySchema(asSchema(branch), key);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

/**
 * Whether the intersection refuses `parentKey.childKey`. Mirrors rejectsKey so
 * every allOf component is evaluated: taking the first component that happens to
 * declare the parent would discard a later closed sibling that refuses the leaf,
 * and the assertion would pass while real config loading fails.
 */
function rejectsNestedKey(
  schema: JsonSchemaLike | undefined,
  parentKey: string,
  childKey: string,
): boolean {
  if (!schema) {
    return false;
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives) && alternatives.length > 0) {
    return alternatives.every((branch) => rejectsNestedKey(asSchema(branch), parentKey, childKey));
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.some((branch) => rejectsNestedKey(asSchema(branch), parentKey, childKey));
  }
  const parent = asSchema(schema.properties?.[parentKey]);
  if (!parent) {
    // A closed component that omits the parent entirely refuses the leaf too, so
    // treating that as "not rejecting" would leave the contract green while real
    // config loading fails on the parent property.
    return schema.additionalProperties === false;
  }
  return rejectsKey(parent, childKey);
}

/**
 * Validates the documented `{ healthMonitor: { enabled: false } }` override
 * against the generated schema. Presence checks alone would pass on a leaf typed
 * as something other than boolean, which real config loading would refuse.
 */
function acceptsDocumentedOverride(schema: JsonSchemaLike | undefined, cacheKey: string): boolean {
  // Validate the healthMonitor sub-schema rather than the channel object: a
  // channel schema has its own required credentials, so a partial object would
  // fail for reasons unrelated to this leaf.
  const healthMonitor = propertySchema(schema, "healthMonitor");
  if (!healthMonitor) {
    return false;
  }
  return validateJsonSchemaValue({
    cacheKey: `health-monitor-contract.${cacheKey}`,
    schema: healthMonitor as Parameters<typeof validateJsonSchemaValue>[0]["schema"],
    value: { enabled: false },
    cache: false,
  }).ok;
}

function schemaFor(channelId: string): JsonSchemaLike | undefined {
  return asSchema(
    GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find((entry) => entry.channelId === channelId)
      ?.schema,
  );
}

describe("channel healthMonitor contract", () => {
  it("treats a closed allOf sibling as refusing the healthMonitor leaf", () => {
    // The shape that used to slip through: one component declares the leaf while a
    // closed sibling omits it, so config loading refuses `healthMonitor.enabled`
    // even though a first-match lookup finds an accepting schema.
    const composed: JsonSchemaLike = {
      allOf: [
        {
          properties: {
            healthMonitor: { properties: { enabled: {} }, additionalProperties: false },
          },
          additionalProperties: false,
        },
        {
          properties: { healthMonitor: { properties: {}, additionalProperties: false } },
          additionalProperties: false,
        },
      ],
    };

    expect(propertySchema(composed, "healthMonitor")).toBeDefined();
    expect(rejectsNestedKey(composed, "healthMonitor", "enabled")).toBe(true);
  });

  it("treats a closed sibling that omits the parent as refusing the leaf", () => {
    // The remaining hole: the sibling does not declare `healthMonitor` at all.
    // Real validation refuses the parent property, so reporting "not rejected"
    // here would keep the contract green on a schema that cannot load.
    const composed: JsonSchemaLike = {
      allOf: [
        {
          properties: {
            healthMonitor: { properties: { enabled: {} }, additionalProperties: false },
          },
          additionalProperties: false,
        },
        { properties: { other: {} }, additionalProperties: false },
      ],
    };

    expect(rejectsNestedKey(composed, "healthMonitor", "enabled")).toBe(true);
    // An open sibling that omits the parent adds no restriction.
    const permissive: JsonSchemaLike = {
      allOf: [
        {
          properties: {
            healthMonitor: { properties: { enabled: {} }, additionalProperties: false },
          },
          additionalProperties: false,
        },
        { properties: { other: {} } },
      ],
    };
    expect(rejectsNestedKey(permissive, "healthMonitor", "enabled")).toBe(false);
  });

  it.each(HEALTH_MONITOR_CHANNELS)("%s accepts channels.<id>.healthMonitor", (channelId) => {
    expect(rejectsKey(schemaFor(channelId), "healthMonitor")).toBe(false);
  });

  it.each(HEALTH_MONITOR_CHANNELS)(
    "%s accepts channels.<id>.accounts.<account>.healthMonitor",
    (channelId) => {
      const accounts = asSchema(schemaFor(channelId)?.properties?.accounts);
      expect(rejectsKey(asSchema(accounts?.additionalProperties), "healthMonitor")).toBe(false);
    },
  );

  it.each(HEALTH_MONITOR_CHANNELS)(
    "%s accepts the documented channels.<id>.healthMonitor.enabled leaf",
    (channelId) => {
      const healthMonitor = propertySchema(schemaFor(channelId), "healthMonitor");
      expect(healthMonitor, `${channelId} exposes no healthMonitor schema`).toBeDefined();
      expect(rejectsNestedKey(schemaFor(channelId), "healthMonitor", "enabled")).toBe(false);
      // Structural presence is not the contract: a leaf typed as string would
      // satisfy the checks above while refusing the documented boolean.
      expect(acceptsDocumentedOverride(schemaFor(channelId), `${channelId}.root`)).toBe(true);
    },
  );

  it.each(HEALTH_MONITOR_CHANNELS)(
    "%s accepts the documented accounts.<account>.healthMonitor.enabled leaf",
    (channelId) => {
      const accounts = asSchema(schemaFor(channelId)?.properties?.accounts);
      const accountEntry = asSchema(accounts?.additionalProperties);
      if (!accountEntry) {
        // Single-account channels publish no accounts envelope; the channel-scope
        // assertion above already covers the documented override for them.
        return;
      }
      const healthMonitor = propertySchema(accountEntry, "healthMonitor");
      expect(healthMonitor, `${channelId} account entry exposes no healthMonitor`).toBeDefined();
      expect(rejectsNestedKey(accountEntry, "healthMonitor", "enabled")).toBe(false);
      expect(acceptsDocumentedOverride(accountEntry, `${channelId}.account`)).toBe(true);
    },
  );
});
