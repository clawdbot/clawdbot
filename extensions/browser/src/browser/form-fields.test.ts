import { describe, expect, it } from "vitest";
import { normalizeBrowserFormFields } from "./form-fields.js";

describe("normalizeBrowserFormFields", () => {
  it.each([
    { name: "omitted", field: { ref: "e1" }, expected: { ref: "e1", type: "text" } },
    { name: "null", field: { ref: "e1", value: null }, expected: { ref: "e1", type: "text" } },
    {
      name: "empty",
      field: { ref: "e1", value: "" },
      expected: { ref: "e1", type: "text", value: "" },
    },
    {
      name: "string",
      field: { ref: "e1", value: "Ada" },
      expected: { ref: "e1", type: "text", value: "Ada" },
    },
    {
      name: "number",
      field: { ref: "e1", value: 7 },
      expected: { ref: "e1", type: "text", value: 7 },
    },
    {
      name: "boolean",
      field: { ref: "e1", value: false },
      expected: { ref: "e1", type: "text", value: false },
    },
  ])("keeps the supported $name value", ({ field, expected }) => {
    expect(normalizeBrowserFormFields([field])).toEqual([expected]);
  });

  it.each([
    [{ ref: "e1", value: "Neo", text: "unsupported" }, 'unsupported field key "text"'],
    [{ value: "Ada" }, "must include ref"],
    [{ ref: "e1", value: ["Neo"] }, "value must be a string, number, boolean, or null"],
  ])("rejects an invalid field with its index", (field, message) => {
    expect(() => normalizeBrowserFormFields([{ ref: "e0", value: "valid" }, field])).toThrow(
      `fields[1] ${message}`,
    );
  });
});
