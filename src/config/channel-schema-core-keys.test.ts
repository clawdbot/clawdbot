import { describe, expect, it } from "vitest";
import { resolveChannelSchemaWithCoreOwnedKeys } from "./channel-schema-core-keys.js";

/** Mirrors a published plugin manifest: closed schema, only plugin-known keys. */
function buildClosedPluginSchema(properties: Record<string, unknown>) {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties,
    additionalProperties: false,
  } as Record<string, unknown>;
}

describe("resolveChannelSchemaWithCoreOwnedKeys", () => {
  it("permits a core-written key a closed plugin schema never declared", () => {
    const widened = resolveChannelSchemaWithCoreOwnedKeys(
      buildClosedPluginSchema({ cliPath: { type: "string" } }),
    );
    // The regression that took the gateway down: core's doctor migration writes
    // this key into channels.<id>, but the published plugin manifest predates it.
    expect(widened.properties).toHaveProperty("heartbeatVisibility");
  });

  it("leaves common keys core does not write rejectable, preserving intentional omissions", () => {
    const widened = resolveChannelSchemaWithCoreOwnedKeys(
      buildClosedPluginSchema({ cliPath: { type: "string" } }),
    );
    const properties = widened.properties as Record<string, unknown>;
    // A channel that omits these is saying it does not support them; accepting
    // them here would silently swallow config that can never take effect.
    expect(properties).not.toHaveProperty("streaming");
    expect(properties).not.toHaveProperty("markdown");
    expect(properties).not.toHaveProperty("replyToMode");
  });

  it("keeps a plugin-declared schema authoritative instead of widening it", () => {
    const pluginOwned = { type: "object", properties: { showOk: { type: "boolean" } } };
    const widened = resolveChannelSchemaWithCoreOwnedKeys(
      buildClosedPluginSchema({ heartbeatVisibility: pluginOwned }),
    );
    expect((widened.properties as Record<string, unknown>).heartbeatVisibility).toBe(pluginOwned);
  });

  it("still rejects unknown keys", () => {
    const widened = resolveChannelSchemaWithCoreOwnedKeys(
      buildClosedPluginSchema({ cliPath: { type: "string" } }),
    );
    expect(widened.additionalProperties).toBe(false);
    expect(widened.properties).not.toHaveProperty("totallyMadeUpKey");
  });

  it("widens per-account entries, which core migrates into the same way", () => {
    const widened = resolveChannelSchemaWithCoreOwnedKeys(
      buildClosedPluginSchema({
        accounts: {
          type: "object",
          additionalProperties: buildClosedPluginSchema({ cliPath: { type: "string" } }),
        },
      }),
    );
    const accounts = (widened.properties as Record<string, unknown>).accounts as Record<
      string,
      unknown
    >;
    const accountEntry = accounts.additionalProperties as Record<string, unknown>;
    expect(accountEntry.properties).toHaveProperty("heartbeatVisibility");
  });

  it("widens a closed schema that omits properties entirely, which rejects every key", () => {
    const widened = resolveChannelSchemaWithCoreOwnedKeys({
      type: "object",
      additionalProperties: false,
    });
    expect(widened.properties).toHaveProperty("heartbeatVisibility");
  });

  it("returns open schemas untouched, since they reject nothing", () => {
    const open = { type: "object", properties: { cliPath: { type: "string" } } };
    expect(resolveChannelSchemaWithCoreOwnedKeys(open)).toBe(open);
  });

  it("returns already-complete schemas by identity so schema caching holds", () => {
    const complete = buildClosedPluginSchema({ heartbeatVisibility: {} });
    expect(resolveChannelSchemaWithCoreOwnedKeys(complete)).toBe(complete);
  });
});
