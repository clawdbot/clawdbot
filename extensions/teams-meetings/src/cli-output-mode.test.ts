import { describe, expect, it } from "vitest";
import { TEAMS_MEETINGS_CLI_METADATA } from "./cli-output-mode.js";

const isMachineOutput = TEAMS_MEETINGS_CLI_METADATA.descriptor.machineOutput;

describe("Teams meetings CLI output mode", () => {
  it("detects action output and ignores the bare root", () => {
    expect(
      isMachineOutput({
        argv: ["node", "openclaw", "teamsmeetings", "status"],
      }),
    ).toBe(true);
    expect(isMachineOutput({ argv: ["node", "openclaw", "teamsmeetings"] })).toBe(false);
    expect(
      isMachineOutput({
        argv: ["node", "openclaw", "teamsmeetings", "--log-level", "debug", "status"],
      }),
    ).toBe(true);
  });
});
