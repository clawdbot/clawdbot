// Browser tests cover browser tool.schema plugin behavior.
import { describe, expect, it } from "vitest";
import { BrowserToolSchema } from "./browser-tool.schema.js";
import { ACT_MAX_VIEWPORT_DIMENSION } from "./browser/act-policy.js";

type SchemaRecord = Record<string, { maximum?: number; properties?: SchemaRecord }>;
type SchemaProperty = {
  description?: string;
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
});
