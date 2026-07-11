// Browser tests cover browser tool.schema plugin behavior.
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

describe("browser tool schema", () => {
  it("advertises the viewport resize maximum on nested and flattened act params", () => {
    const properties = BrowserToolSchema.properties as SchemaRecord;
    const requestProperties = properties.request.properties ?? {};

    expect(properties.width.maximum).toBe(ACT_MAX_VIEWPORT_DIMENSION);
    expect(properties.height.maximum).toBe(ACT_MAX_VIEWPORT_DIMENSION);
    expect(requestProperties.width.maximum).toBe(ACT_MAX_VIEWPORT_DIMENSION);
    expect(requestProperties.height.maximum).toBe(ACT_MAX_VIEWPORT_DIMENSION);
  });

  it("describes targetId as a compatible tab reference", () => {
    const properties = BrowserToolSchema.properties as BrowserSchemaRecord;
    const requestProperties = properties.request.properties as BrowserSchemaRecord;

    expect(properties.targetId.description).toContain("Prefer suggestedTargetId");
    expect(properties.targetId.description).toContain("raw CDP targetId");
    expect(requestProperties.targetId.description).toBe(properties.targetId.description);
  });

  it("exposes explicit download actions and their output path", () => {
    const properties = BrowserToolSchema.properties as BrowserSchemaRecord;

    expect(properties.action.enum).toEqual(expect.arrayContaining(["download", "waitfordownload"]));
    expect(properties.path).toBeDefined();
  });

  it("exposes scrollIntoView on nested and flattened act params", () => {
    const properties = BrowserToolSchema.properties as BrowserSchemaRecord;
    const requestProperties = properties.request.properties as BrowserSchemaRecord;

    expect(properties.kind.enum).toContain("scrollIntoView");
    expect(requestProperties.kind.enum).toContain("scrollIntoView");
  });

  it("exposes batch actions on nested and flattened act params", () => {
    const properties = BrowserToolSchema.properties as BrowserSchemaRecord;
    const requestProperties = properties.request.properties as BrowserSchemaRecord;

    expect(properties.kind.enum).toContain("batch");
    expect(properties.actions).toBeDefined();
    expect(requestProperties.kind.enum).toContain("batch");
    expect(requestProperties.actions).toBeDefined();
  });
});
