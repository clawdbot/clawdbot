import { describe, expect, it } from "vitest";
import { ZOOM_MEETINGS_CLI_DESCRIPTOR } from "./cli-output-mode.js";

const isMachineOutput = ZOOM_MEETINGS_CLI_DESCRIPTOR.machineOutput;

describe("Zoom meetings CLI output mode", () => {
  it("detects action output and ignores the bare root", () => {
    expect(isMachineOutput({ argv: ["node", "openclaw", "zoommeetings", "status"] })).toBe(true);
    expect(isMachineOutput({ argv: ["node", "openclaw", "zoommeetings"] })).toBe(false);
    expect(
      isMachineOutput({
        argv: ["node", "openclaw", "zoommeetings", "--log-level", "debug", "status"],
      }),
    ).toBe(true);
  });
});
