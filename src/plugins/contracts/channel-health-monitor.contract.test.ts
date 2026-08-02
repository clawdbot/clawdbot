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
});
