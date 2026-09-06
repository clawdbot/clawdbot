import { describe, expect, it } from "vitest";
import { EventHub, OpenClaw } from "./index.js";
import type { GatewayEvent, OpenClawEvent, OpenClawTransport } from "./types.js";

const runId = "sdk-observed-run";

async function collectSdkRunFixture(
  mode: "live" | "replay",
  frames: readonly [GatewayEvent, ...GatewayEvent[]],
) {
  const hub = new EventHub<GatewayEvent>({ replayLimit: 10 });
  const transport: OpenClawTransport = {
    request: async () => {
      throw new Error("This stream test must not issue RPC requests");
    },
    events: (filter) => hub.stream(filter, { replay: true }),
    close: () => hub.close(),
  };
  const oc = new OpenClaw({ transport });
  const run = await oc.runs.get(runId);
  const iterator = run.events()[Symbol.asyncIterator]();
  const observed: OpenClawEvent[] = [];
  const collect = async () => {
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        return;
      }
      observed.push(next.value);
      if (next.value.raw?.event === "custom.debug") {
        return;
      }
    }
  };

  try {
    await oc.connect();
    if (mode === "live") {
      const firstEvent = iterator.next();
      hub.publish(frames[0]);
      const first = await firstEvent;
      if (first.done) {
        throw new Error("SDK stream closed before its start event");
      }
      observed.push(first.value);
      const pending = collect();
      for (const frame of frames.slice(1)) {
        hub.publish(frame);
      }
      await pending;
    } else {
      const drained = (async () => {
        for await (const event of oc.events()) {
          if (event.raw?.event === "custom.debug") {
            return;
          }
        }
      })();
      for (const frame of frames) {
        hub.publish(frame);
      }
      await drained;
      await collect();
    }

    const raw: GatewayEvent[] = [];
    for await (const event of oc.rawEvents()) {
      raw.push(event);
      if (event.event === "custom.debug") {
        break;
      }
    }
    return { observed, raw };
  } finally {
    await iterator.return?.();
    await oc.close();
  }
}

const start: GatewayEvent = {
  event: "agent",
  seq: 1,
  payload: { runId, ts: 1, stream: "lifecycle", data: { phase: "start" } },
};
const marker: GatewayEvent = { event: "custom.debug", seq: 6, payload: { runId, ts: 6 } };

describe.each([
  {
    label: "successful final",
    terminal: {
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "successful fallback" }] },
    },
    terminalType: "run.completed",
    terminalData: { phase: "end", outputText: "successful fallback" },
  },
  {
    label: "failed final",
    terminal: { state: "error", errorMessage: "fallback exhausted" },
    terminalType: "run.failed",
    terminalData: { phase: "error", error: "fallback exhausted" },
  },
  {
    label: "timeout final",
    terminal: { state: "error", errorKind: "timeout", errorMessage: "provider timed out" },
    terminalType: "run.timed_out",
    terminalData: { phase: "error", error: "provider timed out" },
  },
  {
    label: "cancelled final",
    terminal: { state: "aborted", stopReason: "rpc" },
    terminalType: "run.cancelled",
    terminalData: { phase: "end", aborted: true, stopReason: "rpc" },
  },
  {
    label: "timeout abort before its lifecycle event",
    terminal: { state: "aborted", stopReason: "timeout" },
    terminalType: "run.timed_out",
    terminalData: { phase: "end", aborted: true, stopReason: "timeout" },
  },
])("SDK $label after non-terminal observations", ({ terminal, terminalType, terminalData }) => {
  it.each(["live", "replay"] as const)(
    "preserves %s stream ordering and raw events",
    async (mode) => {
      const frames = [
        start,
        {
          event: "agent",
          seq: 2,
          payload: {
            runId,
            ts: 2,
            stream: "error",
            data: { reason: "seq gap", expected: 2, received: 3 },
          },
        },
        {
          event: "agent",
          seq: 3,
          payload: {
            runId,
            ts: 3,
            stream: "lifecycle",
            data: { phase: "error", endedAt: 3, error: "retryable provider failure" },
          },
        },
        {
          event: "chat",
          seq: 4,
          payload: {
            runId,
            ts: 4,
            state: "delta",
            message: { role: "assistant", content: "partial fallback" },
          },
        },
        { event: "chat", seq: 5, payload: { runId, ts: 5, ...terminal } },
        marker,
      ] as const;
      const expectedRaw = structuredClone(frames);
      const { observed, raw } = await collectSdkRunFixture(mode, frames);

      expect(observed.map((event) => event.type)).toEqual([
        "run.started",
        "raw",
        "raw",
        "assistant.delta",
        terminalType,
        "raw",
      ]);
      expect(observed.at(-2)?.data).toEqual(terminalData);
      expect(raw).toEqual(expectedRaw);
    },
  );
});

describe.each([
  { stopReason: "rpc", terminalType: "run.cancelled" },
  { stopReason: "timeout", terminalType: "run.timed_out" },
])("SDK chat-first $stopReason abort", ({ stopReason, terminalType }) => {
  it.each(["live", "replay"] as const)(
    "emits one %s terminal across both carriers",
    async (mode) => {
      const frames = [
        start,
        { event: "chat", seq: 2, payload: { runId, ts: 2, state: "aborted", stopReason } },
        {
          event: "agent",
          seq: 3,
          payload: {
            runId,
            ts: 3,
            stream: "lifecycle",
            data: { phase: "end", status: "cancelled", aborted: true, stopReason },
          },
        },
        marker,
      ] as const;
      const expectedRaw = structuredClone(frames);
      const { observed, raw } = await collectSdkRunFixture(mode, frames);

      expect(observed.map((event) => event.type)).toEqual(["run.started", terminalType, "raw"]);
      expect(raw).toEqual(expectedRaw);
    },
  );
});
