// Failure output tests cover CLI error formatting and failure summaries.
import { describe, expect, it } from "vitest";
import { formatCliFailureLines, formatCliJsonFailure } from "./failure-output.js";

describe("formatCliJsonFailure", () => {
  it("uses the canonical typed envelope and redacts the message", () => {
    const token = "sk-abcdefghijklmnopqrstuv";
    const payload = formatCliJsonFailure(new Error(`Authorization: Bearer ${token}`));

    expect(payload).toEqual({
      ok: false,
      error: {
        type: "cli_error",
        message: expect.stringContaining("Authorization: Bearer"),
      },
    });
    expect(payload.error.message).not.toContain(token);
  });

  it("keeps nested causes behind the debug gate", () => {
    const error = new Error("Promotion is not available.", {
      cause: new Error("ClawHub /api/v1/promotions/nope failed (404)"),
    });

    expect(formatCliJsonFailure(error, { env: {} }).error.message).toBe(
      "Promotion is not available.",
    );
    expect(formatCliJsonFailure(error, { env: { OPENCLAW_DEBUG: "1" } }).error.message).toBe(
      "Promotion is not available. | ClawHub /api/v1/promotions/nope failed (404)",
    );
  });
});

describe("formatCliFailureLines", () => {
  it("shows a concise reason and recovery commands by default", () => {
    const lines = formatCliFailureLines({
      title: "Could not start the CLI.",
      error: new Error("config file is invalid", {
        cause: new Error("unexpected token at /internal/config.json:12"),
      }),
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

  it.each(["--debug", "--verbose"])("prints stack details for the root %s option", (debugFlag) => {
    const lines = formatCliFailureLines({
      title: "The CLI command failed.",
      error: new Error("boom", { cause: new Error("transport detail") }),
      argv: ["node", "openclaw", "proxy", "run", debugFlag],
      env: {},
    });

    expect(lines).toContain("[openclaw] Reason: boom | transport detail");
    expect(lines).toContain("[openclaw] Stack:");
    expect(lines).toContain("[openclaw] Error: boom");
  });

  it.each(["--debug", "--verbose"])(
    "does not enable root stack traces for a child %s option",
    (debugFlag) => {
      const lines = formatCliFailureLines({
        title: "The CLI command failed.",
        error: new Error("boom"),
        argv: ["node", "openclaw", "proxy", "run", "--", "child", debugFlag],
        env: {},
      });

      expect(lines).not.toContain("[openclaw] Stack:");
      expect(lines).toContain("[openclaw] Debug: set OPENCLAW_DEBUG=1 to include the stack trace.");
    },
  );
});
