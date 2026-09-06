import { describe, expect, it } from "vitest";
import { execCompletionSchema, execSchema, nodeExecSchema } from "./bash-tools.schemas.js";

describe("exec environment guidance", () => {
  it.each([
    ["full", execSchema],
    ["completion", execCompletionSchema],
    ["node", nodeExecSchema],
  ] as const)("explains literal overrides and inheritance on the %s surface", (_name, schema) => {
    expect(schema.properties.title).toMatchObject({
      type: "string",
      maxLength: 120,
      description: expect.stringContaining("never claim success"),
    });
    expect(schema.properties.env).toMatchObject({
      description: expect.stringMatching(/literal.*no expansion.*omit to inherit/i),
    });
  });
});
