import { describe, expect, it } from "vitest";
import { POLICY_CLI_DESCRIPTOR } from "./cli-output-mode.js";

const isMachineOutput = POLICY_CLI_DESCRIPTOR.machineOutput;

describe("policy CLI output mode", () => {
  it.each(["check", "compare", "watch"])("detects piped %s output", (command) => {
    expect(
      isMachineOutput({
        argv: ["node", "openclaw", "policy", command],
        stdoutIsTTY: false,
      }),
    ).toBe(true);
  });

  it("keeps terminal output human-readable", () => {
    expect(
      isMachineOutput({
        argv: ["node", "openclaw", "policy", "check"],
        stdoutIsTTY: true,
      }),
    ).toBe(false);
  });

  it("accepts a post-root log level", () => {
    expect(
      isMachineOutput({
        argv: ["node", "openclaw", "policy", "--log-level", "debug", "check"],
        stdoutIsTTY: false,
      }),
    ).toBe(true);
  });
});
