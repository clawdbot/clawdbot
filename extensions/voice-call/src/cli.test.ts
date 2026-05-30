import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import { testing } from "./cli.js";

describe("voice-call CLI gateway fallback", () => {
  it("treats abnormal local gateway closes as standalone-runtime fallback candidates", () => {
    expect(
      testing.isGatewayUnavailableForLocalFallback(
        new Error("gateway closed (1006 abnormal closure (no close frame)): no close reason"),
      ),
    ).toBe(true);
  });
});

describe("parseVoiceCallIntOption", () => {
  it("parses decimal integer option values", () => {
    expect(testing.parseVoiceCallIntOption("250", "--poll", { min: 50 })).toBe(250);
    expect(testing.parseVoiceCallIntOption(" 25 ", "--since")).toBe(25);
  });

  it("rejects non-decimal JavaScript numeric syntax", () => {
    expect(() => testing.parseVoiceCallIntOption("0x10", "--last")).toThrow(
      "Invalid numeric value for --last: 0x10",
    );
    expect(() => testing.parseVoiceCallIntOption("1e3", "--last")).toThrow(
      "Invalid numeric value for --last: 1e3",
    );
  });

  it("rejects unsafe integers and max-bound violations", () => {
    expect(() => testing.parseVoiceCallIntOption("9007199254740993", "--last", { min: 1 })).toThrow(
      "Invalid numeric value for --last: 9007199254740993",
    );
    expect(() =>
      testing.parseVoiceCallIntOption("65536", "--port", { min: 1, max: 65535 }),
    ).toThrow("Invalid numeric value for --port: 65536");
  });
});

describe("voice-call CLI timeout helpers", () => {
  it("caps gateway operation timeout grace", () => {
    expect(testing.resolveGatewayOperationTimeoutMs({ ringTimeoutMs: 10_000 } as never)).toBe(
      30_000,
    );
    expect(testing.resolveGatewayOperationTimeoutMs({ ringTimeoutMs: 60_000 } as never)).toBe(
      65_000,
    );
    expect(
      testing.resolveGatewayOperationTimeoutMs({ ringTimeoutMs: Number.MAX_SAFE_INTEGER } as never),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(
      testing.resolveGatewayOperationTimeoutMs({ ringTimeoutMs: Number.MAX_VALUE } as never),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("caps gateway continue timeout totals", () => {
    expect(testing.resolveGatewayContinueTimeoutMs({ transcriptTimeoutMs: 180_000 } as never)).toBe(
      220_000,
    );
    expect(
      testing.resolveGatewayContinueTimeoutMs({
        transcriptTimeoutMs: Number.MAX_SAFE_INTEGER,
      } as never),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("caps gateway polling deadlines", () => {
    expect(testing.resolveVoiceCallDeadlineMs(5_000, 10_000)).toBe(15_000);
    expect(testing.resolveVoiceCallDeadlineMs(Number.MAX_SAFE_INTEGER, 10_000)).toBe(
      10_000 + MAX_TIMER_TIMEOUT_MS,
    );
  });
});
