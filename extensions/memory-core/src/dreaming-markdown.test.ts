// Memory Core tests cover dreaming markdown plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeDailyDreamingPhaseBlock, writeDeepDreamingReport } from "./dreaming-markdown.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

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
});
