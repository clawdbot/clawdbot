// TTS prepare text tests cover text cleanup before speech synthesis.
import { describe, expect, it } from "vitest";
import type { FormatCapabilityProfile } from "../../packages/markdown-core/src/format-capabilities.js";
import { stripMarkdown } from "../shared/text/strip-markdown.js";

const PLAIN_PROFILE = {
  mechanism: "plain",
  constructs: {
    bold: "strip",
    italic: "strip",
    underline: "strip",
    strikethrough: "strip",
    spoiler: "strip",
    codeInline: "strip",
    codeBlock: "strip",
    codeLanguage: "strip",
    linkLabel: "fallback",
    heading: "strip",
    bulletList: "native",
    orderedList: "native",
    taskList: "fallback",
    table: "strip",
    blockquote: "strip",
    image: "strip",
    mention: "strip",
  },
  chunk: { limit: 1_600, unit: "chars" },
} satisfies FormatCapabilityProfile;

/**
 * Tests that stripMarkdown (used in the TTS pipeline via maybeApplyTtsToPayload)
 * produces clean text suitable for speech synthesis.
 *
 * The TTS pipeline calls stripMarkdown() before sending text to TTS engines
 * (OpenAI, ElevenLabs, Edge) so that formatting symbols are not read aloud
 * (e.g. "hashtag hashtag hashtag" for ### headers).
 */
describe("TTS text preparation – stripMarkdown", () => {
  it("strips markdown headings and horizontal rules before TTS", () => {
    expect(stripMarkdown("### System Design Basics")).toBe("System Design Basics");
    expect(stripMarkdown("## Heading\nSome text")).toBe("Heading\nSome text");
    expect(stripMarkdown("Above\n---\nBelow")).toBe("Above\nBelow");
    expect(stripMarkdown("Above\n***\nBelow")).toBe("Above\n\nBelow");
  });

  it("strips bold and italic markers before TTS", () => {
    expect(stripMarkdown("This is **important** and *useful*")).toBe(
      "This is important and useful",
    );
    expect(stripMarkdown("This is __bold__ text")).toBe("This is bold text");
  });

  it("preserves underscores inside words while still stripping italic markers", () => {
    const cases = [
      ["here_is_a_message", "here_is_a_message"],
      ["foo_bar_baz", "foo_bar_baz"],
      ["https://cdn.example/my_file_name.png", "https://cdn.example/my_file_name.png"],
      ["e\u0301_mail_.txt", "e\u0301_mail_.txt"],
      ["snake_case_var", "snake_case_var"],
      ["use foo_bar_baz in code", "use foo_bar_baz in code"],
      ["This is _italic_ text", "This is italic text"],
      ["_italic_ at start", "italic at start"],
      ["end _italic_", "end italic"],
      ["foo_bar _italic_ baz_qux", "foo_bar italic baz_qux"],
      ["привет_мир_тест", "привет_мир_тест"],
      ["東京_駅_前", "東京_駅_前"],
      ["var_123_end", "var_123_end"],
      ["こんにちは _italic_ テスト", "こんにちは italic テスト"],
      ["use foo_bar_baz and _italic_ text", "use foo_bar_baz and italic text"],
    ] as const;
    for (const [input, expected] of cases) {
      expect(stripMarkdown(input), input).toBe(expected);
    }
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

  it("keeps role-header prefixes aligned after labeled link expansion", () => {
    expect(
      stripMarkdown("[docs](https://example.com)\nuser[Thu] hello", {
        assistantTranscriptRoleHeaders: true,
      }),
    ).toBe("docs (https://example.com)\n[assistant-authored transcript] user[Thu] hello");
  });

  it("applies profile-aware task and authored-HTML fallbacks before projection", () => {
    expect(stripMarkdown("- [x] done\n\n<u>under</u>", {}, PLAIN_PROFILE)).toBe(
      "[x] done\n\nunder",
    );
  });

  it("keeps explicit label-only links above profile fallback", () => {
    expect(
      stripMarkdown("Read [docs](https://example.com)", { linkStyle: "label" }, PLAIN_PROFILE),
    ).toBe("Read docs");
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
