import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import { resolveBrowserActRequestTimeoutMs } from "./act-policy.js";
import type { BrowserActRequest } from "./client-actions.types.js";

describe("browser action request deadlines", () => {
  it("sums the delay and every sequential wait condition", () => {
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "wait",
        timeMs: 10_000,
        text: "ready",
        textGone: "loading",
        selector: "#result",
        url: "**/done",
        loadState: "networkidle",
        fn: "() => true",
        timeoutMs: 20_000,
      }),
    ).toBe(135_000);
  });

  it("normalizes each condition timeout before multiplication", () => {
    const wait = {
      kind: "wait",
      text: "ready",
      textGone: "loading",
      selector: "#result",
      url: "**/done",
      loadState: "load",
      fn: "() => true",
    } as const;

    expect(resolveBrowserActRequestTimeoutMs({ ...wait, timeoutMs: 1 })).toBe(8_000);
    expect(resolveBrowserActRequestTimeoutMs({ ...wait, timeoutMs: Number.MAX_VALUE })).toBe(
      725_000,
    );
  });

  it("matches runtime normalization for whitespace-only wait conditions", () => {
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "wait",
        timeMs: 0,
        text: " ",
        textGone: " ",
        selector: "",
        url: " ",
        fn: " ",
      }),
    ).toBe(45_000);
    expect(resolveBrowserActRequestTimeoutMs({ kind: "wait", timeMs: 0 })).toBe(5_000);
  });

  it("recursively sums nested batch children in execution order", () => {
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "batch",
        actions: [
          { kind: "wait", timeMs: 30_000 },
          {
            kind: "batch",
            actions: [
              { kind: "wait", timeMs: 30_000 },
              { kind: "wait", timeMs: 30_000 },
            ],
          },
        ],
      }),
    ).toBe(95_000);
  });

  it("keeps leaf defaults and adds outer slack once", () => {
    expect(resolveBrowserActRequestTimeoutMs({ kind: "click", ref: "1" })).toBe(65_000);
    expect(resolveBrowserActRequestTimeoutMs({ kind: "click", ref: "1", timeoutMs: 45_000 })).toBe(
      50_250,
    );
  });

  it("budgets sequential leaf phases and bounded delays", () => {
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "fill",
        fields: [
          { ref: "first", type: "text" },
          { ref: "second", type: "text" },
        ],
        timeoutMs: 20_000,
      }),
    ).toBe(45_500);
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "type",
        ref: "field",
        text: "value",
        slowly: true,
        submit: true,
        timeoutMs: 20_000,
      }),
    ).toBe(65_250);
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "click",
        ref: "button",
        delayMs: 5_000,
        timeoutMs: 20_000,
      }),
    ).toBe(50_250);
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "clickCoords",
        x: 10,
        y: 20,
        doubleClick: true,
        delayMs: 5_000,
        timeoutMs: 20_000,
      }),
    ).toBe(40_250);
  });

  it("preserves the prior whole-request floor for batches", () => {
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "batch",
        actions: [
          {
            kind: "fill",
            fields: [
              { ref: "first", type: "text" },
              { ref: "second", type: "text" },
            ],
            timeoutMs: 20_000,
          },
        ],
      }),
    ).toBe(65_000);
  });

  it("budgets the wider scrollIntoView locator timeout", () => {
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "batch",
        actions: Array.from({ length: 4 }, () => ({
          kind: "scrollIntoView" as const,
          ref: "result",
        })),
      }),
    ).toBe(86_000);
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "scrollIntoView",
        ref: "result",
        timeoutMs: 120_000,
      }),
    ).toBe(125_250);
  });

  it("leaves malformed model batch validation to the browser route", () => {
    expect(
      resolveBrowserActRequestTimeoutMs({
        kind: "batch",
        requests: [],
        actions: [{ kind: "wait", selector: 1 }, { kind: "unknown" }, null],
      } as unknown as BrowserActRequest),
    ).toBe(65_000);
  });

  it("saturates aggregate and slack arithmetic at the timer limit", () => {
    const actions: BrowserActRequest[] = Array.from({ length: 3_000 }, () => ({
      kind: "wait",
      text: "ready",
      textGone: "loading",
      selector: "#result",
      url: "**/done",
      loadState: "load",
      fn: "() => true",
      timeoutMs: 120_000,
    }));
    const batch = { kind: "batch", actions } as const;

    expect(resolveBrowserActRequestTimeoutMs(batch)).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
