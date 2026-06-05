// Gateway Protocol tests cover channels.schema behavior.
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { ChannelsStatusResultSchema, WebLoginWaitParamsSchema } from "./schema/channels.js";

/**
 * Channel schema regressions for browser login and status diagnostics.
 * These payloads are consumed by dashboard/operator UI, so QR payload bounds
 * and event-loop diagnostic shape are part of the public gateway contract.
 */

describe("WebLoginWaitParamsSchema", () => {
  /** Compiled validator reused across QR bounds cases. */
  const validate = Compile(WebLoginWaitParamsSchema);

  it("bounds caller-provided QR data URLs", () => {
    expect(
      validate.Check({
        currentQrDataUrl: "data:image/png;base64,qr",
      }),
    ).toBe(true);

    expect(
      validate.Check({
        currentQrDataUrl: "x".repeat(16_385),
      }),
    ).toBe(false);
    expect(
      validate.Check({
        currentQrDataUrl: "https://example.com/qr.png",
      }),
    ).toBe(false);
  });
});

describe("ChannelsStatusResultSchema", () => {
  /** Compiled status validator for channel docking diagnostics. */
  const validate = Compile(ChannelsStatusResultSchema);

  it("accepts gateway event-loop diagnostics emitted by channels.status", () => {
    expect(
      validate.Check({
        ts: Date.now(),
        channelOrder: ["discord"],
        channelLabels: { discord: "Discord" },
        channels: { discord: { configured: true } },
        channelAccounts: {
          discord: [
            {
              accountId: "default",
              enabled: true,
              configured: true,
              running: true,
              connected: false,
              healthState: "stale-socket",
            },
          ],
        },
        channelDefaultAccountId: { discord: "default" },
        partial: true,
        warnings: ["discord:default probe timed out after 1000ms"],
        eventLoop: {
          degraded: true,
          reasons: ["event_loop_delay", "cpu"],
          intervalMs: 62_000,
          delayP99Ms: 1_250.5,
          delayMaxMs: 62_000,
          utilization: 0.98,
          cpuCoreRatio: 1.2,
        },
      }),
    ).toBe(true);
  });
});
