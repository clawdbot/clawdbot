import { describe, expect, it } from "vitest";
import { ACT_MAX_VIEWPORT_DIMENSION } from "./browser/act-policy.js";
import { BrowserToolSchema } from "./browser-tool.schema.js";

type SchemaRecord = Record<string, { maximum?: number; properties?: SchemaRecord }>;

describe("browser tool schema", () => {
  it("advertises the viewport resize maximum on nested and flattened act params", () => {
    const properties = BrowserToolSchema.properties as SchemaRecord;
    const requestProperties = properties.request.properties ?? {};

    expect(properties.width.maximum).toBe(ACT_MAX_VIEWPORT_DIMENSION);
    expect(properties.height.maximum).toBe(ACT_MAX_VIEWPORT_DIMENSION);
    expect(requestProperties.width.maximum).toBe(ACT_MAX_VIEWPORT_DIMENSION);
    expect(requestProperties.height.maximum).toBe(ACT_MAX_VIEWPORT_DIMENSION);
  });
});
