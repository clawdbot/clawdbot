// Verifies channels documented as exposing health-monitor overrides accept the key.
import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";

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

function schemaFor(channelId: string): JsonSchemaLike | undefined {
  return asSchema(
    GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find((entry) => entry.channelId === channelId)
      ?.schema,
  );
}

describe("channel healthMonitor contract", () => {
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
      expect(rejectsKey(healthMonitor, "enabled")).toBe(false);
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
      expect(rejectsKey(healthMonitor, "enabled")).toBe(false);
    },
  );
});
