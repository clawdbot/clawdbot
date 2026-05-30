/**
 * Nested List Rendering Tests
 *
 * This test file documents and validates the expected behavior for nested lists
 * when rendering Markdown to plain text.
 *
 * ## Expected Plain Text Behavior
 *
 * Per CommonMark spec, nested lists create a hierarchical structure. When rendering
 * to plain text for messaging platforms, we expect:
 *
 * 1. **Indentation**: Each nesting level adds 2 spaces of indentation
 * 2. **Bullet markers**: Bullet lists use "•" (Unicode bullet)
 * 3. **Ordered markers**: Ordered lists use "N. " format
 * 4. **Line endings**: Each list item ends with a single newline
 * 5. **List termination**: A trailing newline after the entire list (for top-level only)
 *
 * ## markdown-it Token Sequence
 *
 * For nested lists, markdown-it emits tokens in this order:
 * - bullet_list_open (outer)
 *   - list_item_open
 *     - paragraph_open (hidden=true for tight lists)
 *       - inline (with text children)
 *     - paragraph_close
 *     - bullet_list_open (nested)
 *       - list_item_open
 *         - paragraph_open
 *           - inline
 *         - paragraph_close
 *       - list_item_close
 *     - bullet_list_close
 *   - list_item_close
 * - bullet_list_close
 *
 * The key insight is that nested lists appear INSIDE the parent list_item,
 * between the paragraph and the list_item_close.
 */

import { describe, it, expect } from "vitest";
import { markdownToIR } from "./ir.js";

describe("Nested Lists - 2 Level Nesting", () => {
  it("renders bullet items nested inside bullet items with proper indentation", () => {
    const input = `- Item 1
  - Nested 1.1
  - Nested 1.2
- Item 2`;

    const result = markdownToIR(input);

    // Expected output:
    // • Item 1
    //   • Nested 1.1
    //   • Nested 1.2
    // • Item 2
    // Note: markdownToIR trims trailing whitespace, so no final newline
    const expected = `• Item 1
  • Nested 1.1
  • Nested 1.2
• Item 2`;

    expect(result.text).toBe(expected);
  });

  it("renders ordered items nested inside bullet items", () => {
    const input = `- Bullet item
  1. Ordered sub-item 1
  2. Ordered sub-item 2
- Another bullet`;

    const result = markdownToIR(input);

    // Expected output:
    // • Bullet item
    //   1. Ordered sub-item 1
    //   2. Ordered sub-item 2
    // • Another bullet
    const expected = `• Bullet item
  1. Ordered sub-item 1
  2. Ordered sub-item 2
• Another bullet`;

    expect(result.text).toBe(expected);
  });

  it("renders bullet items nested inside ordered items", () => {
    const input = `1. Ordered 1
   - Bullet sub 1
   - Bullet sub 2
2. Ordered 2`;

    const result = markdownToIR(input);

    // Expected output:
    // 1. Ordered 1
    //   • Bullet sub 1
    //   • Bullet sub 2
    // 2. Ordered 2
    const expected = `1. Ordered 1
  • Bullet sub 1
  • Bullet sub 2
2. Ordered 2`;

    expect(result.text).toBe(expected);
  });

  it("renders ordered items nested inside ordered items", () => {
    const input = `1. First
   1. Sub-first
   2. Sub-second
2. Second`;

    const result = markdownToIR(input);

    const expected = `1. First
  1. Sub-first
  2. Sub-second
2. Second`;

    expect(result.text).toBe(expected);
  });
});

describe("Nested Lists - 3+ Level Deep Nesting", () => {
  it("renders 3 levels of bullet nesting", () => {
    const input = `- Level 1
  - Level 2
    - Level 3
- Back to 1`;

    const result = markdownToIR(input);

    // Expected output with progressive indentation:
    // • Level 1
    //   • Level 2
    //     • Level 3
    // • Back to 1
    const expected = `• Level 1
  • Level 2
    • Level 3
• Back to 1`;

    expect(result.text).toBe(expected);
  });

  it("renders 4 levels of bullet nesting", () => {
    const input = `- L1
  - L2
    - L3
      - L4
- Back`;

    const result = markdownToIR(input);

    const expected = `• L1
  • L2
    • L3
      • L4
• Back`;

    expect(result.text).toBe(expected);
  });

  it("renders 3 levels with multiple items at each level", () => {
    const input = `- A1
  - B1
    - C1
    - C2
  - B2
- A2`;

    const result = markdownToIR(input);

    const expected = `• A1
  • B1
    • C1
    • C2
  • B2
• A2`;

    expect(result.text).toBe(expected);
  });
});

