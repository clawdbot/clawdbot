import { describe, expect, it } from "vitest";
import { projectProgressCardChannelUpdate } from "./progress-card-channel-summary.js";

describe("projectProgressCardChannelUpdate", () => {
  it.each([
    {
      name: "checklist",
      input: { plan: [{ step: "Ship", status: "completed" }] },
      expected: {
        steps: [{ step: "Ship", status: "completed" }],
        explanation: "1/1 complete",
      },
    },
    {
      name: "markdown-only",
      input: { markdown: "Working" },
      expected: { steps: [], explanation: "Progress updated" },
    },
    { name: "clear", input: {}, expected: { steps: [] } },
    { name: "invalid array", input: [], expected: undefined },
  ])("projects normalized $name input for every runtime producer", ({ input, expected }) => {
    expect(projectProgressCardChannelUpdate(input)).toEqual(expected);
  });
});
