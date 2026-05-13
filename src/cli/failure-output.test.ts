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

    expect(lines).toEqual([
      "[openclaw] Could not start the CLI.",
      "[openclaw] Reason: config file is invalid",
      "[openclaw] Debug: set OPENCLAW_DEBUG=1 to include the stack trace.",
      "[openclaw] Try: openclaw doctor",
      "[openclaw] Help: openclaw --help",
    ]);
  });

  it("prints stack details when debug output is requested", () => {
    const lines = formatCliFailureLines({
      title: "The CLI command failed.",
      error: new Error("boom"),
      env: { OPENCLAW_DEBUG: "1" },
    });

    expect(lines.slice(0, 4)).toEqual([
      "[openclaw] The CLI command failed.",
      "[openclaw] Reason: boom",
      "[openclaw] Stack:",
      "[openclaw] Error: boom",
    ]);
    expect(lines.join("\n")).toContain("Error: boom");
  });
});
