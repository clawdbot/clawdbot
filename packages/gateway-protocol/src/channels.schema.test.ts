// Gateway Protocol tests cover channels.schema behavior.
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
  ChannelsStatusResultSchema,
  TalkSessionAppendAudioParamsSchema,
  TalkSessionCancelOutputResultSchema,
  TalkSessionCommitAudioParamsSchema,
  TalkSessionCommitAudioResultSchema,
  TalkSessionCreateParamsSchema,
  WebLoginWaitParamsSchema,
} from "./schema/channels.js";

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

describe("TalkSessionCancelOutputResultSchema", () => {
  const validate = Compile(TalkSessionCancelOutputResultSchema);

  it("accepts only closed cancellation outcomes with an explicit ok field", () => {
    for (const value of [
      { ok: true },
      { ok: true, status: "applied", turnId: "turn-7" },
      { ok: true, status: "stale" },
      { ok: true, status: "idle" },
    ]) {
      expect(validate.Check(value)).toBe(true);
    }
    for (const value of [
      {},
      { status: "applied" },
      { ok: false },
      { ok: true, status: "unknown" },
      { ok: true, turnId: "" },
      { ok: true, extra: true },
    ]) {
      expect(validate.Check(value)).toBe(false);
    }
  });
});

describe("TalkSessionCommitAudioResultSchema", () => {
  const validate = Compile(TalkSessionCommitAudioResultSchema);

  it("accepts only closed manual-commit outcomes", () => {
    for (const status of ["committed", "duplicate"]) {
      expect(validate.Check({ ok: true, status, turnId: "turn-7" })).toBe(true);
    }
    for (const value of [
      {},
      { ok: true, status: "committed" },
      { ok: false, status: "committed", turnId: "turn-7" },
      { ok: true, status: "stale", turnId: "turn-7" },
      { ok: true, status: "committed", turnId: "" },
      { ok: true, status: "committed", turnId: "turn-7", extra: true },
    ]) {
      expect(validate.Check(value)).toBe(false);
    }
  });
});

describe("manual realtime input schemas", () => {
  const validateCreate = Compile(TalkSessionCreateParamsSchema);
  const validateAppend = Compile(TalkSessionAppendAudioParamsSchema);
  const validateCommit = Compile(TalkSessionCommitAudioParamsSchema);

  it("accepts only the explicit no-tools session policy", () => {
    expect(
      validateCreate.Check({
        mode: "realtime",
        transport: "gateway-relay",
        brain: "none",
        toolPolicy: "none",
      }),
    ).toBe(true);
    expect(validateCreate.Check({ toolPolicy: "auto" })).toBe(false);
    expect(validateCreate.Check({ toolPolicy: true })).toBe(false);
  });

  it("bounds client-owned manual turn ids", () => {
    expect(
      validateAppend.Check({ sessionId: "session-1", turnId: "turn-7", audioBase64: "AQI=" }),
    ).toBe(true);
    expect(validateCommit.Check({ sessionId: "session-1", turnId: "turn-7" })).toBe(true);
    expect(validateCommit.Check({ sessionId: "session-1", turnId: "" })).toBe(false);
    expect(validateCommit.Check({ sessionId: "session-1", turnId: "x".repeat(129) })).toBe(false);
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
              lastError: null,
              lastStartAt: null,
              lastStopAt: null,
              lastInboundAt: null,
              lastOutboundAt: null,
              credentialSource: "service-account",
              audienceType: "app-url",
              audience: "https://chat.example.test",
              webhookPath: "/googlechat",
              webhookUrl: null,
            },
          ],
        },
        channelDefaultAccountId: { discord: "default" },
        partial: true,
        warnings: ["discord:default probe timed out after 1000ms"],
        eventLoop: {
          degraded: true,
          degradedSinceMs: 61_000,
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
