import { describe, expect, it } from "vitest";
import { coerceMcpToolInputToSchema } from "./mcp-tool-input-coercion.js";

const notionish = {
  type: "object",
  properties: {
    count: { type: "integer" },
    price: { type: "number" },
    title: { type: "string" },
  },
} as const;

describe("coerceMcpToolInputToSchema (#107648)", () => {
  it("coerces a string integer where the schema says integer", () => {
    expect(coerceMcpToolInputToSchema({ count: "10" }, notionish)).toEqual({ count: 10 });
  });

  it("coerces a string decimal where the schema says number", () => {
    expect(coerceMcpToolInputToSchema({ price: "10.5" }, notionish)).toEqual({ price: 10.5 });
  });

  it("coerces negative and zero", () => {
    expect(coerceMcpToolInputToSchema({ count: "-3" }, notionish)).toEqual({ count: -3 });
    expect(coerceMcpToolInputToSchema({ count: "0" }, notionish)).toEqual({ count: 0 });
  });

  it("is a no-op for already-numeric values", () => {
    expect(coerceMcpToolInputToSchema({ count: 10, price: 2.5 }, notionish)).toEqual({
      count: 10,
      price: 2.5,
    });
  });

  it("never coerces a string field", () => {
    expect(coerceMcpToolInputToSchema({ title: "42" }, notionish)).toEqual({ title: "42" });
  });

  it("leaves non-numeric-looking strings untouched", () => {
    for (const bad of ["0x10", "1,000", "1e3", "10abc", " 1 2 ", "", "  ", "NaN"]) {
      expect(coerceMcpToolInputToSchema({ count: bad }, notionish)).toEqual({ count: bad });
    }
  });

  it("does not coerce a non-integer string for an integer field", () => {
    expect(coerceMcpToolInputToSchema({ count: "10.5" }, notionish)).toEqual({ count: "10.5" });
  });

  it("recurses into nested objects", () => {
    const schema = {
      type: "object",
      properties: {
        page: { type: "object", properties: { size: { type: "integer" } } },
      },
    };
    expect(coerceMcpToolInputToSchema({ page: { size: "25" } }, schema)).toEqual({
      page: { size: 25 },
    });
  });

  it("recurses into arrays of numbers", () => {
    const schema = { type: "object", properties: { rows: { type: "array", items: { type: "number" } } } };
    expect(coerceMcpToolInputToSchema({ rows: ["1", "2.5", "x"] }, schema)).toEqual({
      rows: [1, 2.5, "x"],
    });
  });

  it("leaves fields absent from the schema untouched", () => {
    expect(coerceMcpToolInputToSchema({ extra: "10" }, notionish)).toEqual({ extra: "10" });
  });

  it("tolerates missing/!object schema and non-object input", () => {
    expect(coerceMcpToolInputToSchema({ count: "10" }, undefined)).toEqual({ count: "10" });
    expect(coerceMcpToolInputToSchema("10", { type: "string" })).toEqual("10");
    expect(coerceMcpToolInputToSchema(null, notionish)).toEqual(null);
  });
});
