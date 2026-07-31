import { describe, expect, it } from "vitest";
import {
  applyReplacements,
  applyReplacementsPreservingUnchangedLines,
  type TextReplacement,
} from "./edit-replacements.js";

// The fuzzy-match pipeline normalizes content with NFKC before matching. NFKC
// can expand characters (ligature ﬁ → "fi") or combine them (e + U+0301 → é),
// so normalized-space offsets differ from original-space offsets within a line.
// These tests ensure replacements applied on original content land on the
// correct byte span even when an NFKC-expanding character precedes the match.

function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      // Strip trailing whitespace per line
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // Smart single quotes → '
      .replace(/[\u2018\u2019]/g, "'")
      // Smart double quotes → "
      .replace(/[\u201C\u201D]/g, '"')
      // En/em dashes → -
      .replace(/[\u2013\u2014]/g, "-")
      // NBSP / figure space / narrow NBSP → regular space
      .replace(/[\u00A0\u2007\u202F]/g, " ")
  );
}

describe("applyReplacementsPreservingUnchangedLines — NFKC offset mapping", () => {
  it("maps replacement offsets correctly when an NFKC-expanding ligature precedes the match on the same line", () => {
    // original content: "ﬁ" (U+FB01) is 1 UTF-16 code unit; NFKC expands to "fi" (2).
    const originalContent = 'const a = "ﬁrst value";\nconst b = "second";\n';
    const baseContent = normalizeForFuzzyMatch(originalContent);

    // The fuzzy matcher reports matchIndex/matchLength in normalized space.
    // "value" begins at normalized offset 15 (after "const a = "ﬁrst " → "first ").
    const matchIndex = baseContent.indexOf("value");
    expect(originalContent[matchIndex]).not.toBe("v"); // proves offsets diverge

    const replacements: TextReplacement[] = [
      { matchIndex, matchLength: "value".length, newText: "replacement" },
    ];

    const result = applyReplacementsPreservingUnchangedLines(
      originalContent,
      baseContent,
      replacements,
    );

    // The replacement must land on "value" in ORIGINAL space, preserving the
    // ligature byte before it.
    expect(result).toBe('const a = "ﬁrst replacement";\nconst b = "second";\n');
  });

  it("maps the match end offset correctly for multi-line matches spanning an NFKC-expanded line", () => {
    const originalContent =
      'const label = "ﬁnal";\nconst keep = "unchanged";\nconst next = "end";\n';
    const baseContent = normalizeForFuzzyMatch(originalContent);

    // Multi-line match: "final";\nconst keep = "unchanged";\nconst next = "end"
    const oldText = 'final";\nconst keep = "unchanged";\nconst next = "end';
    const matchIndex = baseContent.indexOf(oldText);
    expect(matchIndex).toBeGreaterThanOrEqual(0);

    const replacements: TextReplacement[] = [
      {
        matchIndex,
        matchLength: oldText.length,
        newText: 'replaced";\nconst keep = "unchanged";\nconst next = "end',
      },
    ];

    const result = applyReplacementsPreservingUnchangedLines(
      originalContent,
      baseContent,
      replacements,
    );

    // The fuzzy match for ASCII "final" targets the visually-equivalent
    // ligature "ﬁnal" in original space, so the whole span (including the
    // ligature) is replaced. The key assertion is that the multi-line match
    // END maps correctly: no extra bytes from the untouched line are eaten.
    expect(result).toBe(
      'const label = "replaced";\nconst keep = "unchanged";\nconst next = "end";\n',
    );
  });

  it("keeps untouched lines byte-identical when a preceding line contains NFKC expansions", () => {
    const originalContent =
      '// ﬁle header with ligature\nconst untouched = "bytes";\nconst target = "replace me";\n';
    const baseContent = normalizeForFuzzyMatch(originalContent);

    const matchIndex = baseContent.indexOf("replace me");
    const replacements: TextReplacement[] = [
      { matchIndex, matchLength: "replace me".length, newText: "done" },
    ];

    const result = applyReplacementsPreservingUnchangedLines(
      originalContent,
      baseContent,
      replacements,
    );

    // The untouched line must retain its original "ﬁ" ligature byte.
    expect(result).toBe(
      '// ﬁle header with ligature\nconst untouched = "bytes";\nconst target = "done";\n',
    );
  });
});

describe("applyReplacements — basic behavior", () => {
  it("applies replacements in reverse order so offsets stay stable", () => {
    const content = "aaa bbb ccc";
    const replacements: TextReplacement[] = [
      { matchIndex: 0, matchLength: 3, newText: "XXX" },
      { matchIndex: 8, matchLength: 3, newText: "YYY" },
    ];
    expect(applyReplacements(content, replacements)).toBe("XXX bbb YYY");
  });
});
