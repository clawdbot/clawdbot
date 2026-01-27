import { describe, expect, it } from "vitest";

import { formatHealthCheckFailure } from "./health-format.js";

const ansiEscape = String.fromCharCode(27);
const ansiRegex = new RegExp(`${ansiEscape}\\[[0-9;]*m`, "g");
const stripAnsi = (input: string) => input.replace(ansiRegex, "");

describe("formatHealthCheckFailure", () => {
  it("keeps non-rich output stable", () => {
    const err = new Error("gateway closed (1006 abnormal closure): no close reason");
    expect(formatHealthCheckFailure(err, { rich: false })).toBe(
      `Health check failed: ${String(err)}`,
    );
  });

  it("formats gateway connection details as indented key/value lines", () => {
    const err = new Error(
      [
        "gateway closed (1006 abnormal closure (no close frame)): no close reason",
        "Gateway target: ws://127.0.0.1:19001",
        "Source: local loopback",
        "Config: /Users/steipete/.clawdbot-dev/moltbot.json",
        "Bind: loopback",
      ].join("\n"),
    );

    expect(stripAnsi(formatHealthCheckFailure(err, { rich: true }))).toBe(
      [
        "Health check failed: gateway closed (1006 abnormal closure (no close frame)): no close reason",
        "  Gateway target: ws://127.0.0.1:19001",
        "  Source: local loopback",
        "  Config: /Users/steipete/.clawdbot-dev/moltbot.json",
        "  Bind: loopback",
      ].join("\n"),
    );
  });
});
