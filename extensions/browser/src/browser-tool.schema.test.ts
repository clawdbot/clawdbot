// Browser tests cover browser tool.schema plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { BrowserToolSchema } from "./browser-tool.schema.js";
import { ACT_MAX_VIEWPORT_DIMENSION } from "./browser/act-policy.js";

type SchemaRecord = Record<string, { maximum?: number; properties?: SchemaRecord }>;
type SchemaProperty = {
  description?: string;
  enum?: string[];
  maximum?: number;
  properties?: SchemaRecord;
};
type BrowserSchemaRecord = Record<string, SchemaProperty>;

function requireSchemaProperty<T>(properties: Record<string, T>, name: string, context: string): T {
  return expectDefined(properties[name], context);
}

describe("browser tool schema", () => {
  it("advertises the viewport resize maximum on nested and flattened act params", () => {
    const properties = BrowserToolSchema.properties as SchemaRecord;
    const requestProperties =
      requireSchemaProperty(properties, "request", "browser request schema").properties ?? {};

    expect(requireSchemaProperty(properties, "width", "browser width schema").maximum).toBe(
      ACT_MAX_VIEWPORT_DIMENSION,
    );
    expect(requireSchemaProperty(properties, "height", "browser height schema").maximum).toBe(
      ACT_MAX_VIEWPORT_DIMENSION,
    );
    expect(
      requireSchemaProperty(requestProperties, "width", "browser request width schema").maximum,
    ).toBe(ACT_MAX_VIEWPORT_DIMENSION);
    expect(
      requireSchemaProperty(requestProperties, "height", "browser request height schema").maximum,
    ).toBe(ACT_MAX_VIEWPORT_DIMENSION);
  });

  it("describes targetId as a compatible tab reference", () => {
    const properties = BrowserToolSchema.properties as BrowserSchemaRecord;
    const targetId = requireSchemaProperty(properties, "targetId", "browser targetId schema");
    const requestProperties = requireSchemaProperty(properties, "request", "browser request schema")
      .properties as BrowserSchemaRecord;
    const requestTargetId = requireSchemaProperty(
      requestProperties,
      "targetId",
      "browser request targetId schema",
    );

    expect(targetId.description).toContain("Prefer suggestedTargetId");
    expect(targetId.description).toContain("raw CDP targetId");
    expect(requestTargetId.description).toBe(targetId.description);
  });

  it("exposes explicit download actions and their output path", () => {
    const properties = BrowserToolSchema.properties as BrowserSchemaRecord;

    expect(requireSchemaProperty(properties, "action", "browser action schema").enum).toEqual(
      expect.arrayContaining(["download", "waitfordownload"]),
    );
    expect(properties.path).toBeDefined();
  });

  it("exposes scrollIntoView on nested and flattened act params", () => {
    const properties = BrowserToolSchema.properties as BrowserSchemaRecord;
    const requestProperties = requireSchemaProperty(properties, "request", "browser request schema")
      .properties as BrowserSchemaRecord;

    expect(requireSchemaProperty(properties, "kind", "browser action kind schema").enum).toContain(
      "scrollIntoView",
    );
    expect(
      requireSchemaProperty(requestProperties, "kind", "browser request kind schema").enum,
    ).toContain("scrollIntoView");
  });

  it("exposes batch actions on nested and flattened act params", () => {
    const properties = BrowserToolSchema.properties as BrowserSchemaRecord;
    const requestProperties = requireSchemaProperty(properties, "request", "browser request schema")
      .properties as BrowserSchemaRecord;

    expect(requireSchemaProperty(properties, "kind", "browser action kind schema").enum).toContain(
      "batch",
    );
    expect(properties.actions).toBeDefined();
    expect(
      requireSchemaProperty(requestProperties, "kind", "browser request kind schema").enum,
    ).toContain("batch");
    expect(requestProperties.actions).toBeDefined();
  });
});
