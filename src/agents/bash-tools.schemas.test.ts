import { describe, expect, it } from "vitest";
import { execCompletionSchema, execSchema, nodeExecSchema } from "./bash-tools.schemas.js";

describe("exec environment guidance", () => {
  it.each([
    ["full", execSchema],
    ["completion", execCompletionSchema],
    ["node", nodeExecSchema],
  ] as const)("explains literal overrides and inheritance on the %s surface", (_name, schema) => {
    expect(schema.properties.env).toMatchObject({
      description: expect.stringMatching(/literal.*no expansion.*omit to inherit/i),
    });
  });

  it("offers a bounded plain-English purpose for approval prompts", () => {
    expect(execSchema.properties.purpose).toMatchObject({
      maxLength: 240,
      description: expect.stringMatching(/plain-English.*approval prompts/i),
    });
    expect(execCompletionSchema.properties.purpose).toBeDefined();
    expect(nodeExecSchema.properties.purpose).toBeDefined();
  });
});
