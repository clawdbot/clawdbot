import { stripMarkdown } from "openclaw/plugin-sdk/text-chunking";
import { describe, expect, it } from "vitest";
import {
  CODE_HEAVY_SPOKEN_FALLBACK,
  isCodeHeavySpeechText,
  normalizeSpeechText,
} from "./speech-text.js";

const speechStripOptions = { linkStyle: "label", mode: "speech" } as const;

describe("speech text normalization", () => {
  it("strips speech-hostile Markdown and decorative punctuation", () => {
    const input = `# Release notes

- Read the [guide](https://example.com/guide)
- Keep the useful detail

| Area | Status |
| --- | --- |
| Talk | Ready |

\`\`\`ts
const concise = true;
\`\`\`

✨ ✨ ✨
Really!!!!!`;

    const result = stripMarkdown(input, speechStripOptions);

    expect(result).toContain("Release notes");
    expect(result).toContain("Read the guide");
    expect(result).not.toContain("•");
    expect(result).not.toContain("https://example.com/guide");
    expect(result).toContain("Talk");
    expect(result).toContain("Status: Ready");
    expect(result).toContain("const concise = true;");
    expect(result).not.toMatch(/[#|`✨]/u);
    expect(result).toContain("Really!");
  });

  it("keeps meaningful numeric prefixes while removing decorative bullets", () => {
    expect(stripMarkdown("404. Not found", speechStripOptions)).toBe("404. Not found");
    expect(stripMarkdown("• item", speechStripOptions)).toBe("item");
  });

  it("falls back when fenced code is at least half of the reply", () => {
    const input = `Brief note.

\`\`\`ts
export function renderAnswer() {
  return "most of this reply is code";
}
\`\`\``;

    expect(isCodeHeavySpeechText(input)).toBe(true);
    expect(normalizeSpeechText(input)).not.toBe(CODE_HEAVY_SPOKEN_FALLBACK);
  });

  it("keeps prose when fenced code is less than half of the reply", () => {
    const input = `This explanation is intentionally long enough to remain the main part of the response. It tells the listener what the example does and why it matters before showing one tiny snippet.

\`\`\`ts
const ready = true;
\`\`\``;

    expect(isCodeHeavySpeechText(input)).toBe(false);
    const result = normalizeSpeechText(input);
    expect(result).toContain("This explanation is intentionally long enough");
    expect(result).toContain("const ready = true;");
  });

  it.each([
    ["a longer closing fence", "```\nconst answer = 42;\n````"],
    ["an unclosed fence", "```\nconst answer = 42;"],
    ["tilde fences", "~~~ts\nconst answer = 42;\n~~~"],
    ["a mismatched marker inside a fence", "```\n~~~\nconst answer = 42;\n```"],
    ["an indented closing fence", "```\nconst answer = 42;\n   ```"],
    ["a blockquoted fence", "> ```\n> const answer = 42;\n> ```"],
    [
      "a two-level list-nested fence",
      '- Outer\n  - Inner\n    ```\n    const detailedAnswer = "this body dominates the reply";\n    ```',
    ],
  ])("detects code-heavy text with %s", (_description, input) => {
    expect(isCodeHeavySpeechText(input)).toBe(true);
  });

  it("keeps blockquoted code and surrounding prose aligned with Markdown stripping", () => {
    const input = `> This explanation is deliberately much longer than the code it introduces, so it remains the reply's main content for speech.
>
> \`\`\`ts
> const ready = true;
> \`\`\``;

    expect(isCodeHeavySpeechText(input)).toBe(false);
    expect(normalizeSpeechText(input)).toContain("This explanation is deliberately much longer");
    expect(normalizeSpeechText(input)).toContain("const ready = true;");
  });

  it("does not count prose after a tab-terminated closing fence as code", () => {
    const input = "```\nx\n```\t\nThis prose follows the code fence and is much longer than it.";

    expect(isCodeHeavySpeechText(input)).toBe(false);
  });
});
