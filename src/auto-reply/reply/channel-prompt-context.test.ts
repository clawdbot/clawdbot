// Tests the sanitizer bounds applied to channel-supplied prompt context JSON:
// strings were already capped, but array entry counts and object key counts
// crossed into the prompt unbounded.
import { describe, expect, it } from "vitest";
import { appendChannelPromptContext, formatContextJsonBlock } from "./channel-prompt-context.js";
import { markInboundContextLabel } from "./inbound-context-marker.js";

/** The model-visible context block only, without the base body it is appended to. */
function renderedBlock(rendered: string, base = "hello"): string {
  return rendered.slice(base.length + "\n\n".length);
}

function parseContextJsonBlock(block: string): unknown {
  const json = block.slice(
    block.indexOf("```json\n") + "```json\n".length,
    block.lastIndexOf("\n```"),
  );
  return JSON.parse(json);
}

describe("formatContextJsonBlock", () => {
  it("keeps small arrays and objects intact", () => {
    const payload = {
      label: "group",
      members: ["alice", "bob", "carol"],
      meta: { region: "us-west", tier: 2 },
    };

    expect(parseContextJsonBlock(formatContextJsonBlock("Context:", payload))).toEqual(payload);
  });

  it("bounds oversized arrays and flags the dropped entries", () => {
    const members = Array.from(
      { length: 25 },
      (_, index) => `member-${String(index).padStart(2, "0")}`,
    );
    const block = formatContextJsonBlock("Members:", { members });
    const parsed = parseContextJsonBlock(block) as { members: unknown[] };

    expect(parsed.members).toHaveLength(21);
    expect(parsed.members.slice(0, 20)).toEqual(members.slice(0, 20));
    expect(parsed.members.at(-1)).toBe("…[truncated: 5 more entries]");
    expect(block).not.toContain("member-20");
  });

  it("bounds wide objects and flags the dropped keys", () => {
    const payload = Object.fromEntries(
      Array.from({ length: 55 }, (_, index) => [`key-${String(index).padStart(2, "0")}`, index]),
    );
    const parsed = parseContextJsonBlock(formatContextJsonBlock("Context:", payload)) as Record<
      string,
      unknown
    >;

    expect(Object.keys(parsed)).toHaveLength(51);
    expect(parsed["key-49"]).toBe(49);
    expect("key-50" in parsed).toBe(false);
    expect(parsed["…[truncated: 5 more keys]"]).toBe(true);
  });

  it("applies the bounds at every nesting level", () => {
    const inner = Array.from({ length: 30 }, (_, index) => `item-${index}`);
    const parsed = parseContextJsonBlock(
      formatContextJsonBlock("Context:", { outer: [{ inner }] }),
    ) as { outer: Array<{ inner: unknown[] }> };

    expect(parsed.outer[0]?.inner).toHaveLength(21);
    expect(parsed.outer[0]?.inner.at(-1)).toBe("…[truncated: 10 more entries]");
  });

  it("keeps the existing per-string cap unchanged", () => {
    const parsed = parseContextJsonBlock(
      formatContextJsonBlock("Context:", { body: "x".repeat(5_000) }),
    ) as { body: string };

    expect(parsed.body.length).toBeLessThanOrEqual(2_000);
    expect(parsed.body).toContain("…[truncated]");
  });

  it("bounds the serialized block for a channel directory-sized payload", () => {
    // Reported shape: a channel maps its full contact list (thousands of entries)
    // into structured context, inflating the prompt without any limit.
    const contacts = Array.from({ length: 5_000 }, (_, index) => ({
      id: `contact-${index}`,
      name: `Contact Name ${index}`,
      phone: `+1555${String(index).padStart(7, "0")}`,
    }));
    const block = formatContextJsonBlock("Directory:", { contacts });

    expect(block).toContain("…[truncated: 4980 more entries]");
    expect(block.length).toBeLessThan(10_000);
  });

  it("serializes a normal payload byte-identically to a plain JSON.stringify", () => {
    const payload = {
      label: "group",
      members: ["alice", "bob"],
      meta: { region: "us-west", tier: 2 },
    };

    expect(formatContextJsonBlock("Context:", payload)).toBe(
      ["Context:", "```json", JSON.stringify(payload), "```"].join("\n"),
    );
  });

  it("bounds the cumulative serialized size of a saturated nested payload", () => {
    // Adversarial shape from review: every container passes the per-level caps
    // (50 keys, 20 entries, 2,000-char strings), yet the block would serialize
    // ~2 MB without a cumulative budget.
    const payload = Object.fromEntries(
      Array.from({ length: 50 }, (_k, keyIndex) => [
        `key-${String(keyIndex).padStart(2, "0")}`,
        Array.from(
          { length: 20 },
          (_e, entryIndex) => `value-${keyIndex}-${entryIndex}-${"x".repeat(2_000)}`,
        ),
      ]),
    );
    expect(JSON.stringify(payload).length).toBeGreaterThan(2_000_000);

    const block = formatContextJsonBlock("Context:", payload);

    expect(block.length).toBeLessThanOrEqual(50_000);
    expect(block).toContain("…[truncated: context budget exhausted]");
    expect(() => parseContextJsonBlock(block)).not.toThrow();
  });

  it("cuts many small entries that individually pass the per-container caps", () => {
    const payload = Object.fromEntries(
      Array.from({ length: 50 }, (_g, groupIndex) => [
        `group-${groupIndex}`,
        Object.fromEntries(
          Array.from({ length: 50 }, (_i, itemIndex) => [
            `item-${itemIndex}`,
            `value-${groupIndex}-${itemIndex}`,
          ]),
        ),
      ]),
    );
    expect(JSON.stringify(payload).length).toBeGreaterThan(50_000);

    const block = formatContextJsonBlock("Context:", payload);

    expect(block.length).toBeLessThanOrEqual(50_000);
    expect(block).toContain("…[truncated: context budget exhausted]");
    expect(() => parseContextJsonBlock(block)).not.toThrow();
  });

  it("charges escaped keys by their serialized JSON size", () => {
    // Adversarial shape from review: a key of N raw chars serializes to ~2N
    // chars once quotes and backslashes are escaped. Charging raw key length
    // leaves the counter near 50k while the emitted JSON approaches 100k, and
    // the assembly then accepts that oversized block.
    const payload = Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [
        `${"\\".repeat(400)}${'"q'.repeat(200)}\n${index}`,
        `value-${index}`,
      ]),
    );
    const rawKeyChars = Object.keys(payload).reduce((total, key) => total + key.length, 0);
    const emittedKeyChars = Object.keys(payload).reduce(
      (total, key) => total + JSON.stringify(key).length,
      0,
    );
    expect(rawKeyChars).toBeLessThan(50_000);
    expect(emittedKeyChars).toBeGreaterThan(50_000);

    const block = formatContextJsonBlock("Context:", payload);

    expect(block).toContain("…[truncated: context budget exhausted]");
    expect(block.length).toBeLessThanOrEqual(50_000);
    expect(() => parseContextJsonBlock(block)).not.toThrow();
  });

  it("keeps every rendered block at or below the stated cap, framing included", () => {
    // The budget is only meaningful if it bounds what the model actually sees:
    // the label line, the fences, the newlines join() inserts, and the root
    // container's own punctuation all ship with the payload.
    const shapes: Array<[string, unknown]> = [
      [
        "wide object of wide objects",
        Object.fromEntries(
          Array.from({ length: 50 }, (_g, g) => [
            `group-${g}`,
            Object.fromEntries(
              Array.from({ length: 50 }, (_i, i) => [`item-${i}`, `value-${g}-${i}`]),
            ),
          ]),
        ),
      ],
      [
        "50 keys x 20 entries x 2,000 chars",
        Object.fromEntries(
          Array.from({ length: 50 }, (_k, k) => [
            `key-${k}`,
            Array.from({ length: 20 }, (_e, e) => `value-${k}-${e}-${"x".repeat(2_000)}`),
          ]),
        ),
      ],
      ["root array of oversized rows", Array.from({ length: 20 }, () => "x".repeat(50_000))],
      ["single oversized string root", "x".repeat(500_000)],
    ];

    for (const [name, payload] of shapes) {
      const block = formatContextJsonBlock(
        markInboundContextLabel("Conversation info:"),
        payload as unknown,
      );
      expect(block.length, `${name} exceeded the block cap`).toBeLessThanOrEqual(50_000);
      expect(() => parseContextJsonBlock(block), `${name} emitted invalid JSON`).not.toThrow();
    }
  });

  it("bounds a channel-controlled label and keeps its provenance marker", () => {
    // `entry.label` on a structured-context entry is channel text. It is
    // normalized on the way here but never length-bounded, and the block
    // renders it whole, so the label alone can push the block past the cap the
    // block advertises.
    const label = markInboundContextLabel(`Directory ${"L".repeat(60_000)}:`);
    expect(label.length).toBeGreaterThan(50_000);

    const block = formatContextJsonBlock(label, { a: "b" });

    expect(block.length).toBeLessThanOrEqual(50_000);
    expect(block).toContain("…[truncated]");
    // Strippers key on the trailing marker, not on label text
    // (`inbound-context-marker.ts`), so cutting the label must not cut it off.
    expect(block.split("\n")[0]).toMatch(/⟦openclaw:ctx⟧$/);
    expect(() => parseContextJsonBlock(block)).not.toThrow();
  });

  it("keeps the block within the cap across label sizes", () => {
    // Sizes around the cap: an unreserved label surfaces as an off-by-N overrun
    // exactly where the label alone consumes the budget.
    for (const labelChars of [1_000, 49_900, 50_000, 50_137, 200_000]) {
      const block = formatContextJsonBlock(markInboundContextLabel("L".repeat(labelChars)), {
        a: "b",
      });
      expect(block.length, `${labelChars}-char label exceeded the block cap`).toBeLessThanOrEqual(
        50_000,
      );
      expect(
        () => parseContextJsonBlock(block),
        `${labelChars}-char label emitted invalid JSON`,
      ).not.toThrow();
    }
  });

  it("charges a nested value to the budget once, not during recursion and again on retain", () => {
    // Adversarial shape from review: the recursion debited the shared budget
    // while sanitizing the nested array, then the retained property was
    // charged its full serialized size against the already-reduced budget, so
    // a payload that fits under 50,000 chars lost `payload` entirely.
    const payload = { payload: Array(20).fill("x".repeat(2_000)) as string[] };
    expect(JSON.stringify(payload).length).toBeLessThan(50_000);

    const parsed = parseContextJsonBlock(formatContextJsonBlock("Context:", payload)) as {
      payload: string[];
    };

    expect(parsed.payload).toEqual(payload.payload);
  });

  it("preserves nested array entries when their serialized size fits the budget", () => {
    const payload = Array.from({ length: 4 }, (_object, objectIndex) =>
      Object.fromEntries(
        Array.from({ length: 5 }, (_key, keyIndex) => [
          `key-${objectIndex}-${keyIndex}`,
          "x".repeat(2_000),
        ]),
      ),
    );
    expect(JSON.stringify(payload).length).toBeLessThan(50_000);

    const parsed = parseContextJsonBlock(formatContextJsonBlock("Context:", payload)) as Array<
      Record<string, string> | string
    >;

    expect(parsed.every((entry) => typeof entry === "object")).toBe(true);
    expect(parsed).toEqual(payload);
  });

  it("truncates a nested array candidate that exceeds the remaining budget", () => {
    const payload: string[][] = [
      Array(20).fill("x".repeat(2_000)),
      Array(5).fill("y".repeat(2_000)),
    ];
    expect(JSON.stringify(payload).length).toBeGreaterThan(50_000);

    const block = formatContextJsonBlock("Context:", payload);
    const parsed = parseContextJsonBlock(block) as string[][];

    expect(JSON.stringify(parsed).length).toBeLessThanOrEqual(50_000);
    expect(parsed[0]).toEqual(payload[0]);
    expect(parsed[1]).toEqual([
      ...payload[1]!.slice(0, 4),
      "…[truncated: context budget exhausted]",
    ]);
  });

  it("bounds nesting depth and flags the cut", () => {
    let payload: unknown = "leaf";
    for (let level = 0; level < 12; level++) {
      payload = { nested: payload };
    }

    const block = formatContextJsonBlock("Context:", payload);

    expect(block).toContain("…[truncated: max depth reached]");
    expect(() => parseContextJsonBlock(block)).not.toThrow();
  });

  it("cuts cyclic values at the depth limit and keeps valid JSON", () => {
    const payload: Record<string, unknown> = {};
    payload.self = payload;

    const block = formatContextJsonBlock("Context:", payload);

    expect(block).toContain("…[truncated: max depth reached]");
    expect(() => parseContextJsonBlock(block)).not.toThrow();
  });
});

