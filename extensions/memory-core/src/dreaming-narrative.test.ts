import fs from "node:fs/promises";
import path from "node:path";
import {
  RequestScopedSubagentRuntimeError,
  SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE,
} from "openclaw/plugin-sdk/error-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGlobalMap } from "../../../src/shared/global-singleton.js";
import {
  appendNarrativeEntry,
  buildBackfillDiaryEntry,
  buildDiaryEntry,
  buildNarrativePrompt,
  dedupeDreamDiaryEntries,
  extractNarrativeText,
  formatNarrativeDate,
  formatBackfillDiaryDate,
  generateAndAppendDreamNarrative,
  removeBackfillDiaryEntries,
  type NarrativePhaseData,
  writeBackfillDiaryEntries,
} from "./dreaming-narrative.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
const DREAMS_FILE_LOCKS_KEY = Symbol.for("openclaw.memoryCore.dreamingNarrative.fileLocks");

afterEach(() => {
  vi.restoreAllMocks();
  resolveGlobalMap<string, unknown>(DREAMS_FILE_LOCKS_KEY).clear();
});

describe("buildNarrativePrompt", () => {
  it("builds a prompt from snippets only", () => {
    const data: NarrativePhaseData = {
      phase: "light",
      snippets: ["user prefers dark mode", "API key rotation scheduled"],
    };
    const prompt = buildNarrativePrompt(data);
    expect(prompt).toContain("user prefers dark mode");
    expect(prompt).toContain("API key rotation scheduled");
    expect(prompt).not.toContain("Recurring themes");
  });

  it("includes themes when provided", () => {
    const data: NarrativePhaseData = {
      phase: "rem",
      snippets: ["config migration path"],
      themes: ["infrastructure", "deployment"],
    };
    const prompt = buildNarrativePrompt(data);
    expect(prompt).toContain("Recurring themes");
    expect(prompt).toContain("infrastructure");
    expect(prompt).toContain("deployment");
  });

  it("includes promotions for deep phase", () => {
    const data: NarrativePhaseData = {
      phase: "deep",
      snippets: ["trading bot uses bracket orders"],
      promotions: ["always use stop-loss on options trades"],
    };
    const prompt = buildNarrativePrompt(data);
    expect(prompt).toContain("crystallized");
    expect(prompt).toContain("always use stop-loss on options trades");
  });

  it("caps snippets at 12", () => {
    const snippets = Array.from({ length: 20 }, (_, i) => `snippet-${i}`);
    const prompt = buildNarrativePrompt({ phase: "light", snippets });
    expect(prompt).toContain("snippet-11");
    expect(prompt).not.toContain("snippet-12");
  });
});

describe("extractNarrativeText", () => {
  it("extracts string content from assistant message", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "The workspace hummed quietly." },
    ];
    expect(extractNarrativeText(messages)).toBe("The workspace hummed quietly.");
  });

  it("extracts from content array with text blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "First paragraph." },
          { type: "text", text: "Second paragraph." },
        ],
      },
    ];
    expect(extractNarrativeText(messages)).toBe("First paragraph.\nSecond paragraph.");
  });

  it("returns null when no assistant message exists", () => {
    const messages = [{ role: "user", content: "hello" }];
    expect(extractNarrativeText(messages)).toBeNull();
  });

  it("returns null for empty assistant content", () => {
    const messages = [{ role: "assistant", content: "   " }];
    expect(extractNarrativeText(messages)).toBeNull();
  });

  it("picks the last assistant message", () => {
    const messages = [
      { role: "assistant", content: "First response." },
      { role: "user", content: "more" },
      { role: "assistant", content: "Final response." },
    ];
    expect(extractNarrativeText(messages)).toBe("Final response.");
  });
});

describe("formatNarrativeDate", () => {
  it("formats a UTC date", () => {
    const date = formatNarrativeDate(Date.parse("2026-04-05T03:00:00Z"), "UTC");
    expect(date).toContain("April");
    expect(date).toContain("2026");
    expect(date).toContain("3:00");
  });
});

describe("buildDiaryEntry", () => {
  it("formats narrative with date and separators", () => {
    const entry = buildDiaryEntry("The code drifted gently.", "April 5, 2026, 3:00 AM");
    expect(entry).toContain("---");
    expect(entry).toContain("*April 5, 2026, 3:00 AM*");
    expect(entry).toContain("The code drifted gently.");
  });
});

