import { expect } from "vitest";
import type { McpAppFixtureEvent } from "../test-helpers/mcp-app-conformance-fixture.ts";

export async function waitForMcpAppTimingEvents(
  readEvents: () => Promise<McpAppFixtureEvent[]>,
  scenario: string,
): Promise<McpAppFixtureEvent[]> {
  // Retain upstream terminal evidence even when the browser already failed.
  await expect
    .poll(
      async () =>
        (await readEvents()).filter(
          (event) => event.scenario === scenario && event.event === "tool-complete",
        ).length,
      { timeout: 12_000 },
    )
    .toBe(1);
  await expect
    .poll(
      async () =>
        (await readEvents()).filter(
          (event) =>
            event.scenario === scenario &&
            event.event === "response-written" &&
            event.method === "tools/call" &&
            event.tool === "app_companion",
        ).length,
      { timeout: 3000 },
    )
    .toBe(1);
  return (await readEvents()).filter((event) => event.scenario === scenario);
}

export function assertMcpAppTimingEvents(
  events: McpAppFixtureEvent[],
  spec: { callDelayMs: number; refresh: boolean },
): void {
  expect(events.filter((event) => event.event === "tool-start")).toHaveLength(1);
  expect(events.filter((event) => event.event === "tool-complete")).toHaveLength(1);
  const start = events.find((event) => event.event === "tool-start");
  const complete = events.find((event) => event.event === "tool-complete");
  if (!start || !complete) {
    throw new Error("Missing upstream terminal events");
  }
  const call = events.find(
    (event) =>
      event.event === "incoming" && event.method === "tools/call" && event.tool === "app_companion",
  );
  expect(
    events.filter(
      (event) =>
        event.event === "incoming" &&
        event.method === "tools/call" &&
        event.tool === "app_companion",
    ),
  ).toHaveLength(1);
  if (!call) {
    throw new Error("Missing actual tools/call ingress");
  }
  const callWritten = events.find(
    (event) => event.event === "response-written" && event.id === call.id,
  );
  if (!callWritten) {
    throw new Error("No correlated tools/call response; inspect cancellation events");
  }
  expect(callWritten.monotonicMs - call.monotonicMs).toBeLessThan(10_000);
  expect(start.requestId).toBe(call.id);
  expect(complete.requestId).toBe(call.id);
  expect(complete.monotonicMs - call.monotonicMs).toBeLessThan(10_000);
  expect(complete.monotonicMs - start.monotonicMs).toBeGreaterThanOrEqual(spec.callDelayMs - 100);
  expect(complete.monotonicMs - start.monotonicMs).toBeLessThan(10_000);
  if (spec.refresh) {
    expect(
      events.filter((event) => event.event === "incoming" && event.method === "tools/list"),
    ).toHaveLength(1);
    expect(events.filter((event) => event.event === "notification-sent")).toHaveLength(1);
    const ready = events.find((event) => event.event === "list-response-ready");
    const sent = events.find((event) => event.event === "list-response-send");
    const written = events.find(
      (event) => event.event === "response-written" && event.method === "tools/list",
    );
    const incoming = events.find(
      (event) => event.event === "incoming" && event.method === "tools/list",
    );
    if (!ready || !sent || !written || !incoming) {
      throw new Error("Missing correlated catalog response events");
    }
    expect(written.id).toBe(incoming.id);
    expect(ready.id).toBe(incoming.id);
    expect(written.monotonicMs - incoming.monotonicMs).toBeLessThan(10_000);
    expect(sent.monotonicMs - ready.monotonicMs).toBeGreaterThanOrEqual(7900);
    expect(sent.monotonicMs - ready.monotonicMs).toBeLessThan(10_000);
    expect(start.monotonicMs).toBeGreaterThanOrEqual(written.monotonicMs);
  }
}
