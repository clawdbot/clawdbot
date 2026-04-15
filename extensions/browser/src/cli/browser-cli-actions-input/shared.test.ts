import { describe, expect, it } from "vitest";
import { readFields } from "./shared.js";

describe("readFields", () => {
  it.each([
    {
      name: "keeps explicit type",
      fields: '[{"ref":"6","type":"textbox","value":"hello"}]',
      expected: [{ ref: "6", type: "textbox", value: "hello" }],
    },
    {
      name: "defaults missing type to text",
      fields: '[{"ref":"7","value":"world"}]',
      expected: [{ ref: "7", type: "text", value: "world" }],
    },
    {
      name: "defaults blank type to text",
      fields: '[{"ref":"8","type":"   ","value":"blank"}]',
      expected: [{ ref: "8", type: "text", value: "blank" }],
    },
  ])("$name", async ({ fields, expected }) => {
    await expect(readFields({ fields })).resolves.toEqual(expected);
  });

  it("requires ref", async () => {
    await expect(readFields({ fields: '[{"type":"textbox","value":"world"}]' })).rejects.toThrow(
      "fields[0] must include ref",
    );
  });
});
