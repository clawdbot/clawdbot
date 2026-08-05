// Memory Core tests cover memory budget plugin behavior.
import { describe, expect, it } from "vitest";
import { compactMemoryForBudget, DEFAULT_MEMORY_FILE_MAX_CHARS } from "./memory-budget.js";

const PROMOTION_MARKER_LINE = "<!-- openclaw-memory-promotion:memory/short-term.md#entry -->";

function promotionSection(date: string, sizeChars: number): string {
  const heading = `## Promoted From Short-Term Memory (${date})\n`;
  const marker = `${PROMOTION_MARKER_LINE}\n`;
  const entryPrefix = "- ";
  const padding = "x".repeat(
    Math.max(0, sizeChars - heading.length - marker.length - entryPrefix.length),
  );
  return `${heading}${marker}${entryPrefix}${padding}`;
}

function markerFreeSection(date: string, body: string): string {
  return `## Promoted From Short-Term Memory (${date})\n${body}\n`;
}

function projectGroupedSection(date: string): string {
  return [
    "",
    `## Promoted From Short-Term Memory (${date})`,
    "",
    "### Global",
    "",
    "<!-- openclaw-memory-promotion:memory/short-term.md#global -->",
    `- ${"g".repeat(120)} [score=0.900 signals=4 recalls=4 avg=0.900 source=memory/short-term.md:1-2]`,
    "",
    "### Project: alpha",
    "",
    "<!-- openclaw-memory-promotion:memory/short-term.md#alpha -->",
    `- ${"a".repeat(120)} [score=0.900 signals=4 recalls=4 avg=0.900 source=memory/short-term.md:3-4]`,
    "",
    "",
  ].join("\n");
}

