import { describe, expect, it } from "vitest";
import { selectWorkboardTools } from "./worker-tools.js";

describe("Workboard worker tool projection", () => {
  it("splits worker lifecycle tools from optional administrative tools", () => {
    const tools = [
      { name: "workboard_read" },
      { name: "workboard_complete" },
      { name: "workboard_dispatch" },
    ] as never;
    const workerNames = new Set(["workboard_read", "workboard_complete"]);

    expect(selectWorkboardTools(tools, workerNames, true).map((tool) => tool.name)).toEqual([
      "workboard_read",
      "workboard_complete",
    ]);
    expect(selectWorkboardTools(tools, workerNames, false).map((tool) => tool.name)).toEqual([
      "workboard_dispatch",
    ]);
  });
});
