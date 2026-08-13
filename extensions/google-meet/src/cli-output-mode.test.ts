import { describe, expect, it } from "vitest";
import { GOOGLE_MEET_CLI_DESCRIPTOR } from "./cli-output-mode.js";

const isMachineOutput = GOOGLE_MEET_CLI_DESCRIPTOR.machineOutput;

describe("Google Meet CLI output mode", () => {
  it.each(["join", "status", "test-listen", "test-speech"])(
    "detects %s as default JSON output",
    (command) => {
      expect(isMachineOutput({ argv: ["node", "openclaw", "googlemeet", command] })).toBe(true);
    },
  );

  it("does not classify human setup output", () => {
    expect(isMachineOutput({ argv: ["node", "openclaw", "googlemeet", "setup"] })).toBe(false);
  });

  it("accepts post-root options and detects dry-run exports", () => {
    expect(
      isMachineOutput({
        argv: ["node", "openclaw", "googlemeet", "--log-level", "debug", "join"],
      }),
    ).toBe(true);
    expect(
      isMachineOutput({
        argv: ["node", "openclaw", "googlemeet", "export", "--dry-run"],
      }),
    ).toBe(true);
  });
});