describe("backfill diary entries", () => {
  it("formats a backfill date without time", () => {
    expect(formatBackfillDiaryDate("2026-01-01", "UTC")).toBe("January 1, 2026");
  });

  it("preserves the iso day label in high-positive-offset timezones", () => {
    expect(formatBackfillDiaryDate("2026-01-01", "Pacific/Kiritimati")).toBe("January 1, 2026");
  });

  it("builds a marked backfill diary entry", () => {
    const entry = buildBackfillDiaryEntry({
      isoDay: "2026-01-01",
      sourcePath: "memory/2026-01-01.md",
      bodyLines: ["What Happened", "1. A durable preference appeared."],
      timezone: "UTC",
    });
    expect(entry).toContain("*January 1, 2026*");
    expect(entry).toContain("openclaw:dreaming:backfill-entry");
    expect(entry).toContain("What Happened");
  });

  it("writes and replaces backfill diary entries", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-backfill-");
    const first = await writeBackfillDiaryEntries({
      workspaceDir,
      timezone: "UTC",
      entries: [
        {
          isoDay: "2026-01-01",
          sourcePath: "memory/2026-01-01.md",
          bodyLines: ["What Happened", "1. First pass."],
        },
      ],
    });
    expect(first.written).toBe(1);
    expect(first.replaced).toBe(0);

    const second = await writeBackfillDiaryEntries({
      workspaceDir,
      timezone: "UTC",
      entries: [
        {
          isoDay: "2026-01-02",
          sourcePath: "memory/2026-01-02.md",
          bodyLines: ["Reflections", "1. Second pass."],
        },
      ],
    });
    expect(second.written).toBe(1);
    expect(second.replaced).toBe(1);

    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(content).not.toContain("First pass.");
    expect(content).toContain("Second pass.");
    expect(content.match(/openclaw:dreaming:backfill-entry/g)?.length).toBe(1);
  });

  it("removes only backfill diary entries", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-backfill-");
    await appendNarrativeEntry({
      workspaceDir,
      narrative: "Keep this real dream.",
      nowMs: Date.parse("2026-04-05T03:00:00Z"),
      timezone: "UTC",
    });
    await writeBackfillDiaryEntries({
      workspaceDir,
      timezone: "UTC",
      entries: [
        {
          isoDay: "2026-01-01",
          sourcePath: "memory/2026-01-01.md",
          bodyLines: ["What Happened", "1. Remove this backfill."],
        },
      ],
    });

    const removed = await removeBackfillDiaryEntries({ workspaceDir });
    expect(removed.removed).toBe(1);

    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(content).toContain("Keep this real dream.");
    expect(content).not.toContain("Remove this backfill.");
  });

  it("refuses to overwrite a symlinked DREAMS.md during backfill writes", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-backfill-");
    const targetPath = path.join(workspaceDir, "outside.txt");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(targetPath, "outside\n", "utf-8");
    await fs.symlink(targetPath, dreamsPath);

    await expect(
      writeBackfillDiaryEntries({
        workspaceDir,
        timezone: "UTC",
        entries: [
          {
            isoDay: "2026-01-01",
            sourcePath: "memory/2026-01-01.md",
            bodyLines: ["What Happened", "1. First pass."],
          },
        ],
      }),
    ).rejects.toThrow("Refusing to write symlinked DREAMS.md");
    await expect(fs.readFile(targetPath, "utf-8")).resolves.toBe("outside\n");
  });
});