describe("Nested Lists - Mixed Nesting", () => {
  it("renders complex mixed nesting (bullet > ordered > bullet)", () => {
    const input = `- Bullet 1
  1. Ordered 1.1
     - Deep bullet
  2. Ordered 1.2
- Bullet 2`;

    const result = markdownToIR(input);

    const expected = `• Bullet 1
  1. Ordered 1.1
    • Deep bullet
  2. Ordered 1.2
• Bullet 2`;

    expect(result.text).toBe(expected);
  });

  it("renders ordered > bullet > ordered nesting", () => {
    const input = `1. First
   - Sub bullet
     1. Deep ordered
   - Another bullet
2. Second`;

    const result = markdownToIR(input);

    const expected = `1. First
  • Sub bullet
    1. Deep ordered
  • Another bullet
2. Second`;

    expect(result.text).toBe(expected);
  });
});

describe("Nested Lists - Newline Handling", () => {
  it("does not produce triple newlines in nested lists", () => {
    const input = `- Item 1
  - Nested
- Item 2`;

    const result = markdownToIR(input);
    expect(result.text).not.toContain("\n\n\n");
  });

  it("does not produce double newlines between nested items", () => {
    const input = `- A
  - B
  - C
- D`;

    const result = markdownToIR(input);

    // Between B and C there should be exactly one newline
    expect(result.text).toContain("  • B\n  • C");
    expect(result.text).not.toContain("  • B\n\n  • C");
  });

  it("properly terminates top-level list (trimmed output)", () => {
    const input = `- Item 1
  - Nested
- Item 2`;

    const result = markdownToIR(input);

    // markdownToIR trims trailing whitespace, so output should end with Item 2
    // (no trailing newline after trimming)
    expect(result.text).toMatch(/Item 2$/);
    // Should not have excessive newlines before Item 2
    expect(result.text).not.toContain("\n\n• Item 2");
  });
});

describe("Nested Lists - Edge Cases", () => {
  it("handles empty parent with nested items", () => {
    // This is a bit of an edge case - a list item that's just a marker followed by nested content
    const input = `-
  - Nested only
- Normal`;

    const result = markdownToIR(input);

    // Should still render the nested item with proper indentation
    expect(result.text).toContain("  • Nested only");
  });

  it("handles nested list as first child of parent item", () => {
    const input = `- Parent text
  - Child
- Another parent`;

    const result = markdownToIR(input);

    // The child should appear indented under the parent
    expect(result.text).toContain("• Parent text\n  • Child");
  });

  it("handles sibling nested lists at same level", () => {
    const input = `- A
  - A1
- B
  - B1`;

    const result = markdownToIR(input);

    const expected = `• A
  • A1
• B
  • B1`;

    expect(result.text).toBe(expected);
  });
});

describe("list paragraph spacing", () => {
  it("preserves paragraph breaks inside loose bullet list items", () => {
    const input = `- first paragraph

  second paragraph
- next`;

    const result = markdownToIR(input);

    expect(result.text).toBe(`• first paragraph

second paragraph

• next`);
  });

  it("preserves paragraph breaks inside loose ordered list items", () => {
    const input = `1. first paragraph

   second paragraph
2. next`;

    const result = markdownToIR(input);

    expect(result.text).toBe(`1. first paragraph

second paragraph

2. next`);
  });

  it("preserves paragraph breaks inside loose blockquoted list items", () => {
    const input = `> - first paragraph
>
>   second paragraph
> - next`;

    const result = markdownToIR(input);

    expect(result.text).toBe(`• first paragraph

second paragraph

• next`);
  });

  it("does not add triple newlines before loose nested bullet lists", () => {
    const input = `- parent

  - child

- next`;

    const result = markdownToIR(input);

    expect(result.text).toBe(`• parent

  • child
• next`);
    expect(result.text).not.toContain("\n\n\n");
  });

  it("does not add triple newlines before loose nested ordered lists", () => {
    const input = `1. parent

   1. child

2. next`;

    const result = markdownToIR(input);

    expect(result.text).toBe(`1. parent

  1. child
2. next`);
    expect(result.text).not.toContain("\n\n\n");
  });

  it("keeps tight heading list items single-spaced", () => {
    const input = `- # A
- # B`;

    const result = markdownToIR(input);

    expect(result.text).toBe(`• A
• B`);
  });

  it("keeps tight blockquote list items single-spaced", () => {
    const input = `- > quote
- next`;

    const result = markdownToIR(input);

    expect(result.text).toBe(`• quote
• next`);
  });

  it("adds blank line between bullet list and following paragraph", () => {
    const input = `- item 1
- item 2

Paragraph after`;
    const result = markdownToIR(input);
    // Should have two newlines between "item 2" and "Paragraph"
    expect(result.text).toContain("item 2\n\nParagraph");
  });

  it("adds blank line between ordered list and following paragraph", () => {
    const input = `1. item 1
2. item 2

Paragraph after`;
    const result = markdownToIR(input);
    expect(result.text).toContain("item 2\n\nParagraph");
  });

  it("does not produce triple newlines", () => {
    const input = `- item 1
- item 2

Paragraph after`;
    const result = markdownToIR(input);
    // Should NOT have three consecutive newlines
    expect(result.text).not.toContain("\n\n\n");
  });
});
