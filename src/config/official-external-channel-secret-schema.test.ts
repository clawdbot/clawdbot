import { describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { collectChannelSchemaMetadataWithOwnership } from "./channel-config-metadata.js";
import { widenOfficialExternalChannelSecretSchema } from "./official-external-channel-secret-schema.js";

describe("official external channel secret schema", () => {
  it("widens Tencent QQBot root and account clientSecret fields to SecretRefs", () => {
    const schema = widenOfficialExternalChannelSecretSchema({
      channelId: "qqbot",
      schema: {
        type: "object",
        properties: {
          clientSecret: { type: "string" },
          accounts: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: { clientSecret: { type: "string" } },
            },
          },
        },
      },
    });

    const root = schema?.properties as Record<string, Record<string, unknown>> | undefined;
    if (!root?.clientSecret || !root.accounts) {
      throw new Error("expected root QQBot secret schema properties");
    }
    expect(root.clientSecret.anyOf).toHaveLength(2);
    const accounts = root.accounts.additionalProperties as
      | {
          properties?: Record<string, { anyOf?: unknown[] }>;
        }
      | undefined;
    if (!accounts?.properties?.clientSecret) {
      throw new Error("expected account QQBot secret schema properties");
    }
    expect(accounts.properties.clientSecret.anyOf).toHaveLength(2);
  });

  it("does not widen channels without a catalog secret contract", () => {
    const schema = { type: "object", properties: { token: { type: "string" } } };

    expect(widenOfficialExternalChannelSecretSchema({ channelId: "unknown", schema })).toBe(schema);
  });

  it("widens the installed Tencent manifest schema selected for channel validation", () => {
    const registry = {
      plugins: [
        {
          id: "openclaw-qqbot",
          origin: "global",
          channels: ["qqbot"],
          channelConfigs: {
            qqbot: {
              schema: {
                type: "object",
                additionalProperties: true,
                properties: { clientSecret: { type: "string" } },
              },
            },
          },
        },
      ],
    } as unknown as PluginManifestRegistry;

    const [metadata] = collectChannelSchemaMetadataWithOwnership(registry);
    const properties = metadata?.configSchema?.properties as
      | Record<string, { anyOf?: unknown[] }>
      | undefined;
    if (!properties?.clientSecret) {
      throw new Error("expected installed QQBot secret schema properties");
    }
    expect(properties.clientSecret.anyOf).toHaveLength(2);
    expect(metadata?.configSchema?.allOf).toHaveLength(1);
  });

  it("fails closed on QQBot configs that have not run the Tencent 2.0 migration", () => {
    const schema = widenOfficialExternalChannelSecretSchema({
      channelId: "qqbot",
      schema: { type: "object", additionalProperties: true },
    });
    if (!schema) {
      throw new Error("expected QQBot host schema");
    }
    const validate = (value: unknown) =>
      validateJsonSchemaValue({
        cacheKey: `qqbot-host-schema-${JSON.stringify(value)}`,
        schema,
        value,
      }).ok;

    expect(validate({})).toBe(false);
    expect(validate({ allowFrom: ["*"] })).toBe(false);
    expect(validate({ allowFrom: ["user123"] })).toBe(false);
    expect(validate({ defaultAccount: "ops", allowFrom: ["OWNER"] })).toBe(false);
    expect(
      validate({
        allowFrom: ["openclaw:approval-disabled"],
        accounts: { default: { allowFrom: ["OWNER"] } },
      }),
    ).toBe(false);
    expect(
      validate({
        allowFrom: ["openclaw:approval-disabled"],
        accounts: { ops: { allowFrom: ["OWNER"] } },
      }),
    ).toBe(true);
  });
});