describe("appendNarrativeEntry", () => {
  it("creates DREAMS.md with diary header on fresh workspace", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const dreamsPath = await appendNarrativeEntry({
      workspaceDir,
      narrative: "Fragments of authentication logic kept surfacing.",
      nowMs: Date.parse("2026-04-05T03:00:00Z"),
      timezone: "UTC",
    });
    expect(dreamsPath).toBe(path.join(workspaceDir, "DREAMS.md"));
    const content = await fs.readFile(dreamsPath, "utf-8");
    expect(content).toContain("# Dream Diary");
    expect(content).toContain("Fragments of authentication logic kept surfacing.");
    expect(content).toContain("<!-- openclaw:dreaming:diary:start -->");
    expect(content).toContain("<!-- openclaw:dreaming:diary:end -->");
  });

  it("appends a second entry within the diary markers", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    await appendNarrativeEntry({
      workspaceDir,
      narrative: "First dream.",
      nowMs: Date.parse("2026-04-04T03:00:00Z"),
      timezone: "UTC",
    });
    await appendNarrativeEntry({
      workspaceDir,
      narrative: "Second dream.",
      nowMs: Date.parse("2026-04-05T03:00:00Z"),
      timezone: "UTC",
    });
    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(content).toContain("First dream.");
    expect(content).toContain("Second dream.");
    // Both entries should be between start and end markers.
    const start = content.indexOf("<!-- openclaw:dreaming:diary:start -->");
    const end = content.indexOf("<!-- openclaw:dreaming:diary:end -->");
    const firstIdx = content.indexOf("First dream.");
    const secondIdx = content.indexOf("Second dream.");
    expect(firstIdx).toBeGreaterThan(start);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(secondIdx).toBeLessThan(end);
  });

  it("prepends diary before existing managed blocks", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(
      dreamsPath,
      "## Light Sleep\n<!-- openclaw:dreaming:light:start -->\n- Candidate: test\n<!-- openclaw:dreaming:light:end -->\n",
      "utf-8",
    );
    await appendNarrativeEntry({
      workspaceDir,
      narrative: "The workspace was quiet tonight.",
      nowMs: Date.parse("2026-04-05T03:00:00Z"),
      timezone: "UTC",
    });
    const content = await fs.readFile(dreamsPath, "utf-8");
    const diaryIdx = content.indexOf("# Dream Diary");
    const lightIdx = content.indexOf("## Light Sleep");
    // Diary should come before the managed block.
    expect(diaryIdx).toBeLessThan(lightIdx);
    expect(content).toContain("The workspace was quiet tonight.");
  });

  it("reuses existing dreams file when present", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(dreamsPath, "# Existing\n", "utf-8");
    const result = await appendNarrativeEntry({
      workspaceDir,
      narrative: "Appended dream.",
      nowMs: Date.parse("2026-04-05T03:00:00Z"),
      timezone: "UTC",
    });
    expect(result).toBe(dreamsPath);
    const content = await fs.readFile(dreamsPath, "utf-8");
    expect(content).toContain("Appended dream.");
    // Original content should still be there, after the diary.
    expect(content).toContain("# Existing");
  });

  it("keeps existing diary content intact when the atomic replace fails", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(dreamsPath, "# Existing\n", "utf-8");
    const renameError = Object.assign(new Error("replace failed"), { code: "ENOSPC" });
    const renameSpy = vi.spyOn(fs, "rename").mockRejectedValueOnce(renameError);

    await expect(
      appendNarrativeEntry({
        workspaceDir,
        narrative: "Appended dream.",
        nowMs: Date.parse("2026-04-05T03:00:00Z"),
        timezone: "UTC",
      }),
    ).rejects.toThrow("replace failed");

    expect(renameSpy).toHaveBeenCalledOnce();
    await expect(fs.readFile(dreamsPath, "utf-8")).resolves.toBe("# Existing\n");
  });

  it("preserves restrictive dreams file permissions across atomic replace", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(dreamsPath, "# Existing\n", { encoding: "utf-8", mode: 0o600 });
    await fs.chmod(dreamsPath, 0o600);

    await appendNarrativeEntry({
      workspaceDir,
      narrative: "Appended dream.",
      nowMs: Date.parse("2026-04-05T03:00:00Z"),
      timezone: "UTC",
    });

    const stat = await fs.stat(dreamsPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("dedupes only exact diary duplicates while keeping distinct timestamps", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-dedupe-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(
      dreamsPath,
      [
        "# Dream Diary",
        "",
        "<!-- openclaw:dreaming:diary:start -->",
        "---",
        "",
        "*April 11, 2026, 8:00 AM*",
        "",
        "The server room smelled like rain.",
        "",
        "---",
        "",
        "*April 11, 2026, 8:00 AM*",
        "",
        "<!-- transient comment -->",
        "",
        "The server room smelled like rain.",
        "",
        "---",
        "",
        "*April 11, 2026, 8:30 AM*",
        "",
        "The server room smelled like rain.",
        "",
        "<!-- openclaw:dreaming:diary:end -->",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await dedupeDreamDiaryEntries({ workspaceDir });

    expect(result.removed).toBe(1);
    expect(result.kept).toBe(2);
    const content = await fs.readFile(dreamsPath, "utf-8");
    expect(content.match(/The server room smelled like rain\./g)?.length).toBe(2);
    expect(content).toContain("*April 11, 2026, 8:00 AM*");
    expect(content).toContain("*April 11, 2026, 8:30 AM*");
  });

  it("serializes append and dedupe so concurrent rewrites keep the new entry", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-dedupe-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(
      dreamsPath,
      [
        "# Dream Diary",
        "",
        "<!-- openclaw:dreaming:diary:start -->",
        "---",
        "",
        "*April 11, 2026, 8:00 AM*",
        "",
        "The server room smelled like rain.",
        "",
        "---",
        "",
        "*April 11, 2026, 8:00 AM*",
        "",
        "The server room smelled like rain.",
        "",
        "<!-- openclaw:dreaming:diary:end -->",
        "",
      ].join("\n"),
      "utf-8",
    );

    await Promise.all([
      dedupeDreamDiaryEntries({ workspaceDir }),
      appendNarrativeEntry({
        workspaceDir,
        narrative: "A fresh signal arrived after the cleanup started.",
        nowMs: Date.parse("2026-04-11T14:30:00Z"),
        timezone: "UTC",
      }),
    ]);

    const content = await fs.readFile(dreamsPath, "utf-8");
    expect(content.match(/The server room smelled like rain\./g)?.length).toBe(1);
    expect(content).toContain("A fresh signal arrived after the cleanup started.");
  });

  it("keeps dedupe a no-op when no exact duplicates exist", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-dedupe-");
    await appendNarrativeEntry({
      workspaceDir,
      narrative: "Only one entry exists.",
      nowMs: Date.parse("2026-04-11T14:00:00Z"),
      timezone: "UTC",
    });

    const result = await dedupeDreamDiaryEntries({ workspaceDir });

    expect(result.removed).toBe(0);
    expect(result.kept).toBe(1);
    await expect(fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8")).resolves.toContain(
      "Only one entry exists.",
    );
  });

  it("does not rewrite the diary file when dedupe finds nothing to remove", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-dedupe-");
    const dreamsPath = await appendNarrativeEntry({
      workspaceDir,
      narrative: "Only one entry exists.",
      nowMs: Date.parse("2026-04-11T14:00:00Z"),
      timezone: "UTC",
    });
    const before = await fs.stat(dreamsPath);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const result = await dedupeDreamDiaryEntries({ workspaceDir });
    const after = await fs.stat(dreamsPath);

    expect(result.removed).toBe(0);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("cleans up the per-file lock entry after diary updates finish", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-dedupe-");
    const dreamsLocks = resolveGlobalMap<string, unknown>(DREAMS_FILE_LOCKS_KEY);

    expect(dreamsLocks.size).toBe(0);

    await appendNarrativeEntry({
      workspaceDir,
      narrative: "Only one entry exists.",
      nowMs: Date.parse("2026-04-11T14:00:00Z"),
      timezone: "UTC",
    });

    expect(dreamsLocks.size).toBe(0);
  });

  it("surfaces temp cleanup failure after atomic replace error", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(dreamsPath, "# Existing\n", "utf-8");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(
      Object.assign(new Error("replace failed"), { code: "ENOSPC" }),
    );
    vi.spyOn(fs, "rm").mockRejectedValueOnce(
      Object.assign(new Error("cleanup failed"), { code: "EACCES" }),
    );

    await expect(
      appendNarrativeEntry({
        workspaceDir,
        narrative: "Appended dream.",
        nowMs: Date.parse("2026-04-05T03:00:00Z"),
        timezone: "UTC",
      }),
    ).rejects.toThrow("cleanup also failed");
  });
});