describe("appendChannelPromptContext", () => {
  it("appends small string entries byte-identically to before", () => {
    expect(appendChannelPromptContext("hello", ["entry one", "entry two"])).toBe(
      "hello\n\nContext: ⟦openclaw:ctx⟧\nentry one\nentry two",
    );
  });

  it("bounds thousands of strings at the shared per-block budget with a marker", () => {
    // Adversarial shape from review: a plugin supplies thousands of 2,000-char
    // strings; the array was normalized and appended to the prompt in full.
    const entries = Array.from(
      { length: 5_000 },
      (_, index) => `entry-${index}-${"x".repeat(2_000)}`,
    );

    const rendered = appendChannelPromptContext("hello", entries);

    expect(rendered).toContain("…[truncated: context budget exhausted]");
    expect(renderedBlock(rendered).length).toBeLessThanOrEqual(50_000);
    expect(rendered).not.toContain("entry-100");
  });

  it("charges delimiters for many short string entries", () => {
    const rendered = appendChannelPromptContext(
      "hello",
      Array.from({ length: 50_000 }, () => "x"),
    );

    expect(rendered).toContain("…[truncated: context budget exhausted]");
    expect(renderedBlock(rendered).length).toBeLessThanOrEqual(50_000);
  });

  it("truncates a single oversized string entry instead of appending it whole", () => {
    const rendered = appendChannelPromptContext("hello", ["x".repeat(500_000)]);

    expect(rendered).toContain("…[truncated]");
    expect(rendered).toContain("…[truncated: context budget exhausted]");
    expect(renderedBlock(rendered).length).toBeLessThanOrEqual(50_000);
  });

  it("keeps the rendered block at the stated cap across delimiter-dominated shapes", () => {
    // One separator is rendered before every kept line and the exhaustion
    // marker needs a line of its own; entry counts near the cap are where an
    // unreserved delimiter shows up as an off-by-N overrun.
    for (const count of [49_900, 49_977, 49_978, 50_000, 120_000]) {
      const rendered = appendChannelPromptContext(
        "hello",
        Array.from({ length: count }, () => "x"),
      );
      const block = renderedBlock(rendered);
      expect(block).toContain("…[truncated: context budget exhausted]");
      expect(block.length, `${count} single-char entries exceeded the cap`).toBeLessThanOrEqual(
        50_000,
      );
    }
  });
});
