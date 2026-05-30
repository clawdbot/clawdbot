import { describe, expect, it } from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../timer-delay.js";
import { normalizeActRequest } from "./agent.act.normalize.js";

describe("normalizeActRequest numeric fields", () => {
  it("keeps structured numeric action options", () => {
    expect(
      normalizeActRequest({
        kind: "click",
        ref: "button-1",
        delayMs: 25,
        timeoutMs: 5000,
      }),
    ).toMatchObject({
      kind: "click",
      ref: "button-1",
      delayMs: 25,
      timeoutMs: 5000,
    });
  });

  it("parses decimal integer strings for action options", () => {
    expect(
      normalizeActRequest({
        kind: "wait",
        timeMs: "25",
        timeoutMs: "5000",
      }),
    ).toMatchObject({
      kind: "wait",
      timeMs: 25,
      timeoutMs: 5000,
    });
  });

  it("caps oversized action timeouts", () => {
    expect(
      normalizeActRequest({
        kind: "wait",
        text: "ready",
        timeoutMs: String(Number.MAX_SAFE_INTEGER),
      }),
    ).toMatchObject({
      kind: "wait",
      text: "ready",
      timeoutMs: MAX_SAFE_TIMEOUT_DELAY_MS,
    });
  });

  it("rejects loose integer tokens for action durations and timeouts", () => {
    expect(() =>
      normalizeActRequest({
        kind: "click",
        ref: "button-1",
        delayMs: "0x10",
      }),
    ).toThrow("delayMs must be a non-negative integer.");

    expect(() =>
      normalizeActRequest({
        kind: "wait",
        timeMs: "1e3",
      }),
    ).toThrow("timeMs must be a non-negative integer.");

    expect(() =>
      normalizeActRequest({
        kind: "hover",
        ref: "button-1",
        timeoutMs: "1000ms",
      }),
    ).toThrow("timeoutMs must be a positive integer.");
  });

  it("rejects fractional viewport dimensions before dispatch", () => {
    expect(() =>
      normalizeActRequest({
        kind: "resize",
        width: "800.5",
        height: 600,
      }),
    ).toThrow("resize requires positive width and height");
  });
});