describe("generateAndAppendDreamNarrative", () => {
  function createMockSubagent(responseText: string) {
    return {
      run: vi.fn().mockResolvedValue({ runId: "run-123" }),
      waitForRun: vi.fn().mockResolvedValue({ status: "ok" }),
      getSessionMessages: vi.fn().mockResolvedValue({
        messages: [
          { role: "user", content: "prompt" },
          { role: "assistant", content: responseText },
        ],
      }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };
  }

  function createMockLogger() {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }

  it("generates narrative and writes diary entry", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("The repository whispered of forgotten endpoints.");
    const logger = createMockLogger();
    const nowMs = Date.parse("2026-04-05T03:00:00Z");
    const expectedSessionKey = `dreaming-narrative-light-${nowMs}`;

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: {
        phase: "light",
        snippets: ["API endpoints need authentication"],
      },
      nowMs,
      timezone: "UTC",
      logger,
    });

    expect(subagent.run).toHaveBeenCalledOnce();
    expect(subagent.run.mock.calls[0][0]).toMatchObject({
      idempotencyKey: expectedSessionKey,
      sessionKey: expectedSessionKey,
      deliver: false,
    });
    expect(subagent.waitForRun).toHaveBeenCalledOnce();
    expect(subagent.deleteSession).toHaveBeenCalledOnce();

    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(content).toContain("The repository whispered of forgotten endpoints.");
    expect(logger.info).toHaveBeenCalled();
  });

  it("skips narrative when no snippets are available", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("Should not appear.");
    const logger = createMockLogger();

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "light", snippets: [] },
      logger,
    });

    expect(subagent.run).not.toHaveBeenCalled();
    const exists = await fs
      .access(path.join(workspaceDir, "DREAMS.md"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("handles subagent timeout gracefully", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("");
    subagent.waitForRun.mockResolvedValue({ status: "timeout" });
    const logger = createMockLogger();

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "deep", snippets: ["some memory"] },
      logger,
    });

    // Should not throw, should warn.
    expect(logger.warn).toHaveBeenCalled();
    const exists = await fs
      .access(path.join(workspaceDir, "DREAMS.md"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("handles subagent error gracefully", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("");
    subagent.run.mockRejectedValue(
      new Error("connection failed", {
        cause: new RequestScopedSubagentRuntimeError(),
      }),
    );
    const logger = createMockLogger();

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "rem", snippets: ["pattern surfaced"] },
      logger,
    });

    // Should not throw.
    expect(logger.warn).toHaveBeenCalled();
    await expect(fs.access(path.join(workspaceDir, "DREAMS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("falls back to a local narrative when subagent runtime is request-scoped", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("");
    subagent.run.mockRejectedValue(new RequestScopedSubagentRuntimeError());
    const logger = createMockLogger();

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "light", snippets: ["API endpoints need authentication"] },
      nowMs: Date.parse("2026-04-05T03:00:00Z"),
      timezone: "UTC",
      logger,
    });

    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(content).toContain("API endpoints need authentication");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("request-scoped"));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining(workspaceDir));
    expect(subagent.deleteSession).toHaveBeenCalledOnce();
  });

  it("falls back when the request-scoped runtime error is detected by stable code", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("");
    const crossBoundaryError = new Error("different wrapper text");
    crossBoundaryError.name = "RequestScopedSubagentRuntimeError";
    Object.assign(crossBoundaryError, {
      code: SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE,
    });
    subagent.run.mockRejectedValue(crossBoundaryError);
    const logger = createMockLogger();

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "deep", snippets: [], promotions: ["A durable candidate surfaced."] },
      nowMs: Date.parse("2026-04-05T03:00:00Z"),
      timezone: "UTC",
      logger,
    });

    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(content).toContain("A durable candidate surfaced.");
  });

  it("does not fall back for non-Error objects that only spoof the stable code", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("");
    subagent.run.mockRejectedValue({
      code: SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE,
      name: "RequestScopedSubagentRuntimeError",
      message: "spoofed",
    });
    const logger = createMockLogger();

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "deep", snippets: ["should not persist"] },
      logger,
    });

    await expect(fs.access(path.join(workspaceDir, "DREAMS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("narrative generation failed"),
    );
  });

  it("cleans up session even on failure", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("");
    subagent.getSessionMessages.mockRejectedValue(new Error("fetch failed"));
    const logger = createMockLogger();

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "light", snippets: ["memory fragment"] },
      logger,
    });

    expect(subagent.deleteSession).toHaveBeenCalled();
  });
});
