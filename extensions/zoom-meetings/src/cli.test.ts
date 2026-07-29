import { Command } from "commander";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import { registerZoomMeetingsCli, resolveZoomMeetingsCliGatewayTimeoutMs } from "./cli.js";
import { resolveZoomMeetingsConfig } from "./config.js";

describe("Zoom meetings CLI", () => {
  it("exposes the same bounded timeout on both live probes", () => {
    const program = new Command();
    registerZoomMeetingsCli({ program, config: resolveZoomMeetingsConfig({}) });
    const root = program.commands.find((command) => command.name() === "zoommeetings");

    for (const name of ["test-speech", "test-listen"]) {
      const probe = root?.commands.find((command) => command.name() === name);
      expect(probe?.options.map((option) => option.long)).toContain("--timeout-ms");
    }
  });

  it("adds the post-join probe budget to the gateway deadline", () => {
    const config = resolveZoomMeetingsConfig({});
    expect(resolveZoomMeetingsCliGatewayTimeoutMs(config, { probe: false })).toBe(150_000);
    expect(resolveZoomMeetingsCliGatewayTimeoutMs(config, { probe: true })).toBe(180_000);
    expect(
      resolveZoomMeetingsCliGatewayTimeoutMs(config, {
        probe: true,
        requestedTimeoutMs: 10_000,
      }),
    ).toBe(160_000);
    expect(
      resolveZoomMeetingsCliGatewayTimeoutMs(
        resolveZoomMeetingsConfig({
          chrome: { joinTimeoutMs: 120_000, waitForInCallMs: 40_000 },
        }),
        { probe: true },
      ),
    ).toBe(430_000);
    expect(
      resolveZoomMeetingsCliGatewayTimeoutMs(
        resolveZoomMeetingsConfig({
          chrome: { joinTimeoutMs: Number.MAX_VALUE, waitForInCallMs: Number.MAX_VALUE },
        }),
        { probe: true, requestedTimeoutMs: Number.MAX_VALUE },
      ),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
