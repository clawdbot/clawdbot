import { describe, expect, it } from "vitest";
import { splitConfigSchemaByTier } from "./config-form.tiers.ts";

describe("splitConfigSchemaByTier", () => {
  it("preserves nested containers while separating common and advanced leaves", () => {
    const split = splitConfigSchemaByTier({
      path: ["gateway"],
      schema: {
        type: "object",
        required: ["port", "reload"],
        properties: {
          port: { type: "integer" },
          reload: {
            type: "object",
            properties: {
              mode: { type: "string" },
              debounceMs: { type: "integer" },
            },
          },
        },
      },
      hints: {
        "gateway.port": { advanced: false },
        "gateway.reload.mode": { advanced: false },
        "gateway.reload.debounceMs": { advanced: true },
      },
    });

    expect(split.commonLeafCount).toBe(2);
    expect(split.advancedLeafCount).toBe(1);
    expect(split.common?.properties).toEqual({
      port: { type: "integer" },
      reload: { type: "object", properties: { mode: { type: "string" } } },
    });
    expect(split.common?.required).toEqual(["port", "reload"]);
    expect(split.advanced?.properties).toEqual({
      reload: { type: "object", properties: { debounceMs: { type: "integer" } } },
    });
    expect(split.advanced?.required).toEqual(["reload"]);
  });

  it("defaults unresolved leaves to advanced", () => {
    const split = splitConfigSchemaByTier({
      path: ["future"],
      schema: { type: "object", properties: { option: { type: "boolean" } } },
      hints: {},
    });
    expect(split.common).toBeNull();
    expect(split.advancedLeafCount).toBe(1);
  });

  it("keeps positional tuples atomic so tier projection cannot shift indexes", () => {
    const tuple = {
      type: "array",
      items: [{ type: "string" }, { type: "integer" }],
    };
    const split = splitConfigSchemaByTier({
      path: ["pair"],
      schema: tuple,
      hints: { pair: { advanced: false } },
    });
    expect(split.common).toEqual(tuple);
    expect(split.commonLeafCount).toBe(1);
    expect(split.advanced).toBeNull();
  });

  it("keeps open-ended objects atomic so fixed keys cannot reappear as extras", () => {
    const split = splitConfigSchemaByTier({
      path: ["env"],
      schema: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        additionalProperties: true,
      },
      hints: { env: { advanced: true }, "env.enabled": { advanced: false } },
    });
    expect(split.common).toBeNull();
    expect(split.advanced?.properties).toEqual({ enabled: { type: "boolean" } });
    expect(split.advanced?.additionalProperties).toBe(true);
    expect(split.commonLeafCount).toBe(0);
    expect(split.advancedLeafCount).toBe(1);
  });
});
