// Memory Core tests cover dreaming markdown plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateDreamsFile } from "./dreaming-dreams-file.js";
import { writeDailyDreamingPhaseBlock, writeDeepDreamingReport } from "./dreaming-markdown.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const MEMORY_DREAMING_MARKDOWN_MAX_BYTES = 16 * 1024 * 1024;
const EXPECTS_POSIX_FILE_MODE = process.platform !== "win32";
const { createTempWorkspace } = createMemoryCoreTestHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

async function expectPathMissing(targetPath: string): Promise<void> {
  const error = await fs.access(targetPath).then(
    () => undefined,
    (accessError: unknown) => accessError,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
}

function requireInlinePath(result: { inlinePath?: string }): string {
  if (!result.inlinePath) {
    throw new Error("Expected inline dreaming markdown path");
  }
  return result.inlinePath;
}

function requireReportPath(reportPath: string | undefined): string {
  if (!reportPath) {
    throw new Error("Expected deep dreaming report path");
  }
  return reportPath;
}

describe("dreaming markdown storage", () => {
  const nowMs = Date.parse("2026-04-05T10:00:00Z");
  const timezone = "UTC";

  it("writes inline light dreaming output into the daily memory file", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    const result = await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- Candidate: remember the API key is fake"],
      nowMs,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    const inlinePath = requireInlinePath(result);
    expect(inlinePath).toBe(path.join(workspaceDir, "memory", "2026-04-05.md"));
    const content = await fs.readFile(inlinePath, "utf-8");
    expect(content).toContain("## Light Sleep");
    expect(content).toContain("- Candidate: remember the API key is fake");
  });

  it("preserves default daily-file creation permissions", async () => {
    if (!EXPECTS_POSIX_FILE_MODE) {
      return;
    }
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-mode-");

    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- Candidate: default file mode"],
      nowMs,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    const inlinePath = path.join(workspaceDir, "memory", "2026-04-05.md");
    const expectedMode = 0o600;
    expect((await fs.stat(inlinePath)).mode & 0o777).toBe(expectedMode);
  });

  it("falls back when the injected timestamp is outside Date range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 30, 12, 0, 0));
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    const result = await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- Candidate: bounded fallback"],
      nowMs: 8_640_000_000_000_001,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    expect(requireInlinePath(result)).toBe(path.join(workspaceDir, "memory", "2026-05-30.md"));
  });

  it("keeps multiple inline phases in the shared daily memory file", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- Candidate: first block"],
      nowMs,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });
    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "rem",
      bodyLines: ["- Theme: `focus` kept surfacing."],
      nowMs,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    const dreamsPath = path.join(workspaceDir, "memory", "2026-04-05.md");
    const content = await fs.readFile(dreamsPath, "utf-8");
    expect(content).toContain("## Light Sleep");
    expect(content).toContain("## REM Sleep");
    expect(content).toContain("- Candidate: first block");
    expect(content).toContain("- Theme: `focus` kept surfacing.");
  });

  it("keeps daily phase output separate from lowercase dreams.md diaries", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const lowercasePath = path.join(workspaceDir, "dreams.md");
    await fs.writeFile(lowercasePath, "# Scratch\n\n", "utf-8");

    const result = await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "rem",
      bodyLines: ["- Theme: `glacier` kept surfacing."],
      nowMs,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    const inlinePath = requireInlinePath(result);
    expect(inlinePath).toBe(path.join(workspaceDir, "memory", "2026-04-05.md"));
    const content = await fs.readFile(inlinePath, "utf-8");
    expect(content).toContain("## REM Sleep");
    expect(content).toContain("- Theme: `glacier` kept surfacing.");
    await expect(fs.readFile(lowercasePath, "utf-8")).resolves.toBe("# Scratch\n\n");
  });

  it("updates oversized daily memory files without reading the whole file", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const inlinePath = path.join(workspaceDir, "memory", "2026-04-05.md");
    const startMarker = "<!-- openclaw:dreaming:light:start -->";
    const endMarker = "<!-- openclaw:dreaming:light:end -->";
    const body = "- Candidate: large file update";
    await fs.mkdir(path.dirname(inlinePath), { recursive: true });
    const original = `${[
      "# Daily Memory",
      "",
      "A".repeat(MEMORY_DREAMING_MARKDOWN_MAX_BYTES),
      "",
      "## Light Sleep",
      startMarker,
      "- Old candidate",
      endMarker,
    ].join("\n")}Unmanaged note stays.`;
    await fs.writeFile(inlinePath, original, "utf-8");

    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: [body],
      nowMs,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    const content = await fs.readFile(inlinePath, "utf-8");
    expect(content).toBe(
      withTrailingNewline(
        replaceManagedMarkdownBlock({
          original,
          heading: "## Light Sleep",
          startMarker,
          endMarker,
          body,
        }),
      ),
    );
    expect(content).toContain("A".repeat(1024));
    expect(content).toContain("Unmanaged note stays.");
    expect(content).toContain(body);
    expect(content).not.toContain("- Old candidate");
  });

  it("commits oversized streaming replacements through the root-safe writer", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const inlinePath = path.join(workspaceDir, "memory", "2026-04-05.md");
    const startMarker = "<!-- openclaw:dreaming:light:start -->";
    const endMarker = "<!-- openclaw:dreaming:light:end -->";
    const body = "- Candidate: durable streaming update";
    await fs.mkdir(path.dirname(inlinePath), { recursive: true });
    await fs.writeFile(
      inlinePath,
      [
        "# Daily Memory",
        "",
        "A".repeat(MEMORY_DREAMING_MARKDOWN_MAX_BYTES),
        "",
        "## Light Sleep",
        startMarker,
        "- Old candidate",
        endMarker,
        "Tail stays.",
      ].join("\n"),
      "utf-8",
    );

    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: [body],
      nowMs,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    const content = await fs.readFile(inlinePath, "utf-8");
    expect(content).toContain(body);
    expect(content).not.toContain("- Old candidate");
    expect(content).toContain("Tail stays.");
  });

  it("preserves canonical replacement with an unbounded heading separator", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const inlinePath = path.join(workspaceDir, "memory", "2026-04-05.md");
    const startMarker = "<!-- openclaw:dreaming:light:start -->";
    const endMarker = "<!-- openclaw:dreaming:light:end -->";
    const body = "- Candidate: long heading separator update";
    const headingSeparator = `${" ".repeat(128 * 1_024)}\r\n${"\t\n".repeat(8_192)}${"\t".repeat(128 * 1_024)}`;
    await fs.mkdir(path.dirname(inlinePath), { recursive: true });
    const original = [
      "# Daily Memory",
      "",
      "A".repeat(MEMORY_DREAMING_MARKDOWN_MAX_BYTES),
      "",
      `## Light Sleep${headingSeparator}${startMarker}`,
      "- Old candidate",
      endMarker,
      "Tail stays.",
    ].join("\n");
    await fs.writeFile(inlinePath, original, "utf-8");

    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: [body],
      nowMs,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    const content = await fs.readFile(inlinePath, "utf-8");
    expect(content).toBe(
      withTrailingNewline(
        replaceManagedMarkdownBlock({
          original,
          heading: "## Light Sleep",
          startMarker,
          endMarker,
          body,
        }),
      ),
    );
    expect(content).toContain("Tail stays.");
    expect(content).toContain(body);
    expect(content).not.toContain("- Old candidate");
    expect(content.match(new RegExp(startMarker, "g"))).toHaveLength(1);
  });

  it("keeps a trailing newline when an oversized managed block ends at EOF", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const inlinePath = path.join(workspaceDir, "memory", "2026-04-05.md");
    await fs.mkdir(path.dirname(inlinePath), { recursive: true });
    await fs.writeFile(
      inlinePath,
      [
        "# Daily Memory",
        "",
        "A".repeat(MEMORY_DREAMING_MARKDOWN_MAX_BYTES),
        "",
        "## Light Sleep",
        "<!-- openclaw:dreaming:light:start -->",
        "- Old candidate",
        "<!-- openclaw:dreaming:light:end -->",
      ].join("\n"),
      "utf-8",
    );

    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- Candidate: EOF newline update"],
      nowMs,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    const content = await fs.readFile(inlinePath, "utf-8");
    expect(content).toContain("- Candidate: EOF newline update");
    expect(content).not.toContain("- Old candidate");
    expect(content.endsWith("<!-- openclaw:dreaming:light:end -->\n")).toBe(true);
  });

  it("preserves bare managed markers without the heading in oversized files", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const inlinePath = path.join(workspaceDir, "memory", "2026-04-05.md");
    await fs.mkdir(path.dirname(inlinePath), { recursive: true });
    await fs.writeFile(
      inlinePath,
      [
        "# Daily Memory",
        "",
        "A".repeat(MEMORY_DREAMING_MARKDOWN_MAX_BYTES),
        "",
        "<!-- openclaw:dreaming:light:start -->",
        "- User-owned bare block.",
        "<!-- openclaw:dreaming:light:end -->",
        "",
        "## Light Sleep",
        "<!-- openclaw:dreaming:light:start -->",
        "- Old candidate",
        "<!-- openclaw:dreaming:light:end -->",
        "",
        "Tail stays.",
        "",
      ].join("\n"),
      "utf-8",
    );

    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- Candidate: bare marker parity update"],
      nowMs,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    const content = await fs.readFile(inlinePath, "utf-8");
    expect(content).toContain("- User-owned bare block.");
    expect(content).toContain("Tail stays.");
    expect(content).toContain("- Candidate: bare marker parity update");
    expect(content).not.toContain("- Old candidate");
    expect(content.match(/<!-- openclaw:dreaming:light:start -->/g)).toHaveLength(2);
    expect(content.match(/<!-- openclaw:dreaming:light:end -->/g)).toHaveLength(2);
  });

  it("collapses whitespace-separated managed blocks in oversized daily files", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const inlinePath = path.join(workspaceDir, "memory", "2026-04-05.md");
    await fs.mkdir(path.dirname(inlinePath), { recursive: true });
    const startMarker = "<!-- openclaw:dreaming:light:start -->";
    const endMarker = "<!-- openclaw:dreaming:light:end -->";
    const body = "- Candidate: whitespace separator update";
    const original = [
      "# Daily Memory",
      "",
      "A".repeat(MEMORY_DREAMING_MARKDOWN_MAX_BYTES),
      "",
      "## Light Sleep",
      "  ",
      startMarker,
      "- Old candidate",
      endMarker,
      " \t\n".repeat(3_000),
      "## Light Sleep",
      startMarker,
      "- Duplicate old candidate",
      endMarker,
      "",
      "Tail stays.",
      "",
    ].join("\n");
    await fs.writeFile(inlinePath, original, "utf-8");

    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: [body],
      nowMs,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    const content = await fs.readFile(inlinePath, "utf-8");
    expect(content).toBe(
      withTrailingNewline(
        replaceManagedMarkdownBlock({
          original,
          heading: "## Light Sleep",
          startMarker,
          endMarker,
          body,
        }),
      ),
    );
    expect(content).toContain("Tail stays.");
    expect(content).toContain(body);
    expect(content).not.toContain("- Old candidate");
    expect(content).not.toContain("- Duplicate old candidate");
    expect(content.match(new RegExp(startMarker, "g"))).toHaveLength(1);
    expect(content.match(new RegExp(endMarker, "g"))).toHaveLength(1);
  });

  it("appends a daily block after an oversized dangling start marker", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const inlinePath = path.join(workspaceDir, "memory", "2026-04-05.md");
    await fs.mkdir(path.dirname(inlinePath), { recursive: true });
    await fs.writeFile(
      inlinePath,
      [
        "# Daily Memory",
        "",
        "A".repeat(MEMORY_DREAMING_MARKDOWN_MAX_BYTES),
        "",
        "## Light Sleep",
        "<!-- openclaw:dreaming:light:start -->",
        "- Incomplete old candidate",
        "",
        "",
      ].join("\n"),
      "utf-8",
    );

    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- Candidate: appended after dangling marker"],
      nowMs,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    const content = await fs.readFile(inlinePath, "utf-8");
    expect(content).toContain("- Incomplete old candidate");
    expect(content).toContain("- Candidate: appended after dangling marker");
    expect(content.match(/<!-- openclaw:dreaming:light:start -->/g)).toHaveLength(2);
    expect(content.match(/<!-- openclaw:dreaming:light:end -->/g)).toHaveLength(1);
    expect(content.endsWith("<!-- openclaw:dreaming:light:end -->\n")).toBe(true);
  });

  it("keeps generic diary writers working for oversized DREAMS.md files", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(
      dreamsPath,
      [
        "# Dream Diary",
        "",
        "C".repeat(MEMORY_DREAMING_MARKDOWN_MAX_BYTES),
        "",
        "Existing diary entry.",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await updateDreamsFile({
      workspaceDir,
      updater: async (existing) => ({
        content: `${existing}\n\nGeneric writer entry stays.`,
        result: { written: 1 },
      }),
    });

    const content = await fs.readFile(dreamsPath, "utf-8");
    expect(result.written).toBe(1);
    expect(content).toContain("C".repeat(1024));
    expect(content).toContain("Existing diary entry.");
    expect(content).toContain("Generic writer entry stays.");
  });

  it("rejects an oversized daily file swapped to a symlink before streaming", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const inlinePath = path.join(workspaceDir, "memory", "2026-04-05.md");
    const originalPath = path.join(workspaceDir, "memory", "2026-04-05.original.md");
    const sensitivePath = path.join(workspaceDir, "sensitive.txt");
    await fs.mkdir(path.dirname(inlinePath), { recursive: true });
    await fs.writeFile(inlinePath, "A".repeat(MEMORY_DREAMING_MARKDOWN_MAX_BYTES + 1), "utf-8");
    await fs.writeFile(sensitivePath, "sensitive fixture\n", "utf-8");

    const originalLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementationOnce(async (target) => {
      const stat = await originalLstat(target);
      await fs.rename(inlinePath, originalPath);
      await fs.symlink(sensitivePath, inlinePath);
      return stat;
    });

    await expect(
      writeDailyDreamingPhaseBlock({
        workspaceDir,
        phase: "light",
        bodyLines: ["- Must not copy the swapped target"],
        nowMs,
        timezone,
        storage: {
          mode: "inline",
          separateReports: false,
        },
      }),
    ).rejects.toThrow();

    await expect(fs.readFile(sensitivePath, "utf-8")).resolves.toBe("sensitive fixture\n");
    await expect(fs.readFile(originalPath, "utf-8")).resolves.not.toContain("sensitive fixture");
  });

  it("preserves an existing daily memory symlink while updating its target", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const inlinePath = path.join(workspaceDir, "memory", "2026-04-05.md");
    const targetPath = path.join(workspaceDir, "memory", "daily-memory-target.md");
    await fs.mkdir(path.dirname(inlinePath), { recursive: true });
    await fs.writeFile(targetPath, "# Existing daily memory\n\nUser note stays.\n", "utf-8");
    await fs.symlink(targetPath, inlinePath);

    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- Candidate: symlink-compatible update"],
      nowMs,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    expect((await fs.lstat(inlinePath)).isSymbolicLink()).toBe(true);
    const content = await fs.readFile(targetPath, "utf-8");
    expect(content).toContain("# Existing daily memory");
    expect(content).toContain("User note stays.");
    expect(content).toContain("- Candidate: symlink-compatible update");
  });

  it("rejects a daily memory symlink whose target is outside the workspace", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const inlinePath = path.join(workspaceDir, "memory", "2026-04-05.md");
    const outsidePath = path.join(
      path.dirname(workspaceDir),
      `${path.basename(workspaceDir)}-outside.md`,
    );
    await fs.mkdir(path.dirname(inlinePath), { recursive: true });
    await fs.writeFile(outsidePath, "outside workspace\n", "utf-8");
    await fs.symlink(outsidePath, inlinePath);

    try {
      await expect(
        writeDailyDreamingPhaseBlock({
          workspaceDir,
          phase: "light",
          bodyLines: ["- Must stay inside the workspace memory directory"],
          nowMs,
          timezone,
          storage: {
            mode: "inline",
            separateReports: false,
          },
        }),
      ).rejects.toThrow("outside workspace memory directory");

      expect((await fs.lstat(inlinePath)).isSymbolicLink()).toBe(true);
      await expect(fs.readFile(outsidePath, "utf-8")).resolves.toBe("outside workspace\n");
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it("still writes deep reports to the per-phase report directory", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    const reportPath = await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- Promoted: durable preference"],
      storage: {
        mode: "separate",
        separateReports: false,
      },
      nowMs: Date.parse("2026-04-05T10:00:00Z"),
      timezone: "UTC",
    });

    const requiredReportPath = requireReportPath(reportPath);
    expect(requiredReportPath).toBe(
      path.join(workspaceDir, "memory", "dreaming", "deep", "2026-04-05.md"),
    );
    const content = await fs.readFile(requiredReportPath, "utf-8");
    expect(content).toContain("# Deep Sleep");
    expect(content).toContain("- Promoted: durable preference");

    const dreamsContent = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(dreamsContent).toContain("## Deep Sleep");
    expect(dreamsContent).toContain("<!-- openclaw:dreaming:deep:start -->");
    expect(dreamsContent).toContain("- Promoted: durable preference");
  });

  it("writes the deep summary to DREAMS.md without a separate report in inline mode", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    const reportPath = await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- Ranked 3 candidate(s) for durable promotion."],
      storage: {
        mode: "inline",
        separateReports: false,
      },
      nowMs: Date.parse("2026-04-05T10:00:00Z"),
      timezone: "UTC",
    });

    expect(reportPath).toBeUndefined();
    await expectPathMissing(path.join(workspaceDir, "memory", "dreaming", "deep", "2026-04-05.md"));
    const dreamsContent = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(dreamsContent).toContain("## Deep Sleep");
    expect(dreamsContent).toContain("- Ranked 3 candidate(s) for durable promotion.");
  });

  it("updates oversized DREAMS.md deep summaries without reading the whole file", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    const startMarker = "<!-- openclaw:dreaming:deep:start -->";
    const endMarker = "<!-- openclaw:dreaming:deep:end -->";
    const body = "- Durable summary updated.";
    const original = `${[
      "# Dream Diary",
      "",
      "B".repeat(MEMORY_DREAMING_MARKDOWN_MAX_BYTES),
      "",
      "## Deep Sleep",
      startMarker,
      "- Old durable summary",
      endMarker,
    ].join("\n")}Diary entry stays.\r`;
    await fs.writeFile(dreamsPath, original, "utf-8");

    await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: [body],
      storage: {
        mode: "inline",
        separateReports: false,
      },
      nowMs,
      timezone,
    });

    const content = await fs.readFile(dreamsPath, "utf-8");
    expect(content).toBe(
      withTrailingNewline(
        replaceManagedMarkdownBlock({
          original,
          heading: "## Deep Sleep",
          startMarker,
          endMarker,
          body,
        }),
      ),
    );
    expect(content.endsWith("Diary entry stays.\r\n")).toBe(true);
    expect(content).toContain("B".repeat(1024));
    expect(content).toContain("Diary entry stays.");
    expect(content).toContain(body);
    expect(content).not.toContain("- Old durable summary");
  });

  it("collapses whitespace-separated managed blocks in oversized DREAMS.md files", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    const startMarker = "<!-- openclaw:dreaming:deep:start -->";
    const endMarker = "<!-- openclaw:dreaming:deep:end -->";
    const body = "- Durable summary updated.";
    const original = [
      "# Dream Diary",
      "",
      "B".repeat(MEMORY_DREAMING_MARKDOWN_MAX_BYTES),
      "",
      "## Deep Sleep",
      " \t ",
      startMarker,
      "- Old durable summary",
      endMarker,
      " \t\r\n\n",
      "## Deep Sleep",
      startMarker,
      "- Duplicate old durable summary",
      endMarker,
      "",
      "Unmanaged note between duplicates stays.",
      "",
      "## Deep Sleep",
      startMarker,
      "- Third old durable summary",
      endMarker,
      "",
      "Diary entry stays.",
      "",
    ].join("\n");
    await fs.writeFile(dreamsPath, original, "utf-8");

    await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: [body],
      storage: {
        mode: "inline",
        separateReports: false,
      },
      nowMs,
      timezone,
    });

    const content = await fs.readFile(dreamsPath, "utf-8");
    expect(content).toBe(
      withTrailingNewline(
        replaceManagedMarkdownBlock({
          original,
          heading: "## Deep Sleep",
          startMarker,
          endMarker,
          body,
        }),
      ),
    );
    expect(content).toContain("Diary entry stays.");
    expect(content).toContain("Unmanaged note between duplicates stays.");
    expect(content).toContain(body);
    expect(content).not.toContain("- Old durable summary");
    expect(content).not.toContain("- Duplicate old durable summary");
    expect(content).not.toContain("- Third old durable summary");
    expect(content.match(new RegExp(startMarker, "g"))).toHaveLength(1);
    expect(content.match(new RegExp(endMarker, "g"))).toHaveLength(1);
  });

  it("appends a deep block after an oversized dangling start marker", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(
      dreamsPath,
      [
        "# Dream Diary",
        "",
        "B".repeat(MEMORY_DREAMING_MARKDOWN_MAX_BYTES),
        "",
        "## Deep Sleep",
        "<!-- openclaw:dreaming:deep:start -->",
        "- Incomplete old durable summary",
        "",
        "",
      ].join("\n"),
      "utf-8",
    );

    await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- Durable summary appended after dangling marker."],
      storage: {
        mode: "inline",
        separateReports: false,
      },
      nowMs,
      timezone,
    });

    const content = await fs.readFile(dreamsPath, "utf-8");
    expect(content).toContain("- Incomplete old durable summary");
    expect(content).toContain("- Durable summary appended after dangling marker.");
    expect(content.match(/<!-- openclaw:dreaming:deep:start -->/g)).toHaveLength(2);
    expect(content.match(/<!-- openclaw:dreaming:deep:end -->/g)).toHaveLength(1);
    expect(content.endsWith("<!-- openclaw:dreaming:deep:end -->\n")).toBe(true);
  });

  it("replaces the managed deep summary while preserving the diary block", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(
      dreamsPath,
      [
        "# Dream Diary",
        "",
        "<!-- openclaw:dreaming:diary:start -->",
        "",
        "---",
        "",
        "*April 4, 2026, 3:00 AM*",
        "",
        "The old diary entry stays.",
        "",
        "<!-- openclaw:dreaming:diary:end -->",
        "",
        "## Deep Sleep",
        "<!-- openclaw:dreaming:deep:start -->",
        "- Old summary.",
        "<!-- openclaw:dreaming:deep:end -->",
        "",
      ].join("\n"),
      "utf-8",
    );

    await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- New summary."],
      storage: {
        mode: "inline",
        separateReports: false,
      },
      nowMs,
      timezone,
    });

    const dreamsContent = await fs.readFile(dreamsPath, "utf-8");
    expect(dreamsContent).toContain("The old diary entry stays.");
    expect(dreamsContent).toContain("- New summary.");
    expect(dreamsContent).not.toContain("- Old summary.");
  });

  it("reuses existing lowercase dreams.md for deep summaries", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const lowercasePath = path.join(workspaceDir, "dreams.md");
    await fs.writeFile(lowercasePath, "# Existing dreams\n", "utf-8");

    await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- Lowercase target."],
      storage: {
        mode: "inline",
        separateReports: false,
      },
      nowMs,
      timezone,
    });

    const dreamsContent = await fs.readFile(lowercasePath, "utf-8");
    expect(dreamsContent).toContain("# Existing dreams");
    expect(dreamsContent).toContain("- Lowercase target.");
  });

  it.each([
    {
      label: "daily inline phase",
      relativePath: path.join("memory", "2026-04-05.md"),
      run: async (workspaceDir: string) =>
        await writeDailyDreamingPhaseBlock({
          workspaceDir,
          phase: "light",
          bodyLines: ["- Candidate: replacement"],
          nowMs,
          timezone,
          storage: { mode: "inline", separateReports: false },
        }),
    },
    {
      label: "separate light report",
      relativePath: path.join("memory", "dreaming", "light", "2026-04-05.md"),
      run: async (workspaceDir: string) =>
        await writeDailyDreamingPhaseBlock({
          workspaceDir,
          phase: "light",
          bodyLines: ["- Candidate: replacement"],
          nowMs,
          timezone,
          storage: { mode: "separate", separateReports: false },
        }),
    },
    {
      label: "separate deep report",
      relativePath: path.join("memory", "dreaming", "deep", "2026-04-05.md"),
      run: async (workspaceDir: string) =>
        await writeDeepDreamingReport({
          workspaceDir,
          bodyLines: ["- Promoted: replacement"],
          nowMs,
          timezone,
          storage: { mode: "separate", separateReports: false },
        }),
    },
  ])("keeps an existing $label when replacement fails", async ({ relativePath, run }) => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-atomic-");
    const targetPath = path.join(workspaceDir, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, "# Previous dreaming artifact\n", "utf-8");
    const priorBytes = await fs.readFile(targetPath);
    const realRename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (
        typeof destination === "string" &&
        path.resolve(destination) === path.resolve(targetPath)
      ) {
        throw Object.assign(new Error("replace failed"), { code: "ENOSPC" });
      }
      await realRename(source, destination);
    });

    await expect(run(workspaceDir)).rejects.toThrow("replace failed");
    await expect(fs.readFile(targetPath)).resolves.toEqual(priorBytes);
    await expect(fs.readdir(path.dirname(targetPath))).resolves.toEqual([
      path.basename(targetPath),
    ]);
  });

  it("refuses to overwrite a symlinked DREAMS.md for deep summaries", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const targetPath = path.join(workspaceDir, "outside.txt");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(targetPath, "outside\n", "utf-8");
    await fs.symlink(targetPath, dreamsPath);

    await expect(
      writeDeepDreamingReport({
        workspaceDir,
        bodyLines: ["- Do not escape workspace."],
        storage: {
          mode: "inline",
          separateReports: false,
        },
        nowMs,
        timezone,
      }),
    ).rejects.toThrow("Refusing to write symlinked DREAMS.md");
    await expect(fs.readFile(targetPath, "utf-8")).resolves.toBe("outside\n");
  });

  it("serializes deep summary updates with an overlapping diary writer", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(
      dreamsPath,
      [
        "# Dream Diary",
        "",
        "## Deep Sleep",
        "<!-- openclaw:dreaming:deep:start -->",
        "- Old durable summary",
        "<!-- openclaw:dreaming:deep:end -->",
        "",
        "Diary entry stays.",
        "",
      ].join("\n"),
      "utf-8",
    );

    let enteredUpdater!: () => void;
    let releaseUpdater!: () => void;
    const enteredUpdaterPromise = new Promise<void>((resolve) => {
      enteredUpdater = resolve;
    });
    const releaseUpdaterPromise = new Promise<void>((resolve) => {
      releaseUpdater = resolve;
    });
    const diaryWrite = updateDreamsFile({
      workspaceDir,
      updater: async (existing, lockedDreamsPath) => {
        enteredUpdater();
        await releaseUpdaterPromise;
        return {
          content: `${existing}\n\n*2026-04-05*\n\nNarrative entry written under the diary lock.`,
          result: { written: 1, lockedDreamsPath },
        };
      },
    });
    await enteredUpdaterPromise;

    const deepWrite = writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- Durable summary updated."],
      storage: {
        mode: "inline",
        separateReports: false,
      },
      nowMs,
      timezone,
    });
    let deepFinished = false;
    void deepWrite.then(() => {
      deepFinished = true;
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(deepFinished).toBe(false);

    releaseUpdater();
    const diaryResult = await diaryWrite;
    await deepWrite;
    expect(diaryResult.written).toBe(1);

    const content = await fs.readFile(dreamsPath, "utf-8");
    expect(content).toContain("- Durable summary updated.");
    expect(content).not.toContain("- Old durable summary");
    expect(content).toContain("Narrative entry written under the diary lock.");
    expect(content).toContain("Diary entry stays.");
  });
});
