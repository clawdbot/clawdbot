// Reasoning tag partitioner tests cover splitting reasoning and visible text segments.
import { describe, expect, it } from "vitest";
import {
  createReasoningTagTextPartitioner,
  type ReasoningTagTextDelta,
} from "./reasoning-tag-text-partitioner.js";

describe("createReasoningTagTextPartitioner", () => {
  function collectVisibleMode(input: string, splitPoints: readonly number[]) {
    const partitioner = createReasoningTagTextPartitioner();
    const deltas: ReasoningTagTextDelta[] = [];
    let start = 0;
    for (const end of [...splitPoints, input.length]) {
      deltas.push(...partitioner.pushVisible(input.slice(start, end)));
      start = end;
    }
    deltas.push(...partitioner.flush());
    return {
      text: deltas
        .filter((delta) => delta.kind === "text")
        .map((delta) => delta.text)
        .join(""),
      thinking: deltas
        .filter((delta) => delta.kind === "thinking")
        .map((delta) => delta.text)
        .join(""),
    };
  }

  it.each([
    {
      name: "self-closing tags are depth-neutral",
      input: "Before<thinking/>After",
      expected: { text: "BeforeAfter", thinking: "" },
    },
    {
      name: "adjacent orphan closes keep prior valid output",
      input: "Before<think>x</think></think>After",
      expected: { text: "Before</think>After", thinking: "x" },
    },
    {
      name: "quoted greater-than delimiters do not end tags",
      input: 'Before <think data-x=">">hidden</think> After',
      expected: { text: "Before  After", thinking: "hidden" },
    },
    {
      name: "provider tags retain the previous Unicode whitespace grammar",
      input: "<think\u00a0>hidden</think>After",
      expected: { text: "After", thinking: "hidden" },
    },
    {
      name: "unequal backtick runs do not own reasoning",
      input: "before ```<think>private</think>`` after",
      expected: { text: "before ````` after", thinking: "private" },
    },
    {
      name: "a closing backtick run is not stable before its following byte",
      input: "`<think>x</think> ```a```",
      expected: { text: "` ```a```", thinking: "x" },
    },
    {
      name: "a stable code span does not release a later unresolved delimiter",
      input: "    `|\n``<think>x</think>\n``",
      expected: { text: "    `|\n``<think>x</think>\n``", thinking: "" },
    },
    {
      name: "a stable inline span does not carry code certainty across a new block",
      input: "`x`\n>     ~~~<think>x</think>- <thinking/>\n\n",
      expected: {
        text: "`x`\n>     ~~~<think>x</think>- <thinking/>\n\n",
        thinking: "",
      },
    },
    {
      name: "tag release retains a partial indentation prefix for the next chunk",
      input: "\na<thinking/>\n\n\n    ~~~<thinking/>- \n",
      expected: { text: "\na\n\n\n    ~~~<thinking/>- \n", thinking: "" },
    },
    {
      name: "a lone carriage return invalidates same-line code certainty",
      input: "a<thinking/>\r\r    <think>x</think>",
      expected: { text: "a\r\r    <think>x</think>", thinking: "" },
    },
    {
      name: "one CRLF is not mistaken for a blank block boundary",
      input: "a\r\n    <think>x</think>",
      expected: { text: "a\r\n    ", thinking: "x" },
    },
    {
      name: "compaction retains context for a following empty list item",
      input: "    `\n\n-\n      <think>x</think>",
      expected: { text: "    `\n\n-\n      ", thinking: "x" },
    },
    {
      name: "paragraph-to-list transitions end inline code",
      input: "Paragraph `literal\n- <think>private</think> `visible",
      expected: { text: "Paragraph `literal\n-  `visible", thinking: "private" },
    },
    {
      name: "soft line breaks retain inline-code ownership",
      input: "Paragraph `literal\ncontinued <think>example</think>` after",
      expected: {
        text: "Paragraph `literal\ncontinued <think>example</think>` after",
        thinking: "",
      },
    },
    {
      name: "fast-path tags stop before later inline code",
      input: "<thinking/> text `<think>literal</think>`",
      expected: { text: " text `<think>literal</think>`", thinking: "" },
    },
    {
      name: "fast-path tags stop before newline-owned code",
      input: "- aa <thinking/>\n\n1.       <think>literal</think>",
      expected: {
        text: "- aa \n\n1.       <think>literal</think>",
        thinking: "",
      },
    },
    {
      name: "blockquote inline code retains its container context",
      input: "> Before `<think>literal</think>\n> after` tail",
      expected: {
        text: "> Before `<think>literal</think>\n> after` tail",
        thinking: "",
      },
    },
    {
      name: "list-item inline code retains its container context",
      input: "- Before `\n  <think>literal</think>\n  after` tail",
      expected: {
        text: "- Before `\n  <think>literal</think>\n  after` tail",
        thinking: "",
      },
    },
    {
      name: "list continuation indentation retains its container context",
      input: "- item\n\n    <think>private</think>\n",
      expected: { text: "- item\n\n    \n", thinking: "private" },
    },
    {
      name: "blockquote fences preserve literal tags",
      input: "> ```xml\n> <think>literal</think>\n> ```\n> tail",
      expected: {
        text: "> ```xml\n> <think>literal</think>\n> ```\n> tail",
        thinking: "",
      },
    },
    {
      name: "blockquote-relative indented code preserves literal tags",
      input: ">     <think>literal</think>",
      expected: { text: ">     <think>literal</think>", thinking: "" },
    },
    {
      name: "list-owned tilde fences preserve literal tags",
      input: "- ~~~xml\n  <think>literal</think>\n  ~~~\n",
      expected: {
        text: "- ~~~xml\n  <think>literal</think>\n  ~~~\n",
        thinking: "",
      },
    },
    {
      name: "indented code preserves literal tags",
      input: "    <think>literal</think>",
      expected: { text: "    <think>literal</think>", thinking: "" },
    },
    {
      name: "late indented-code events do not replay the next paragraph",
      input: "    code\n<think>private</think>\n",
      expected: { text: "    code\n\n", thinking: "private" },
    },
    {
      name: "a closing fence is not reused as context for the next block",
      input: " ```\ncode\n```\n\n<think>private</think>",
      expected: { text: " ```\ncode\n```\n\n", thinking: "private" },
    },
    {
      name: "GFM table code spans preserve literal tags",
      input: "| a | b |\n| - | - |\n| `<think>literal</think>` | y |",
      expected: {
        text: "| a | b |\n| - | - |\n| `<think>literal</think>` | y |",
        thinking: "",
      },
    },
    {
      name: "escaped backticks do not own reasoning",
      input: "before \\`<think>private</think>\\` after",
      expected: { text: "before \\`\\` after", thinking: "private" },
    },
    {
      name: "link destinations do not create code spans",
      input: "[label](url`x) <think>private</think> (y`) after",
      expected: { text: "[label](url`x)  (y`) after", thinking: "private" },
    },
    {
      name: "table cells do not share inline-code ownership",
      input: "| A | B |\n| - | - |\n| `x | <think>private</think> |\n| y` | z |",
      expected: {
        text: "| A | B |\n| - | - |\n| `x |  |\n| y` | z |",
        thinking: "private",
      },
    },
  ] as const)("is invariant at every chunk boundary: $name", ({ input, expected }) => {
    expect(collectVisibleMode(input, [])).toEqual(expected);
    for (let split = 0; split <= input.length; split += 1) {
      expect(collectVisibleMode(input, [split])).toEqual(expected);
    }
    expect(
      collectVisibleMode(
        input,
        Array.from({ length: input.length }, (_value, index) => index + 1),
      ),
    ).toEqual(expected);
  });

  it("recovers a byte-streamed 110KB malformed quoted tag without reparsing prefixes", () => {
    const input = `<think data-x="${"x".repeat(110_000)}<think>hidden</think>After`;
    const startedAt = Date.now();
    const result = collectVisibleMode(
      input,
      Array.from({ length: input.length }, (_value, index) => index + 1),
    );

    expect(result.text).not.toContain("hidden");
    expect(result.text.endsWith("After")).toBe(true);
    expect(result.thinking).toBe("hidden");
    expect(Date.now() - startedAt).toBeLessThan(30_000);
  });

  it("keeps newline-heavy malformed-tag recovery linear", () => {
    const input = `<think data-x="${"x\n".repeat(20_000)}<think>hidden</think>After`;
    const startedAt = Date.now();
    const result = collectVisibleMode(
      input,
      Array.from({ length: input.length }, (_value, index) => index + 1),
    );

    expect(result.text).not.toContain("hidden");
    expect(result.text.endsWith("After")).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(30_000);
  });

  it("bounds parser-owned reparsing across many code-bearing blocks", () => {
    const partitioner = createReasoningTagTextPartitioner();
    const startedAt = Date.now();
    const deltas: ReasoningTagTextDelta[] = [];
    for (let index = 0; index < 1_600; index += 1) {
      deltas.push(...partitioner.pushVisible("`literal` <thinking/>\n\n"));
    }
    deltas.push(...partitioner.flush());

    expect(deltas.filter((delta) => delta.kind === "thinking")).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it("does not repeatedly reparse a growing list container", () => {
    const partitioner = createReasoningTagTextPartitioner();
    const startedAt = Date.now();
    const deltas: ReasoningTagTextDelta[] = [...partitioner.pushVisible("- item\n")];
    for (let index = 0; index < 800; index += 1) {
      deltas.push(...partitioner.pushVisible("  `literal`\n\n"));
    }
    deltas.push(...partitioner.flush());

    expect(deltas.filter((delta) => delta.kind === "thinking")).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("does not repeatedly reparse a growing unclosed tilde fence", () => {
    const partitioner = createReasoningTagTextPartitioner();
    const startedAt = Date.now();
    const deltas: ReasoningTagTextDelta[] = [...partitioner.pushVisible("~~~xml\n")];
    for (let index = 0; index < 3_200; index += 1) {
      deltas.push(...partitioner.pushVisible("<thinking/>\n"));
    }
    deltas.push(...partitioner.pushVisible("~~~\ntail"), ...partitioner.flush());

    expect(deltas.filter((delta) => delta.kind === "thinking")).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("compacts repeated blank-terminated ordinary text", () => {
    const partitioner = createReasoningTagTextPartitioner();
    const startedAt = Date.now();
    let emittedLength = 0;
    for (let index = 0; index < 2_000; index += 1) {
      emittedLength += partitioner
        .pushVisible("plain\n\n")
        .reduce((total, delta) => total + delta.text.length, 0);
    }

    expect(emittedLength).toBe(14_000);
    expect(partitioner.hasPending()).toBe(false);
    expect(partitioner.flush()).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("compacts blank-only streams without retaining an empty tree", () => {
    const partitioner = createReasoningTagTextPartitioner();
    const startedAt = Date.now();
    for (let index = 0; index < 5_000; index += 1) {
      expect(partitioner.pushVisible("\n\n")).toEqual([{ kind: "text", text: "\n\n" }]);
    }

    expect(partitioner.hasPending()).toBe(false);
    expect(partitioner.flush()).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("compacts top-level prose after a completed list block", () => {
    const partitioner = createReasoningTagTextPartitioner();
    const startedAt = Date.now();
    let emittedLength = partitioner
      .pushVisible("- item\n\n")
      .reduce((total, delta) => total + delta.text.length, 0);
    for (let index = 0; index < 2_000; index += 1) {
      emittedLength += partitioner
        .pushVisible("plain\n\n")
        .reduce((total, delta) => total + delta.text.length, 0);
    }

    expect(emittedLength).toBe(14_008);
    expect(partitioner.hasPending()).toBe(false);
    expect(partitioner.flush()).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("compacts blank boundaries containing horizontal whitespace", () => {
    const partitioner = createReasoningTagTextPartitioner();
    const startedAt = Date.now();
    let emittedLength = 0;
    for (let index = 0; index < 2_000; index += 1) {
      emittedLength += partitioner
        .pushVisible("plain\n \t\n")
        .reduce((total, delta) => total + delta.text.length, 0);
    }

    expect(emittedLength).toBe(18_000);
    expect(partitioner.hasPending()).toBe(false);
    expect(partitioner.flush()).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

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

  it.each(["<div>visible", "2 < 3\nvisible", "<notreasoning\nvisible"])(
    "streams definitely non-reasoning angle text immediately: %s",
    (input) => {
      const partitioner = createReasoningTagTextPartitioner();

      expect(partitioner.pushVisible(input)).toEqual([{ kind: "text", text: input }]);
      expect(partitioner.flush()).toEqual([]);
    },
  );

  it("streams complete unambiguous reasoning tags without waiting for flush", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("Before<think>x</think>After")).toEqual([
      { kind: "text", text: "Before" },
      { kind: "thinking", text: "x" },
      { kind: "text", text: "After" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("streams a parser-complete inline code span without waiting for flush", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("Use `code` now")).toEqual([
      { kind: "text", text: "Use `code` now" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("continues through a parser-proven tag after a stable inline span", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("Use `code` now <think>x</think>After")).toEqual([
      { kind: "text", text: "Use `code` now " },
      { kind: "thinking", text: "x" },
      { kind: "text", text: "After" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("closes a bounded parse epoch at a later blank block boundary", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("`one` done ")).toEqual([{ kind: "text", text: "`one` done " }]);
    expect(partitioner.pushVisible("`two` done\n\n")).toEqual([
      { kind: "text", text: "`two` done\n\n" },
    ]);
    expect(partitioner.hasPending()).toBe(false);
    expect(partitioner.flush()).toEqual([]);
  });

  it("streams one parser-proven code span inside a retained list", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("- use `code` now")).toEqual([
      { kind: "text", text: "- use `code` now" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("releases an escaped backtick at a completed block boundary", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("Use \\` literally\n\n")).toEqual([
      { kind: "text", text: "Use \\` literally\n\n" },
    ]);
    expect(partitioner.hasPending()).toBe(false);
    expect(partitioner.flush()).toEqual([]);
  });

  it("starts a new bounded parse epoch after a committed flat paragraph prefix", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("Use `code` now")).toEqual([
      { kind: "text", text: "Use `code` now" },
    ]);
    expect(partitioner.pushVisible("<think>x</think>After")).toEqual([
      { kind: "thinking", text: "x" },
      { kind: "text", text: "After" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("retains unresolved link context after releasing a stable code span", () => {
    const partitioner = createReasoningTagTextPartitioner();
    const deltas = [
      ...partitioner.pushVisible("Use `code` now [label]("),
      ...partitioner.pushVisible("url`x) <think>private</think> (y`) after"),
      ...partitioner.flush(),
    ];

    expect(
      deltas
        .filter((delta) => delta.kind === "text")
        .map((delta) => delta.text)
        .join(""),
    ).toBe("Use `code` now [label](url`x)  (y`) after");
    expect(
      deltas
        .filter((delta) => delta.kind === "thinking")
        .map((delta) => delta.text)
        .join(""),
    ).toBe("private");
  });

  it("streams the visible suffix after a multiline reasoning block closes", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("<think>\nprivate\n</think>answer")).toEqual([
      { kind: "thinking", text: "\nprivate\n" },
      { kind: "text", text: "answer" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("streams a split multiline reasoning block when its close arrives", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("<think>\n")).toEqual([]);
    expect(partitioner.pushVisible("secret\n</think>answer")).toEqual([
      { kind: "thinking", text: "\nsecret\n" },
      { kind: "text", text: "answer" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("waits for GFM table lookahead before releasing a header code span", () => {
    const partitioner = createReasoningTagTextPartitioner();
    const deltas = [
      ...partitioner.pushVisible("| `x | <think>private</think> | y` |\n"),
      ...partitioner.pushVisible("| - | - | - |\n"),
      ...partitioner.pushVisible("tail"),
      ...partitioner.flush(),
    ];

    expect(
      deltas
        .filter((delta) => delta.kind === "text")
        .map((delta) => delta.text)
        .join(""),
    ).toBe("| `x |  | y` |\n| - | - | - |\ntail");
    expect(
      deltas
        .filter((delta) => delta.kind === "thinking")
        .map((delta) => delta.text)
        .join(""),
    ).toBe("private");
  });

  it("does not compact an unclosed top-level fence at a blank line", () => {
    const partitioner = createReasoningTagTextPartitioner();
    const input = ["~~~xml\n<think>literal1</think>\n\n", "<think>literal2</think>\n~~~\n", "tail"];
    const deltas = [
      ...partitioner.pushVisible(input[0] ?? ""),
      ...partitioner.pushVisible(input[1] ?? ""),
      ...partitioner.pushVisible(input[2] ?? ""),
      ...partitioner.flush(),
    ];

    expect(
      deltas
        .filter((delta) => delta.kind === "text")
        .map((delta) => delta.text)
        .join(""),
    ).toBe(input.join(""));
    expect(deltas.filter((delta) => delta.kind === "thinking")).toEqual([]);
  });

  it("resolves a reasoning close that arrives after the opening-tag chunk", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("<think>")).toEqual([]);
    expect(partitioner.pushVisible("secret</think>answer")).toEqual([
      { kind: "thinking", text: "secret" },
      { kind: "text", text: "answer" },
    ]);
  });

  it("releases a split tag prefix as soon as its name becomes invalid", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("<thi")).toEqual([]);
    expect(partitioner.pushVisible("x ordinary text")).toEqual([
      { kind: "text", text: "<thix ordinary text" },
    ]);
  });

  it.each([
    { prefix: "<", suffix: "-ordinary text" },
    { prefix: "< ", suffix: "!ordinary\nnext" },
    { prefix: "</", suffix: "!ordinary" },
    { prefix: "<\t", suffix: "&ordinary" },
  ])("releases definitely invalid empty-name prefixes: $prefix$suffix", ({ prefix, suffix }) => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible(prefix)).toEqual([]);
    expect(partitioner.pushVisible(suffix)).toEqual([{ kind: "text", text: `${prefix}${suffix}` }]);
  });

  it("does not replay emitted text when strict mode starts", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("abc")).toEqual([{ kind: "text", text: "abc" }]);
    partitioner.markStrict();
    expect(partitioner.hasPending()).toBe(false);
    expect(partitioner.push("def")).toEqual([]);
    expect(partitioner.flush()).toEqual([{ kind: "text", text: "def" }]);
  });

  it("does not report an empty strict boundary as pending", () => {
    const partitioner = createReasoningTagTextPartitioner();

    partitioner.markStrict();
    expect(partitioner.hasPending()).toBe(false);
    expect(partitioner.flush()).toEqual([]);
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

  it("keeps strict orphan-close recovery global across block boundaries", () => {
    const partitioner = createReasoningTagTextPartitioner();
    const deltas = [
      ...partitioner.push("private chain\n\n"),
      ...partitioner.push("</think> Visible answer"),
      ...partitioner.flush(),
    ];

    expect(deltas).toEqual([{ kind: "text", text: " Visible answer" }]);
  });

  it("keeps close tags inside list-owned fences hidden from an outer reasoning block", () => {
    const input = [
      "<think>\n",
      "- ~~~xml\n",
      "  </think> literal close\n",
      "  ~~~\n",
      "still private</think>Visible",
    ].join("");

    expect(collectVisibleMode(input, []).text).toBe("Visible");
    expect(
      collectVisibleMode(
        input,
        Array.from({ length: input.length }, (_value, index) => index + 1),
      ).text,
    ).toBe("Visible");
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

  it("keeps split mm reasoning tags out of visible text", () => {
    const partitioner = createReasoningTagTextPartitioner();
    const deltas = [
      ...partitioner.push("Before <mm:thi"),
      ...partitioner.push("nk>secret</mm:think> after"),
      ...partitioner.flush(),
    ];

    expect(deltas).toEqual([
      { kind: "text", text: "Before " },
      { kind: "thinking", text: "secret" },
      { kind: "text", text: " after" },
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

  it("keeps unclosed trailing tags as visible prose in visible mode", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("Use <think> only in this mode")).toEqual([
      { kind: "text", text: "Use " },
    ]);
    expect(partitioner.flush()).toEqual([{ kind: "text", text: "<think> only in this mode" }]);
  });

  it("reclassifies reasoning tags inside unclosed inline code on final flush", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("Start `unclosed <think>secret</think> end")).toEqual([]);
    expect(partitioner.isInsideReasoning()).toBe(false);
    expect(partitioner.flush()).toEqual([
      { kind: "text", text: "Start `unclosed " },
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

  it("reports pending bytes without speculating about reasoning ownership", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.push("<think>hidden")).toEqual([]);
    expect(partitioner.hasPending()).toBe(true);
    expect(partitioner.isInsideReasoning()).toBe(false);
    expect(partitioner.flush()).toEqual([{ kind: "thinking", text: "hidden" }]);
    expect(partitioner.hasPending()).toBe(false);
    expect(partitioner.isInsideReasoning()).toBe(false);
  });

  it("distinguishes buffered syntax from strict visible text", () => {
    const syntax = createReasoningTagTextPartitioner();
    const visible = createReasoningTagTextPartitioner();

    expect(syntax.pushVisible("Use `<thi")).toEqual([]);
    expect(syntax.hasPendingSyntax()).toBe(true);

    visible.markStrict();
    expect(visible.pushVisible("Interim answer.")).toEqual([]);
    expect(visible.hasPending()).toBe(true);
    expect(visible.hasPendingSyntax()).toBe(false);
  });

  it("accepts later content after an intermediate flush boundary", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("before")).toEqual([{ kind: "text", text: "before" }]);
    expect(partitioner.flush()).toEqual([]);
    expect(partitioner.pushVisible("after")).toEqual([{ kind: "text", text: "after" }]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("keeps a completed nested region private when its outer tag is unclosed", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("<think>outer<think>inner</think>")).toEqual([]);
    expect(partitioner.flush()).toEqual([{ kind: "thinking", text: "outerinner" }]);
  });

  it("never emits nested unclosed internal reflection on flush", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("<thinking>outer<internal>private reflection")).toEqual([]);
    expect(partitioner.flush()).toEqual([]);
  });

  it("never emits closed internal reflection", () => {
    const partitioner = createReasoningTagTextPartitioner();

    expect(partitioner.pushVisible("<internal>private reflection</internal>")).toEqual([]);
    expect(partitioner.flush()).toEqual([]);
  });
});
