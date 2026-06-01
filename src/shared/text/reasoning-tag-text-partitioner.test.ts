import { describe, expect, it } from "vitest";
import { createReasoningTagTextPartitioner } from "./reasoning-tag-text-partitioner.js";

describe("createReasoningTagTextPartitioner", () => {
  it("routes split inline reasoning tags away from visible text", () => {
    const partitioner = createReasoningTagTextPartitioner();
    const deltas = [
      ...partitioner.push("before <thi"),
      ...partitioner.push("nk>hidden"),
      ...partitioner.push("</think> after"),
      ...partitioner.flush(),
    ];

    expect(deltas).toEqual([
      { kind: "text", text: "before " },
      { kind: "thinking", text: "hidden" },
      { kind: "text", text: " after" },
    ]);
  });

  it("keeps unterminated reasoning as thinking on flush", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect([...partitioner.push("visible <reasoning>hidden tail"), ...partitioner.flush()]).toEqual(
      [
        { kind: "text", text: "visible " },
        { kind: "thinking", text: "hidden tail" },
      ],
    );
  });

  it("emits ordinary angle-bracket text immediately", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.push("<div>visible")).toEqual([{ kind: "text", text: "<div>visible" }]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("reports pending partial tags and active reasoning", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.hasPending()).toBe(false);
    expect(partitioner.push("before <thi")).toEqual([{ kind: "text", text: "before " }]);
    expect(partitioner.hasPending()).toBe(true);
    expect(partitioner.push("nk>hidden")).toEqual([{ kind: "thinking", text: "hidden" }]);
    expect(partitioner.hasPending()).toBe(true);
    expect(partitioner.isInsideReasoning()).toBe(true);
    expect(partitioner.push("</think> after")).toEqual([{ kind: "text", text: " after" }]);
    expect(partitioner.hasPending()).toBe(false);
    expect(partitioner.isInsideReasoning()).toBe(false);
  });

  it("holds possible reasoning opens in visible mode until they are resolved", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("before <thi")).toEqual([{ kind: "text", text: "before " }]);
    expect(partitioner.push("nk>hidden")).toEqual([{ kind: "thinking", text: "hidden" }]);
  });

  it("strips complete reasoning tags in visible mode", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("Use <think>literal</think> here")).toEqual([
      { kind: "text", text: "Use " },
      { kind: "thinking", text: "literal" },
      { kind: "text", text: " here" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("keeps split reasoning tags with attributes out of visible text", () => {
    const partitioner = createReasoningTagTextPartitioner();
    const deltas = [
      ...partitioner.pushVisible("Before <think "),
      ...partitioner.pushVisible("id='x'>secret</think> after"),
      ...partitioner.flush(),
    ];

    expect(deltas).toEqual([
      { kind: "text", text: "Before " },
      { kind: "thinking", text: "secret" },
      { kind: "text", text: " after" },
    ]);
  });

  it("keeps split antml reasoning tags out of visible text", () => {
    const partitioner = createReasoningTagTextPartitioner();
    const deltas = [
      ...partitioner.pushVisible("Before <antml:reas"),
      ...partitioner.pushVisible("oning>secret</antml:reasoning> after"),
      ...partitioner.flush(),
    ];

    expect(deltas).toEqual([
      { kind: "text", text: "Before " },
      { kind: "thinking", text: "secret" },
      { kind: "text", text: " after" },
    ]);
  });

  it("keeps nested reasoning hidden until the outer tag closes", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(
      partitioner.pushVisible("<think>outer <think>inner</think> still outer</think>visible"),
    ).toEqual([
      { kind: "thinking", text: "outer inner still outer" },
      { kind: "text", text: "visible" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("drops malformed reasoning before orphan close tags in strict mode", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.push("private chain of thought </think> Visible answer")).toEqual([
      { kind: "text", text: " Visible answer" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("keeps unmatched close-tag prose visible in visible mode", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("Use </think> to close the tag")).toEqual([
      { kind: "text", text: "Use </think> to close the tag" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("buffers split orphan close tags until the visible suffix arrives", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.push("private chain of thought </think>")).toEqual([]);
    expect(partitioner.push(" Visible answer")).toEqual([
      { kind: "text", text: " Visible answer" },
    ]);
  });

  it("buffers split orphan close tag prefixes with their hidden prefix", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.push("private chain of thought </thi")).toEqual([]);
    expect(partitioner.push("nk> Visible answer")).toEqual([
      { kind: "text", text: " Visible answer" },
    ]);
  });

  it("keeps close tags inside hidden code fences private", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("<think>\n```ts\nliteral ")).toEqual([]);
    expect(partitioner.pushVisible("</think> still private")).toEqual([]);
    expect(partitioner.flush()).toEqual([
      { kind: "thinking", text: "\n```ts\nliteral </think> still private" },
    ]);
  });

  it("recovers fully wrapped unclosed visible-mode text on flush", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("<think>Visible answer from a malformed local model")).toEqual(
      [],
    );
    expect(partitioner.flush()).toEqual([
      { kind: "text", text: "Visible answer from a malformed local model" },
    ]);
  });

  it("recovers unclosed trailing tags as visible prose in visible mode", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("Use <think> only in this mode")).toEqual([
      { kind: "text", text: "Use " },
    ]);
    expect(partitioner.flush()).toEqual([{ kind: "text", text: "<think> only in this mode" }]);
  });

  it("does not treat code-span reasoning tag examples as hidden reasoning", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.push("Use `<think>literal</think>` here")).toEqual([
      { kind: "text", text: "Use `<think>literal</think>` here" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("preserves split code-span reasoning tag examples when active routing begins", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("Use `<thi")).toEqual([{ kind: "text", text: "Use `<thi" }]);
    expect(partitioner.push("nk>literal</think>` here")).toEqual([
      { kind: "text", text: "nk>literal</think>` here" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("preserves code-span reasoning tag examples when the closing backtick arrives later", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("Use `<think>literal</think>")).toEqual([
      { kind: "text", text: "Use " },
    ]);
    expect(partitioner.pushVisible("` here")).toEqual([
      { kind: "text", text: "`<think>literal</think>` here" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("preserves code-span reasoning tag examples when the stream splits after the opener", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("Use `")).toEqual([{ kind: "text", text: "Use `" }]);
    expect(partitioner.pushVisible("<think>literal</think>` here")).toEqual([
      { kind: "text", text: "<think>literal</think>` here" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("preserves multi-backtick code-span reasoning tag examples across chunks", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("Use ``<think>")).toEqual([{ kind: "text", text: "Use " }]);
    expect(partitioner.pushVisible("literal</think>`` here")).toEqual([
      { kind: "text", text: "``<think>literal</think>`` here" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("reclassifies reasoning tags inside unclosed inline code on final flush", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("Start `unclosed <think>secret</think> end")).toEqual([
      { kind: "text", text: "Start " },
    ]);
    expect(partitioner.flush()).toEqual([
      { kind: "text", text: "`unclosed " },
      { kind: "thinking", text: "secret" },
      { kind: "text", text: " end" },
    ]);
  });

  it("keeps buffered unclosed reasoning hidden after strict mode is marked", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("<think>secret")).toEqual([]);
    partitioner.markStrict();
    expect(partitioner.flush()).toEqual([{ kind: "thinking", text: "secret" }]);
  });

  it("preserves fenced reasoning tag examples when the stream splits after the fence", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("Example:\n```")).toEqual([
      { kind: "text", text: "Example:\n```" },
    ]);
    expect(partitioner.pushVisible("\n<think>literal</think>\n```\nDone.")).toEqual([
      { kind: "text", text: "\n<think>literal</think>\n```\nDone." },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("preserves fenced reasoning tag examples when the fence marker is split", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("``")).toEqual([]);
    expect(
      partitioner.pushVisible(
        "`xml\n<thinking>literal</thinking>\n```\n<think>secret</think>answer",
      ),
    ).toEqual([
      {
        kind: "text",
        text: "```xml\n<thinking>literal</thinking>\n```\n",
      },
      { kind: "thinking", text: "secret" },
      { kind: "text", text: "answer" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });
});
