// TTS prepare text tests cover text cleanup before speech synthesis.
import { describe, expect, it } from "vitest";
import { stripMarkdown } from "../shared/text/strip-markdown.js";

/**
 * Tests that stripMarkdown (used in the TTS pipeline via maybeApplyTtsToPayload)
 * produces clean text suitable for speech synthesis.
 *
 * The TTS pipeline calls stripMarkdown() before sending text to TTS engines
 * (OpenAI, ElevenLabs, Edge) so that formatting symbols are not read aloud
 * (e.g. "hashtag hashtag hashtag" for ### headers).
 */
describe("TTS text preparation – stripMarkdown", () => {
  it("strips markdown headers before TTS", () => {
    expect(stripMarkdown("### System Design Basics")).toBe("System Design Basics");
    expect(stripMarkdown("## Heading\nSome text")).toBe("Heading\nSome text");
  });

  it("strips bold and italic markers before TTS", () => {
    expect(stripMarkdown("This is **important** and *useful*")).toBe(
      "This is important and useful",
    );
  });

  it("preserves underscores inside words while still stripping italic markers", () => {
    expect(stripMarkdown("here_is_a_message")).toBe("here_is_a_message");
    expect(stripMarkdown("привет_мир_тест")).toBe("привет_мир_тест");
    expect(stripMarkdown("東京_駅_前")).toBe("東京_駅_前");
    expect(stripMarkdown("use foo_bar_baz and _italic_ text")).toBe(
      "use foo_bar_baz and italic text",
    );
  });

  it("strips inline code markers before TTS", () => {
    expect(stripMarkdown("Use `consistent hashing` for distribution")).toBe(
      "Use consistent hashing for distribution",
    );
  });

  it("keeps explicit link destinations readable by default", () => {
    expect(stripMarkdown("Read the [download](https://example.com/file)")).toBe(
      "Read the download (https://example.com/file)",
    );
    expect(
      stripMarkdown("Read the [download](https://example.com/file)", { linkStyle: "label" }),
    ).toBe("Read the download");
  });

  it("handles a typical LLM reply with mixed markdown", () => {
    const input = `## Heading with **bold** and *italic*

> A blockquote with \`code\`

Some ~~deleted~~ content.`;

    const result = stripMarkdown(input);

    expect(result).toBe(`Heading with bold and italic

A blockquote with code

Some deleted content.`);
  });

  it("handles markdown-heavy system design explanation", () => {
    const input = `### B-tree vs LSM-tree

**B-tree** uses _in-place updates_ while **LSM-tree** uses _append-only writes_.

> Key insight: LSM-tree optimizes for write-heavy workloads.

---

Use \`B-tree\` for read-heavy, \`LSM-tree\` for write-heavy.`;

    const result = stripMarkdown(input);

    expect(result).not.toContain("#");
    expect(result).not.toContain("**");
    expect(result).not.toContain("`");
    expect(result).not.toContain(">");
    expect(result).not.toContain("---");
    expect(result).toContain("B-tree vs LSM-tree");
    expect(result).toContain("B-tree uses in-place updates");
  });
});
