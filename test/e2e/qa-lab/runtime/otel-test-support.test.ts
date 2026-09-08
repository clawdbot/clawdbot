import { once } from "node:events";
import { request } from "node:http";
import { describe, expect, test } from "vitest";
import {
  type CapturedSpan,
  createRecentTraceSummary,
  startLocalOtlpReceiver,
} from "./otel-test-support.js";

test("closes an OTLP receiver with an unfinished request body", async () => {
  const receiver = startLocalOtlpReceiver();
  const port = await receiver.listen();
  const client = request({
    hostname: "127.0.0.1",
    port,
    path: "/v1/traces",
    method: "POST",
    headers: { expect: "100-continue", "content-length": "100" },
  });
  const clientError = new Promise<Error>((resolve) => {
    client.once("error", resolve);
  });
  try {
    const accepted = once(client, "continue");
    client.flushHeaders();
    await accepted;

    await receiver.close();
    await expect(clientError).resolves.toMatchObject({ code: "ECONNRESET" });
    await receiver.close();
  } finally {
    client.destroy();
    await receiver.close();
  }
});

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
