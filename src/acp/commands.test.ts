import { describe, expect, it } from "vitest";
import { getAvailableCommands } from "./commands.js";

describe("ACP available commands", () => {
  it("advertises Ultra in the thinking command", () => {
    const think = getAvailableCommands().find((command) => command.name === "think");

    expect(think?.description).toContain("off|minimal|low|medium|high|xhigh|adaptive|max|ultra");
  });
});
