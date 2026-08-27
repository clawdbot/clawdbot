import { describe, expect, it } from "vitest";
import { VOICE_CALL_CLI_DESCRIPTOR } from "./cli-output-mode.js";

const isMachineOutput = VOICE_CALL_CLI_DESCRIPTOR.machineOutput;

describe("voice-call CLI output mode", () => {
  it.each([
    "call",
    "continue",
    "dtmf",
    "end",
    "expose",
    "latency",
    "speak",
    "start",
    "status",
    "tail",
  ])("detects %s as machine output", (command) => {
    expect(isMachineOutput({ argv: ["node", "openclaw", "voicecall", command] })).toBe(true);
  });

  it("leaves setup human-readable without --json", () => {
    expect(isMachineOutput({ argv: ["node", "openclaw", "voicecall", "setup"] })).toBe(false);
  });

  it("accepts a post-root log level", () => {
    expect(
      isMachineOutput({
        argv: ["node", "openclaw", "voicecall", "--log-level", "debug", "status"],
      }),
    ).toBe(true);
  });
});
