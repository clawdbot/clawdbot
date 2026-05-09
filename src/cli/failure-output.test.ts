import { describe, expect, it } from "vitest";
import { formatCliFailureLines } from "./failure-output.js";

describe("formatCliFailureLines", () => {
  it("shows a concise reason and recovery commands by default", () => {
    const lines = formatCliFailureLines({
      title: "Could not start the CLI.",
      error: new Error("config file is invalid"),
      argv: ["node", "openclaw", "status"],
      env: {},
    });

    expect(lines).toContain("[openclaw] Could not start the CLI.");
    expect(lines).toContain("[openclaw] Reason: config file is invalid");
    expect(lines).toContain("[openclaw] Debug: set OPENCLAW_DEBUG=1 to include the stack trace.");
    expect(lines).toContain("[openclaw] Try: openclaw doctor");
    expect(lines).toContain("[openclaw] Help: openclaw --help");
  });

  it("prints stack details when debug output is requested", () => {
    const lines = formatCliFailureLines({
      title: "The CLI command failed.",
      error: new Error("boom"),
      env: { OPENCLAW_DEBUG: "1" },
    });

    expect(lines).toContain("[openclaw] Stack:");
    expect(lines.some((line) => line.includes("Error: boom"))).toBe(true);
  });
});
