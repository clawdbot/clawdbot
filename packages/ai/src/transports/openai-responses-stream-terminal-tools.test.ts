import { describe, expect, it } from "vitest";
import { completed, runFixture } from "./openai-responses-stream-parity.test-helpers.js";

const tool = (slot: number, overrides: Record<string, unknown> = {}) => ({
  type: "function_call",
  id: `fc_${slot}`,
  call_id: `call_${slot}`,
  name: "lookup",
  arguments: JSON.stringify({ slot }),
  status: "completed",
  ...overrides,
});
const added = (slot: number, overrides: Record<string, unknown> = {}) => ({
  type: "response.output_item.added",
  output_index: slot,
  item: tool(slot, { arguments: "", status: "in_progress", ...overrides }),
});

describe("Responses terminal tool completion", () => {
  it("does not repeat an anonymous unindexed call after its item-done event", async () => {
    const anonymous = { id: undefined, call_id: undefined };
    const result = await runFixture([
      { ...added(0, anonymous), output_index: undefined },
      { type: "response.output_item.done", item: tool(0, anonymous) },
      completed("resp_anonymous_done", [tool(0, anonymous)]),
    ]);
    expect(result.error).toBeNull();
    expect(result.content).toHaveLength(1);
    expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([
      { type: "toolcall_end", contentIndex: 0 },
    ]);
  });

  it("rejects an anonymous call with no stream or terminal position without completing it", async () => {
    const anonymous = { id: undefined, call_id: undefined };
    const result = await runFixture([
      { ...added(0, anonymous), output_index: undefined },
      { type: "response.output_item.done", item: tool(0, anonymous) },
      completed("resp_no_position", []),
    ]);
    expect(result.error).toBe("Responses stream completed with unresolved tool calls");
    expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([]);
  });

  it.each(["indexed", "identified"])(
    "retains a known %s owner when its done event omits identity",
    async (identity) => {
      const anonymous = { id: undefined, call_id: undefined };
      const result = await runFixture([
        identity === "indexed" ? added(0, anonymous) : { ...added(0), output_index: undefined },
        { type: "response.output_item.done", item: tool(0, anonymous) },
        completed("resp_known_owner", []),
      ]);
      expect(result.error).toBeNull();
      expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([
        { type: "toolcall_end", contentIndex: 0 },
      ]);
    },
  );

  it("rejects an anonymous unindexed done-only call without silently dropping it", async () => {
    const item = tool(0, { id: undefined, call_id: undefined });
    const result = await runFixture([
      { type: "response.output_item.done", item },
      completed("resp_done_only", [item]),
    ]);
    expect(result.error).toBe("Responses stream completed tool call without an output identity");
    expect(result.content).toHaveLength(0);
    expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([]);
  });

  it("does not publish anonymous unindexed completions before ambiguous terminal matching", async () => {
    const anonymous = { id: undefined, call_id: undefined };
    const result = await runFixture([
      { ...added(0, anonymous), output_index: undefined },
      { type: "response.output_item.done", item: tool(0, anonymous) },
      { ...added(1, anonymous), output_index: undefined },
      { type: "response.output_item.done", item: tool(1, anonymous) },
      completed("resp_ambiguous_done", [tool(0), tool(1)]),
    ]);
    expect(result.error).not.toBeNull();
    expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([]);
  });

  it.each(["indexed", "rotated", "unindexed", "anonymous"])(
    "completes a %s call exactly once when its item-done event is missing",
    async (identity) => {
      const anonymous = identity === "anonymous" ? { id: undefined, call_id: undefined } : {};
      const item = tool(0, {
        ...anonymous,
        ...(identity === "rotated" ? { id: "fc_terminal_rotated" } : {}),
        arguments: '{"slot":0,"id":9007199254740993}',
      });
      const result = await runFixture([
        {
          ...added(0, anonymous),
          ...(identity === "unindexed" || identity === "anonymous"
            ? { output_index: undefined }
            : {}),
        },
        completed("resp_missing_done", [item]),
      ]);
      expect(result.error).toBeNull();
      expect(result.stopReason).toBe("toolUse");
      expect(result.events).toEqual([
        { type: "toolcall_start", contentIndex: 0 },
        { type: "toolcall_end", contentIndex: 0 },
      ]);
      expect(result.content).toEqual([
        {
          type: "toolCall",
          id:
            identity === "anonymous"
              ? "call_<generated>"
              : `call_0|${identity === "rotated" ? "fc_terminal_rotated" : "fc_0"}`,
          name: "lookup",
          arguments: { slot: 0, id: "9007199254740993" },
          partialJson: false,
        },
      ]);
    },
  );

  it("does not adopt an unindexed anonymous call into an already completed position", async () => {
    const anonymous = { id: undefined, call_id: undefined };
    const result = await runFixture([
      { type: "response.output_item.done", output_index: 0, item: tool(0, anonymous) },
      { ...added(1, anonymous), output_index: undefined },
      completed("resp_anonymous", [tool(0, anonymous), tool(1, anonymous)]),
    ]);
    expect(result.error).toBeNull();
    expect(
      result.content.map((block) => (block.type === "toolCall" ? block.arguments : null)),
    ).toEqual([{ slot: 0 }, { slot: 1 }]);
    expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([
      { type: "toolcall_end", contentIndex: 0 },
      { type: "toolcall_end", contentIndex: 1 },
    ]);
  });

  it.each([
    ["malformed arguments", { arguments: '{"slot":' }],
    ["non-object arguments", { arguments: "[]" }],
    ["incomplete status", { status: "incomplete" }],
    ["changed name", { name: "delete_record" }],
    ["changed call identity", { call_id: "call_conflicting" }],
  ])(
    "rejects a terminal batch with later %s before any tool completes",
    async (_name, override) => {
      const result = await runFixture([
        added(0),
        added(1),
        completed("resp_invalid_batch", [tool(0), tool(1, override)]),
      ]);
      expect(result.error).not.toBeNull();
      expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([]);
    },
  );

  it("rejects a changed completed call identity before another active call completes", async () => {
    const result = await runFixture([
      { type: "response.output_item.done", output_index: 0, item: tool(0) },
      added(1),
      completed("resp_completed_conflict", [tool(0, { call_id: "call_conflicting" }), tool(1)]),
    ]);
    expect(result.error).toBe("Responses stream changed output item identity");
    expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([
      { type: "toolcall_end", contentIndex: 0 },
    ]);
  });

  it.each([
    ["missing call", []],
    ["duplicate call", [tool(0), tool(0)]],
    ["unmatched call", [tool(0, { call_id: "call_other" })]],
  ])("rejects a terminal %s without completing the active call", async (_name, items) => {
    const result = await runFixture([added(0), completed("resp_unresolved", items)]);
    expect(result.error).not.toBeNull();
    expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([]);
  });

  it("never completes active tools from an incomplete response", async () => {
    const result = await runFixture([
      added(0),
      {
        type: "response.incomplete",
        response: { id: "resp_incomplete", status: "incomplete", output: [tool(0)] },
      },
    ]);
    expect(result.error).toBe("Responses stream completed with unresolved tool calls");
    expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([]);
  });

  it.each([1, 2])(
    "rejects %i anonymous unindexed calls with ambiguous terminal positions",
    async (count) => {
      const result = await runFixture([
        ...Array.from({ length: count }, (_, slot) => ({
          ...added(slot, { id: undefined, call_id: undefined }),
          output_index: undefined,
        })),
        completed("resp_ambiguous", [tool(0), tool(1)]),
      ]);
      expect(result.error).not.toBeNull();
      expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([]);
    },
  );

  it("completes indexed anonymous and terminal-only calls without duplicate callbacks", async () => {
    const result = await runFixture([
      added(0, { id: undefined, call_id: undefined }),
      completed("resp_indexed_and_new", [tool(0), tool(1)]),
    ]);
    expect(result.error).toBeNull();
    expect(result.content).toHaveLength(2);
    expect(result.events.filter((event) => event.type === "toolcall_end")).toEqual([
      { type: "toolcall_end", contentIndex: 0 },
      { type: "toolcall_end", contentIndex: 1 },
    ]);
  });
});
