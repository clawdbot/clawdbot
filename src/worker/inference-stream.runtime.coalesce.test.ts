import { describe, expect, it } from "vitest";
import type {
  WorkerInferenceEventParams,
  WorkerInferenceModelRef,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { testing } from "./inference-stream.runtime.js";

const MODEL_REF = { provider: "openai", model: "gpt-5.5" } as WorkerInferenceModelRef;

function ev(event: Record<string, unknown>): WorkerInferenceEventParams {
  return { event } as unknown as WorkerInferenceEventParams;
}

function fragmentize(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

type FinalizedToolCall = {
  type: string;
  arguments: unknown;
  partialJson?: string;
  argParseThreshold?: number;
};

// Drive one tool call's argument stream (start → deltas → end) through the
// reducer and return the finalized tool-call block.
function runToolCall(argsJson: string, fragmentSize: number): FinalizedToolCall {
  const partial = testing.emptyAssistantMessage(MODEL_REF);
  testing.processInferenceEvent(
    ev({ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "write_file" }),
    partial,
    false,
  );
  for (const delta of fragmentize(argsJson, fragmentSize)) {
    testing.processInferenceEvent(
      ev({ type: "toolcall_delta", contentIndex: 0, delta }),
      partial,
      false,
    );
  }
  testing.processInferenceEvent(ev({ type: "toolcall_end", contentIndex: 0 }), partial, false);
  return partial.content[0] as unknown as FinalizedToolCall;
}

describe("worker inference streaming tool-call argument coalesce", () => {
  // ~2.7KB: crosses the 4KB-floor boundary region so the coalesced path is
  // exercised even at byte-level fragmentation.
  const moderate = JSON.stringify({
    path: "/analysis/report.md",
    content: "x".repeat(2600),
    meta: { nested: [1, 2, 3], ok: true, tag: "quarterly" },
  });
  // ~70KB: many doublings past the floor (realistic large tool call).
  const large = JSON.stringify({ path: "/analysis/big.md", content: "y".repeat(70_000) });

  it("final arguments equal a single full parse across fragment boundaries (moderate)", () => {
    const expected = JSON.parse(moderate);
    for (const size of [1, 7, 24, 100, 1000]) {
      const block = runToolCall(moderate, size);
      expect(block.arguments, `size=${size}`).toStrictEqual(expected);
      // streaming scratch fields are cleaned off the finalized tool call
      expect(block.partialJson, `size=${size}`).toBeUndefined();
      expect(block.argParseThreshold, `size=${size}`).toBeUndefined();
    }
  });

  it("final arguments equal a single full parse for a large payload", () => {
    const expected = JSON.parse(large);
    for (const size of [512, 8192]) {
      const block = runToolCall(large, size);
      expect(block.arguments, `size=${size}`).toStrictEqual(expected);
    }
  });

  it("re-parses on every delta while below the coalesce threshold", () => {
    // A small tool call keeps its live parsed-args preview current each delta,
    // before the authoritative parse at toolcall_end.
    const partial = testing.emptyAssistantMessage(MODEL_REF);
    testing.processInferenceEvent(
      ev({ type: "toolcall_start", contentIndex: 0, id: "c", toolName: "lookup" }),
      partial,
      false,
    );
    testing.processInferenceEvent(
      ev({ type: "toolcall_delta", contentIndex: 0, delta: '{"query":' }),
      partial,
      false,
    );
    testing.processInferenceEvent(
      ev({ type: "toolcall_delta", contentIndex: 0, delta: '"weather"}' }),
      partial,
      false,
    );
    expect((partial.content[0] as unknown as FinalizedToolCall).arguments).toStrictEqual({
      query: "weather",
    });
    testing.processInferenceEvent(ev({ type: "toolcall_end", contentIndex: 0 }), partial, false);
    expect((partial.content[0] as unknown as FinalizedToolCall).arguments).toStrictEqual({
      query: "weather",
    });
  });
});
