// Tests the sanitizer bounds applied to channel-supplied prompt context JSON:
// strings were already capped, but array entry counts and object key counts
// crossed into the prompt unbounded.
import { describe, expect, it } from "vitest";
import { formatContextJsonBlock } from "./channel-prompt-context.js";

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

    expect(block.length).toBeLessThan(60_000);
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

    expect(block.length).toBeLessThan(60_000);
    expect(block).toContain("…[truncated: context budget exhausted]");
    expect(() => parseContextJsonBlock(block)).not.toThrow();
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
});
