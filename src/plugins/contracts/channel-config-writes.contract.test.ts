// Verifies every bundled channel schema accepts the documented configWrites policy key.
import { describe, expect, it } from "vitest";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../../config/bundled-channel-config-metadata.generated.js";

type JsonSchemaLike = {
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
  allOf?: unknown[];
  anyOf?: unknown[];
  oneOf?: unknown[];
};

function asSchema(value: unknown): JsonSchemaLike | undefined {
  return value && typeof value === "object" ? (value as JsonSchemaLike) : undefined;
}

function schemasAtLevel(schema: JsonSchemaLike | undefined): JsonSchemaLike[] {
  if (!schema) {
    return [];
  }
  return [
    schema,
    ...[schema.allOf, schema.anyOf, schema.oneOf]
      .flatMap((variants) => variants ?? [])
      .flatMap((variant) => schemasAtLevel(asSchema(variant))),
  ];
}

/** Any closed alternative silently refuses the whole config when the documented key is missing. */
function rejectsKey(schema: JsonSchemaLike | undefined, key: string): boolean {
  return schemasAtLevel(schema).some(
    (candidate) =>
      candidate.additionalProperties === false && !Object.hasOwn(candidate.properties ?? {}, key),
  );
}

function accountSchemas(schema: JsonSchemaLike | undefined): JsonSchemaLike[] {
  return schemasAtLevel(schema).flatMap((root) => {
    const accounts = asSchema(root.properties?.accounts);
    return schemasAtLevel(accounts).flatMap((accountsVariant) =>
      schemasAtLevel(asSchema(accountsVariant.additionalProperties)),
    );
  });
}

describe("bundled channel configWrites contract", () => {
  const channels = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.map((entry) => ({
    id: entry.channelId,
    schema: asSchema(entry.schema),
  }));

  it("covers the bundled channels", () => {
    expect(channels.length).toBeGreaterThan(0);
  });

  it.each(channels.map((channel) => [channel.id, channel] as const))(
    "%s accepts channels.<id>.configWrites",
    (_id, channel) => {
      expect(rejectsKey(channel.schema, "configWrites")).toBe(false);
    },
  );

  it.each(channels.map((channel) => [channel.id, channel] as const))(
    "%s accepts channels.<id>.accounts.<account>.configWrites",
    (_id, channel) => {
      expect(
        accountSchemas(channel.schema).some((account) => rejectsKey(account, "configWrites")),
      ).toBe(false);
    },
  );
});
