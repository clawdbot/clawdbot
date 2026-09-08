import { describe, expect, it } from "vitest";
import { MSTeamsConfigSchema } from "./config-schema.js";

describe("Microsoft Teams single-account policy configuration", () => {
  it.each([
    {
      name: "retains fail-closed group access and pairing when both policies are omitted",
      input: {},
      expected: { groupPolicy: "allowlist", dmPolicy: "pairing" },
    },
    {
      name: "honors explicit open policies",
      input: { groupPolicy: "open", dmPolicy: "open", allowFrom: ["*"] },
      expected: { groupPolicy: "open", dmPolicy: "open" },
    },
    {
      name: "honors explicit disabled policies",
      input: { groupPolicy: "disabled", dmPolicy: "disabled" },
      expected: { groupPolicy: "disabled", dmPolicy: "disabled" },
    },
  ] as const)("$name", ({ input, expected }) => {
    expect(MSTeamsConfigSchema.parse(input)).toMatchObject(expected);
  });
});
