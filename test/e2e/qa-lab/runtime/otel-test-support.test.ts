import { describe, expect, test } from "vitest";
import { type CapturedSpan, createRecentTraceSummary } from "./otel-test-support.js";

function span(traceId: string, name: string): CapturedSpan {
  return { attributes: {}, name, parent: false, traceId };
}

describe("recent OTLP trace summaries", () => {
  test("retains the eight most recently active traces", () => {
    const summary = createRecentTraceSummary();
    summary.add(Array.from({ length: 9 }, (_, index) => span(`trace-${index}`, "started")));
    summary.add([span("trace-0", "finished")]);

    expect(summary.read()).toEqual([
      ...Array.from({ length: 7 }, (_, index) => ({
        traceId: `trace-${index + 2}`,
        names: { started: 1 },
      })),
      { traceId: "trace-0", names: { finished: 1 } },
    ]);
  });

  test("bounds distinct span names retained for each trace", () => {
    const summary = createRecentTraceSummary();
    summary.add(Array.from({ length: 20 }, (_, index) => span("trace", `span-${index}`)));

    const [trace] = summary.read();
    expect(Object.keys(trace!.names)).toHaveLength(16);
    expect(trace!.names.other).toBe(5);
  });
});
