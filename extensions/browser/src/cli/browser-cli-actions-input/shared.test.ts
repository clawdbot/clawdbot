// Browser tests cover shared plugin behavior.
import { describe, expect, it } from "vitest";
import { readActionsPayload, readFields } from "./shared.js";

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

  it("throws descriptive error on malformed JSON", async () => {
    await expect(readFields({ fields: "NOT JSON {{{" })).rejects.toThrow(
      "fields must be valid JSON.",
    );
  });

  it("throws descriptive error on empty fields", async () => {
    await expect(readFields({ fields: "" })).rejects.toThrow("fields are required");
  });

  it("rejects conflicting inline and file form fields", async () => {
    await expect(
      readFields({ fields: "[]", fieldsFile: "/tmp/openclaw-browser-fields.json" }),
    ).rejects.toThrow("Specify only one of --fields or --fields-file");
  });
});

describe("readActionsPayload", () => {
  it("rejects conflicting inline and file actions before reading the file", async () => {
    await expect(
      readActionsPayload({ actions: "[]", actionsFile: "/tmp/openclaw-browser-actions.json" }),
    ).rejects.toThrow("Specify only one of --actions or --actions-file");
  });
});
