import { describe, expect, it } from "vitest";
import { isFormDataLike } from "./form-data.js";

describe("isFormDataLike", () => {
  it("recognizes the runtime FormData implementation", () => {
    expect(isFormDataLike(new FormData())).toBe(true);
  });

  it("recognizes a structurally compatible implementation", () => {
    const formDataLike = {
      [Symbol.toStringTag]: "FormData",
      *entries(): IterableIterator<[string, FormDataEntryValue]> {
        yield ["field", "value"];
      },
    };

    expect(isFormDataLike(formDataLike)).toBe(true);
  });

  it.each([
    { name: "null", value: null },
    { name: "undefined", value: undefined },
    { name: "string", value: "form-data" },
    { name: "plain object", value: {} },
    { name: "entries only", value: { entries: () => {} } },
    {
      name: "tag only",
      value: { [Symbol.toStringTag]: "FormData" },
    },
    {
      name: "wrong tag",
      value: { entries: () => {}, [Symbol.toStringTag]: "NotFormData" },
    },
  ])("rejects $name", ({ value }) => {
    expect(isFormDataLike(value)).toBe(false);
  });
});
