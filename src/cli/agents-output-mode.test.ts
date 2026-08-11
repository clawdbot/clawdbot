import { describe, expect, it } from "vitest";
import { isAgentsMachineOutput } from "./agents-output-mode.js";

describe("agents machine output", () => {
  it("classifies the hidden database rehearsal as machine output", () => {
    expect(isAgentsMachineOutput(["node", "openclaw", "agents", "db-rehearsal"])).toBe(true);
    expect(
      isAgentsMachineOutput([
        "node",
        "openclaw",
        "--profile",
        "test",
        "agents",
        "db-rehearsal",
        "--request",
        "-",
      ]),
    ).toBe(true);
  });

  it("keeps ordinary agent management on human output", () => {
    expect(isAgentsMachineOutput(["node", "openclaw", "agents", "list"])).toBe(false);
    expect(isAgentsMachineOutput(["node", "openclaw", "agents"])).toBe(false);
  });
});