describe("compactMemoryForBudget — bounded MEMORY.md compaction (regression for #73691)", () => {
  it("returns existing memory unchanged when total fits the budget", () => {
    const existing = "# Long-Term Memory\n\nSome content.\n";
    const newSection = "\n## Promoted From Short-Term Memory (2026-04-29)\n- entry\n";
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 1_000,
    });
    expect(result.compacted).toBe(existing);
    expect(result.droppedDates).toEqual([]);
  });

  it("drops the oldest promotion section first when over budget", () => {
    const oldest = promotionSection("2026-04-10", 500);
    const newer = promotionSection("2026-04-20", 500);
    const existing = `${oldest}\n${newer}`;
    const newSection = `\n${promotionSection("2026-04-29", 500)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 1_200,
    });
    expect(result.droppedDates).toEqual(["2026-04-10"]);
    expect(result.compacted).not.toContain("(2026-04-10)");
    expect(result.compacted).toContain("(2026-04-20)");
  });

  it("drops sections in ascending date order regardless of file order", () => {
    // File has sections in non-chronological order; algorithm must drop oldest by date.
    const newer = promotionSection("2026-04-25", 400);
    const oldest = promotionSection("2026-04-10", 400);
    const middle = promotionSection("2026-04-18", 400);
    const existing = `${newer}\n${oldest}\n${middle}`;
    const newSection = `\n${promotionSection("2026-04-29", 400)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 1_300,
    });
    // Drop oldest first; if still over budget, drop next oldest.
    expect(result.droppedDates[0]).toBe("2026-04-10");
    expect(result.compacted).not.toContain("(2026-04-10)");
  });

  it("preserves user-authored content (non-promotion sections)", () => {
    const userSection = "## My Notes\n\nImportant user content I do not want dropped.\n";
    const oldest = promotionSection("2026-04-10", 800);
    const existing = `# Long-Term Memory\n\n${userSection}\n${oldest}`;
    const newSection = `\n${promotionSection("2026-04-29", 600)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 800,
    });
    expect(result.droppedDates).toContain("2026-04-10");
    expect(result.compacted).toContain("## My Notes");
    expect(result.compacted).toContain("Important user content");
    expect(result.compacted).toContain("# Long-Term Memory");
  });

  it("drops every promotion section when budget cannot be satisfied otherwise", () => {
    const existing = [
      promotionSection("2026-04-10", 600),
      promotionSection("2026-04-15", 600),
      promotionSection("2026-04-20", 600),
    ].join("\n");
    const newSection = `\n${promotionSection("2026-04-29", 600)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 700,
    });
    expect(result.droppedDates).toEqual(["2026-04-10", "2026-04-15", "2026-04-20"]);
    expect(result.compacted).not.toContain("Promoted From Short-Term Memory");
  });

  it("returns existing unchanged when the file has no promotion sections (cannot compact)", () => {
    const existing = "# Long-Term Memory\n\nLots of user content here.\n".repeat(50);
    const newSection = `\n${promotionSection("2026-04-29", 200)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 500,
    });
    expect(result.compacted).toBe(existing);
    expect(result.droppedDates).toEqual([]);
  });

  it("treats budgetChars <= 0 as 'no budget' and returns existing unchanged", () => {
    const existing = promotionSection("2026-04-10", 500);
    const newSection = `\n${promotionSection("2026-04-29", 500)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 0,
    });
    expect(result.compacted).toBe(existing);
    expect(result.droppedDates).toEqual([]);
  });

  it("handles empty existing memory cleanly", () => {
    const result = compactMemoryForBudget({
      existingMemory: "",
      newSection: promotionSection("2026-04-29", 500),
      budgetChars: 100,
    });
    expect(result.compacted).toBe("");
    expect(result.droppedDates).toEqual([]);
  });

  it("preserves a non-promotion ## heading sandwiched between promotion sections", () => {
    const existing =
      `${promotionSection("2026-04-10", 400)}\n` +
      "## My Reflections\nMy own notes.\n\n" +
      promotionSection("2026-04-20", 400);
    const newSection = `\n${promotionSection("2026-04-29", 400)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 900,
    });
    expect(result.droppedDates).toContain("2026-04-10");
    expect(result.compacted).toContain("## My Reflections");
    expect(result.compacted).toContain("My own notes.");
  });

  it("does not prepend a spurious leading newline when input starts with a ## heading", () => {
    // Regression for greptile P2 #1: parseMemoryBlocks's flush guard previously
    // pushed an empty preserved block when content started directly with `##`,
    // making compacted output start with an extra `\n`.
    const existing = `${promotionSection("2026-04-10", 200)}\n${promotionSection("2026-04-20", 200)}`;
    const newSection = `\n${promotionSection("2026-04-29", 200)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 500,
    });
    expect(result.compacted.startsWith("\n")).toBe(false);
    expect(result.compacted.startsWith("## Promoted From Short-Term Memory")).toBe(true);
  });

  it("respects writer overhead reserve so on-disk size stays inside the budget", () => {
    // Regression for greptile P2 #2: budget check previously ignored the
    // header (~20 chars) and trailing newline (1 char) the caller adds.
    const existing = `${promotionSection("2026-04-10", 1_000)}\n${promotionSection("2026-04-20", 1_000)}`;
    const newSection = `\n${promotionSection("2026-04-29", 1_000)}`;
    const budget = 2_000;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: budget,
    });
    const headerOverhead = 20; // "# Long-Term Memory\n\n"
    const trailingNewline = 1;
    expect(
      result.compacted.length + newSection.length + headerOverhead + trailingNewline,
    ).toBeLessThanOrEqual(budget);
  });

  it.each([0, 1, 2, 3])(
    "preserves a user `###` section with %i leading spaces under a promotion section",
    (leadingSpaces) => {
      const heading = `${" ".repeat(leadingSpaces)}### Correction (added by me)`;
      const existing =
        `${promotionSection("2026-04-10", 400)}\n` +
        `${heading}\nThe prod DB is db-2.corp.example, NOT db-1.\n\n` +
        promotionSection("2026-04-20", 400);
      const newSection = `\n${promotionSection("2026-04-29", 400)}`;
      const result = compactMemoryForBudget({
        existingMemory: existing,
        newSection,
        budgetChars: 900,
      });
      expect(result.droppedDates).toContain("2026-04-10");
      expect(result.compacted).toContain(heading);
      expect(result.compacted).toContain("The prod DB is db-2.corp.example, NOT db-1.");
    },
  );

  it("preserves a generated-looking block with ambiguous indented content", () => {
    const existing =
      `${promotionSection("2026-04-10", 400)}\n` +
      "    ### Indented user note\n    keep this durable content\n\n" +
      promotionSection("2026-04-20", 400);
    const newSection = `\n${promotionSection("2026-04-29", 400)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 900,
    });
    expect(result.droppedDates).not.toContain("2026-04-10");
    expect(result.compacted).toContain("### Indented user note");
    expect(result.compacted).toContain("keep this durable content");
  });

  it("preserves a user `#` section written after the only promotion section", () => {
    const existing =
      `# Long-Term Memory\n\n${promotionSection("2026-04-10", 800)}\n` +
      "# My Notes\n\nKeep this paragraph.\n";
    const newSection = `\n${promotionSection("2026-04-29", 600)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 800,
    });
    expect(result.droppedDates).toContain("2026-04-10");
    expect(result.compacted).toContain("# My Notes");
    expect(result.compacted).toContain("Keep this paragraph.");
    expect(result.compacted).toContain("# Long-Term Memory");
  });

  it("drops a multi-project promotion section whole, including its `###` project subheadings", () => {
    const existing = `${projectGroupedSection("2026-04-10")}\n${projectGroupedSection("2026-04-20")}`;
    const newSection = `\n${projectGroupedSection("2026-04-29")}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 700,
    });
    expect(result.droppedDates).toEqual(["2026-04-10", "2026-04-20"]);
    expect(result.compacted).not.toContain("### Project: alpha");
    expect(result.compacted).not.toContain("### Global");
    expect(result.compacted).not.toContain("openclaw-memory-promotion");
  });

  it("preserves a user-authored `### Global` heading written under a promotion section", () => {
    const existing =
      `${promotionSection("2026-04-10", 400)}\n` +
      "### Global\n\nMy own global rule, not a promoted entry.\n\n" +
      promotionSection("2026-04-20", 400);
    const newSection = `\n${promotionSection("2026-04-29", 400)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 900,
    });
    expect(result.droppedDates).toContain("2026-04-10");
    expect(result.compacted).toContain("### Global");
    expect(result.compacted).toContain("My own global rule, not a promoted entry.");
  });

  it("preserves a user-authored `### Project:` heading written under a promotion section", () => {
    const existing =
      `${promotionSection("2026-04-10", 400)}\n` +
      "### Project: alpha\n\nAlpha ships on Fridays.\n\n" +
      promotionSection("2026-04-20", 400);
    const newSection = `\n${promotionSection("2026-04-29", 400)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 900,
    });
    expect(result.droppedDates).toContain("2026-04-10");
    expect(result.compacted).toContain("### Project: alpha");
    expect(result.compacted).toContain("Alpha ships on Fridays.");
  });

  it("preserves a tab-delimited user heading written under a promotion section", () => {
    const existing =
      `${promotionSection("2026-04-10", 400)}\n` +
      "###\tCorrection\nThe prod DB is db-2.corp.example, NOT db-1.\n\n" +
      promotionSection("2026-04-20", 400);
    const newSection = `\n${promotionSection("2026-04-29", 400)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 900,
    });
    expect(result.droppedDates).toContain("2026-04-10");
    expect(result.compacted).toContain("###\tCorrection");
    expect(result.compacted).toContain("The prod DB is db-2.corp.example, NOT db-1.");
  });

  it("preserves an empty user heading line written under a promotion section", () => {
    const existing =
      `${promotionSection("2026-04-10", 400)}\n` +
      "###\nNotes I keep under a bare heading.\n\n" +
      promotionSection("2026-04-20", 400);
    const newSection = `\n${promotionSection("2026-04-29", 400)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 900,
    });
    expect(result.droppedDates).toContain("2026-04-10");
    expect(result.compacted).toContain("Notes I keep under a bare heading.");
  });

  it.each(["---", "==="])(
    "preserves a user Setext heading with a `%s` underline under a promotion section",
    (underline) => {
      const existing =
        `${promotionSection("2026-04-10", 400)}\n\n` +
        `My Durable Notes\n${underline}\nKeep this user-authored paragraph.\n\n` +
        promotionSection("2026-04-20", 400);
      const newSection = `\n${promotionSection("2026-04-29", 400)}`;
      const result = compactMemoryForBudget({
        existingMemory: existing,
        newSection,
        budgetChars: 900,
      });
      expect(result.droppedDates).toContain("2026-04-10");
      expect(result.compacted).toContain(`My Durable Notes\n${underline}`);
      expect(result.compacted).toContain("Keep this user-authored paragraph.");
    },
  );

  it("preserves a marker-free section whose heading matches the promotion pattern", () => {
    const existing = `# Long-Term Memory\n\n${markerFreeSection(
      "2026-04-10",
      "USER-AUTHORED: recovery key is paper-copy-17",
    )}`;
    const newSection = `\n${promotionSection("2026-04-29", 600)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 400,
    });
    expect(result.droppedDates).toEqual([]);
    expect(result.compacted).toBe(existing);
  });

  it("drops only a clean generated section beside a marker-free lookalike", () => {
    const userSection = markerFreeSection(
      "2026-04-10",
      "USER-AUTHORED: recovery key is paper-copy-17",
    );
    const existing = `# Long-Term Memory\n\n${userSection}\n${promotionSection("2026-04-20", 600)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection: `\n${promotionSection("2026-04-29", 600)}`,
      budgetChars: 700,
    });
    expect(result.droppedDates).toEqual(["2026-04-20"]);
    expect(result.compacted).toContain("USER-AUTHORED: recovery key is paper-copy-17");
    expect(result.compacted).not.toContain("(2026-04-20)");
  });

  it("preserves a marker-only promotion-shaped block", () => {
    const existing = [
      "## Promoted From Short-Term Memory (2026-04-10)",
      PROMOTION_MARKER_LINE,
      "",
    ].join("\n");
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection: `\n${promotionSection("2026-04-29", 600)}`,
      budgetChars: 400,
    });
    expect(result.droppedDates).toEqual([]);
    expect(result.compacted).toBe(existing);
  });

  it("preserves an entire mixed block when user text follows a generated entry", () => {
    const existing = [
      promotionSection("2026-04-10", 400),
      "",
      "USER-AUTHORED: keep this unheaded durable note.",
      "",
      promotionSection("2026-04-20", 400),
    ].join("\n");
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection: `\n${promotionSection("2026-04-29", 400)}`,
      budgetChars: 900,
    });
    expect(result.droppedDates).toEqual(["2026-04-20"]);
    expect(result.compacted).toContain("(2026-04-10)");
    expect(result.compacted).toContain("USER-AUTHORED: keep this unheaded durable note.");
    expect(result.compacted).not.toContain("(2026-04-20)");
  });

  it("preserves a block with user text between generated entries", () => {
    const existing = [
      "## Promoted From Short-Term Memory (2026-04-10)",
      PROMOTION_MARKER_LINE,
      "- first generated entry",
      "USER-AUTHORED: this line is not owned by either marker.",
      "<!-- openclaw-memory-promotion:memory/short-term.md#second -->",
      "- second generated entry",
      "",
    ].join("\n");
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection: `\n${promotionSection("2026-04-29", 600)}`,
      budgetChars: 400,
    });
    expect(result.droppedDates).toEqual([]);
    expect(result.compacted).toBe(existing);
  });

  it("exposes a sane default budget below the bootstrap injection cap", () => {
    // Bootstrap injection is capped at 12_000 chars per file (see
    // src/agents/embedded-agent-helpers/bootstrap.ts). The MEMORY.md budget
    // must stay strictly below that to leave room for headers and so
    // promoted content keeps reaching new sessions.
    expect(DEFAULT_MEMORY_FILE_MAX_CHARS).toBeLessThan(12_000);
    expect(DEFAULT_MEMORY_FILE_MAX_CHARS).toBeGreaterThan(0);
  });
});
