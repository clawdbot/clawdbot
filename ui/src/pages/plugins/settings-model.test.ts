import { describe, expect, it } from "vitest";
import { pluginAdvancedSchema, pluginConfigSchema, pluginEntryValue } from "./settings-model.ts";

const schema = {
  type: "object",
  properties: {
    plugins: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        allow: { type: "array" },
        deny: { type: "array" },
        load: { type: "object" },
        slots: { type: "object" },
        entries: {
          type: "object",
          properties: {
            workboard: {
              type: "object",
              properties: { config: { type: "object", properties: { token: { type: "string" } } } },
            },
          },
          additionalProperties: {
            type: "object",
            properties: { config: { type: "object" } },
          },
        },
      },
    },
  },
};

describe("plugin settings model", () => {
  it("projects global policy without anonymous plugin entries", () => {
    expect(Object.keys(pluginAdvancedSchema(schema)?.properties ?? {})).toEqual([
      "enabled",
      "allow",
      "deny",
      "load",
      "slots",
    ]);
  });

  it("resolves named and wildcard plugin configuration schemas", () => {
    expect(pluginConfigSchema(schema, "workboard")?.properties).toHaveProperty("token");
    expect(pluginConfigSchema(schema, "other")?.type).toBe("object");
  });

  it("never reads inherited plugin ids from schema or config", () => {
    expect(pluginConfigSchema(schema, "__proto__")?.properties).toBeUndefined();
    expect(pluginEntryValue({ plugins: { entries: {} } }, "__proto__")).toEqual({});
  });
});
