// Control UI tests cover logs behavior.
import { describe, expect, it } from "vitest";
import { parseLogLine } from "./logs.ts";

describe("parseLogLine", () => {
  it("strips ANSI escape sequences from rendered log fields", () => {
    const parsed = parseLogLine(
      JSON.stringify({
        "0": "\u001b[36mgateway\u001b[39m",
        "1": "\u001b[31mfailed\u001b[39m to start",
        _meta: { logLevelName: "error" },
      }),
    );

    expect(parsed.subsystem).toBe("gateway");
    expect(parsed.message).toBe("failed to start");
    expect(parsed.raw).toContain("\\u001b");
  });

  it("strips ANSI escape sequences from plain log lines", () => {
    expect(parseLogLine("\u001b[33mwarning\u001b[39m").message).toBe("warning");
  });

  it("strips OSC hyperlink escape payloads from displayed log fields", () => {
    const link = "\u001b]8;;https://example.test\u0007docs\u001b]8;;\u0007";

    expect(parseLogLine(`${link} ready`).message).toBe("docs ready");
  });
});
