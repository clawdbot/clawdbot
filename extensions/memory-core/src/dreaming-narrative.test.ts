import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  RequestScopedSubagentRuntimeError,
  SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE,
} from "openclaw/plugin-sdk/error-runtime";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import * as memoryCoreHostRuntimeCoreModule from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import * as runtimeConfigSnapshotModule from "openclaw/plugin-sdk/runtime-config-snapshot";
import * as sessionStoreRuntimeModule from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  runDetachedDreamNarrative,
  type NarrativePhaseData,
  writeBackfillDiaryEntries,
} from "./dreaming-narrative.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
const DREAMS_FILE_LOCKS_KEY = Symbol.for("openclaw.memoryCore.dreamingNarrative.fileLocks");
const EXPECTS_POSIX_PRIVATE_FILE_MODE = process.platform !== "win32";

type MockCallSource = { mock: { calls: Array<Array<unknown>> } };

function mockCallArg(source: MockCallSource, label: string, callIndex = 0, argIndex = 0): unknown {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected ${label} call ${callIndex} to exist`);
  }
  if (!(argIndex in call)) {
    throw new Error(`Expected ${label} call ${callIndex} argument ${argIndex} to exist`);
  }
  return call[argIndex];
}

function mockObjectArg(
  source: MockCallSource,
  label: string,
  callIndex = 0,
  argIndex = 0,
): Record<string, unknown> {
  const value = mockCallArg(source, label, callIndex, argIndex);
  if (!value || typeof value !== "object") {
    throw new Error(`Expected ${label} call ${callIndex} argument ${argIndex} to be an object`);
  }
  return value as Record<string, unknown>;
}

function logIncludes(source: MockCallSource, text: string): boolean {
  return source.mock.calls.some((call) => String(call[0]).includes(text));
}

function expectLogIncludes(source: MockCallSource, text: string): void {
  expect(logIncludes(source, text), `Expected log to include ${text}`).toBe(true);
}

function expectLogExcludes(source: MockCallSource, text: string): void {
  expect(logIncludes(source, text), `Expected log not to include ${text}`).toBe(false);
}

async function expectPathMissing(targetPath: string): Promise<void> {
  const accessResult = await fs
    .access(targetPath)
    .then(() => "exists")
    .catch((error: unknown) => (error as { code?: unknown }).code);
  expect(accessResult).toBe("ENOENT");
}

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

  it("extracts from OpenAI output_text assistant parts", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "output_text", text: "The light phase found a diary thread." }],
      },
    ];
    expect(extractNarrativeText(messages)).toBe("The light phase found a diary thread.");
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
    expect(date).toContain("UTC");
  });

  it("applies an explicit timezone", () => {
    // 2026-04-11T21:46:55Z in America/Los_Angeles (PDT, UTC-7) → 2:46 PM
    const date = formatNarrativeDate(Date.parse("2026-04-11T21:46:55Z"), "America/Los_Angeles");
    expect(date).toContain("2:46");
    expect(date).toContain("PM");
    expect(date).toContain("PDT");
  });

  it("uses host local timezone when timezone is undefined (#65027)", () => {
    // Force a non-UTC host timezone so this test is meaningful on UTC CI
    // runners where the old `?? "UTC"` fallback would silently pass.
    const originalTZ = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles"; // PDT = UTC-7
      const epochMs = Date.parse("2026-04-11T21:46:55Z");
      const result = formatNarrativeDate(epochMs);
      // 21:46 UTC → 14:46 PDT → "2:46 PM"
      expect(result).toContain("2:46");
      expect(result).toContain("PM");
      expect(result).toContain("PDT");
    } finally {
      if (originalTZ === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTZ;
      }
    }
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
    if (EXPECTS_POSIX_PRIVATE_FILE_MODE) {
      expect(stat.mode & 0o777).toBe(0o600);
    }
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
    const stableMtime = new Date("2026-04-11T14:00:05Z");
    await fs.utimes(dreamsPath, stableMtime, stableMtime);
    const before = await fs.stat(dreamsPath);

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
    const workspaceHash = createHash("sha1").update(workspaceDir).digest("hex").slice(0, 12);
    const expectedSessionKey = `dreaming-narrative-light-${workspaceHash}-${nowMs}`;

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: {
        phase: "light",
        snippets: ["API endpoints need authentication"],
      },
      nowMs,
      timezone: "UTC",
      model: "anthropic/claude-sonnet-4-6",
      logger,
    });

    expect(subagent.run).toHaveBeenCalledOnce();
    const runOptions = mockObjectArg(subagent.run, "subagent run");
    expect(runOptions.idempotencyKey).toBe(expectedSessionKey);
    expect(runOptions.sessionKey).toBe(expectedSessionKey);
    expect(runOptions.lane).toBe(`dreaming-narrative:${expectedSessionKey}`);
    expect(runOptions.lightContext).toBe(true);
    expect(runOptions.deliver).toBe(false);
    expect(runOptions.model).toBe("anthropic/claude-sonnet-4-6");
    expect(subagent.waitForRun).toHaveBeenCalledOnce();
    expect(subagent.deleteSession).toHaveBeenCalledOnce();

    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(content).toContain("The repository whispered of forgotten endpoints.");
    expect(logger.info).toHaveBeenCalled();
  });

  it("retries with the session default when the configured model cannot start", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("The default model carried the diary home.");
    subagent.run.mockRejectedValueOnce(new Error("model unavailable"));
    const logger = createMockLogger();
    const nowMs = Date.parse("2026-04-05T03:00:00Z");
    const workspaceHash = createHash("sha1").update(workspaceDir).digest("hex").slice(0, 12);
    const expectedSessionKey = `dreaming-narrative-light-${workspaceHash}-${nowMs}`;
    const retrySessionKey = `${expectedSessionKey}-retry-1`;

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: {
        phase: "light",
        snippets: ["API endpoints need authentication"],
      },
      nowMs,
      timezone: "UTC",
      model: "ollama/missing-model",
      logger,
    });

    expect(subagent.run).toHaveBeenCalledTimes(2);
    const configuredRunOptions = mockObjectArg(subagent.run, "subagent run");
    expect(configuredRunOptions.sessionKey).toBe(expectedSessionKey);
    expect(configuredRunOptions.model).toBe("ollama/missing-model");
    const retryRunOptions = mockObjectArg(subagent.run, "subagent run", 1);
    expect(retryRunOptions.sessionKey).toBe(retrySessionKey);
    expect(retryRunOptions).not.toHaveProperty("model");
    expect(subagent.getSessionMessages).toHaveBeenCalledWith({
      sessionKey: retrySessionKey,
      limit: 5,
    });
    expect(subagent.deleteSession).toHaveBeenCalledOnce();
    expect(subagent.deleteSession).toHaveBeenCalledWith({ sessionKey: retrySessionKey });
    expectLogIncludes(logger.warn, "session default");
  });

  it("retries with the session default when the configured model run ends unavailable", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("The default model carried the diary home.");
    subagent.run
      .mockResolvedValueOnce({ runId: "run-configured" })
      .mockResolvedValueOnce({ runId: "run-default" });
    subagent.waitForRun
      .mockResolvedValueOnce({ status: "error", error: "unknown model: ollama/missing-model" })
      .mockResolvedValueOnce({ status: "ok" });
    const logger = createMockLogger();
    const nowMs = Date.parse("2026-04-05T03:00:00Z");
    const workspaceHash = createHash("sha1").update(workspaceDir).digest("hex").slice(0, 12);
    const expectedSessionKey = `dreaming-narrative-rem-${workspaceHash}-${nowMs}`;
    const retrySessionKey = `${expectedSessionKey}-retry-1`;

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: {
        phase: "rem",
        snippets: ["The index remembered a missing provider."],
      },
      nowMs,
      timezone: "UTC",
      model: "ollama/missing-model",
      logger,
    });

    expect(subagent.waitForRun).toHaveBeenCalledTimes(2);
    expect(subagent.getSessionMessages).toHaveBeenCalledWith({
      sessionKey: retrySessionKey,
      limit: 5,
    });
    expect(subagent.deleteSession).toHaveBeenCalledTimes(2);
    expect(mockObjectArg(subagent.deleteSession, "delete session")).toEqual({
      sessionKey: expectedSessionKey,
    });
    expect(mockObjectArg(subagent.deleteSession, "delete session", 1)).toEqual({
      sessionKey: retrySessionKey,
    });
    expectLogIncludes(logger.warn, "unknown model");
  });

  it("does not hide configured model authorization failures by retrying", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("");
    subagent.run.mockRejectedValue(
      new Error("provider/model override is not authorized for this plugin subagent run."),
    );
    const logger = createMockLogger();

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: {
        phase: "light",
        snippets: ["API endpoints need authentication"],
      },
      model: "ollama/missing-model",
      logger,
    });

    expect(subagent.run).toHaveBeenCalledOnce();
    expect(subagent.waitForRun).not.toHaveBeenCalled();
    expect(subagent.deleteSession).not.toHaveBeenCalled();
    expectLogIncludes(logger.warn, "narrative generation failed");
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

  it("skips extra settle waits after timeout and still attempts cleanup", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("");
    subagent.waitForRun.mockResolvedValueOnce({ status: "timeout" });
    subagent.deleteSession.mockRejectedValue(new Error("still active"));
    const logger = createMockLogger();

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "rem", snippets: ["some memory"] },
      logger,
    });

    expect(subagent.waitForRun).toHaveBeenCalledOnce();
    expect(mockObjectArg(subagent.waitForRun, "wait for run").timeoutMs).toBe(60_000);
    expectLogIncludes(logger.warn, "narrative session cleanup failed for rem phase");
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
    await expectPathMissing(path.join(workspaceDir, "DREAMS.md"));
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
    expectLogIncludes(logger.info, "request-scoped");
    expectLogExcludes(logger.warn, "request-scoped");
    expectLogExcludes(logger.warn, workspaceDir);
    expectLogExcludes(logger.warn, "narrative session cleanup failed");
    expect(subagent.deleteSession).not.toHaveBeenCalled();
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
    expectLogIncludes(logger.info, "request-scoped");
    expectLogExcludes(logger.warn, "request-scoped");
    expect(subagent.deleteSession).not.toHaveBeenCalled();
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

    await expectPathMissing(path.join(workspaceDir, "DREAMS.md"));
    expectLogIncludes(logger.warn, "narrative generation failed");
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

  it("scrubs stale dreaming entries and orphan transcripts after cleanup", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const stateDir = await createTempWorkspace("openclaw-dreaming-state-");
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const storePath = path.join(sessionsDir, "sessions.json");
    const orphanPath = path.join(sessionsDir, "orphan.jsonl");
    const livePath = path.join(sessionsDir, "still-live.jsonl");
    await fs.writeFile(
      storePath,
      `${JSON.stringify({
        "agent:main:dreaming-narrative-light-1": {
          sessionId: "missing",
        },
        "agent:main:kept-session": {
          sessionId: "still-live",
        },
        "agent:main:telegram:group:dreaming-narrative-room": {
          sessionId: "still-missing-non-dreaming",
        },
      })}\n`,
      "utf-8",
    );
    await fs.writeFile(orphanPath, '{"runId":"dreaming-narrative-light-123"}\n', "utf-8");
    await fs.writeFile(livePath, '{"runId":"dreaming-narrative-light-keep"}\n', "utf-8");
    const oldDate = new Date(Date.now() - 600_000);
    await fs.utimes(orphanPath, oldDate, oldDate);
    await fs.utimes(livePath, oldDate, oldDate);

    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfig").mockReturnValue({
      session: {},
    } as never);
    vi.spyOn(sessionStoreRuntimeModule, "resolveStorePath").mockImplementation(((
      _store: string | undefined,
      { agentId }: { agentId: string },
    ) => {
      expect(agentId).toBe("main");
      return storePath;
    }) as typeof sessionStoreRuntimeModule.resolveStorePath);
    vi.spyOn(memoryCoreHostRuntimeCoreModule, "resolveStateDir").mockReturnValue(stateDir);

    const subagent = createMockSubagent("The repository whispered of forgotten endpoints.");
    const logger = createMockLogger();

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "light", snippets: ["memory fragment"] },
      logger,
    });

    const updatedStore = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(updatedStore).not.toHaveProperty("agent:main:dreaming-narrative-light-1");
    expect(updatedStore).toHaveProperty("agent:main:kept-session");
    expect(updatedStore).toHaveProperty("agent:main:telegram:group:dreaming-narrative-room");
    const sessionFiles = await fs.readdir(sessionsDir);
    expect(sessionFiles.filter((file) => file.startsWith("orphan.jsonl.deleted."))).not.toEqual([]);
    expect(sessionFiles).toContain("still-live.jsonl");
    expectLogIncludes(logger.info, "dreaming cleanup scrubbed");
  });

  it("isolates narrative sessions across workspaces even at the same timestamp", async () => {
    const firstWorkspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const secondWorkspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("A quiet memory took shape.");
    const logger = createMockLogger();
    const nowMs = Date.parse("2026-04-05T03:00:00Z");

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir: firstWorkspaceDir,
      data: { phase: "light", snippets: ["first workspace fragment"] },
      nowMs,
      logger,
    });
    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir: secondWorkspaceDir,
      data: { phase: "light", snippets: ["second workspace fragment"] },
      nowMs,
      logger,
    });

    const firstSessionKey = mockObjectArg(subagent.run, "subagent run").sessionKey;
    const secondSessionKey = mockObjectArg(subagent.run, "subagent run", 1).sessionKey;
    expect(firstSessionKey).toBeTypeOf("string");
    expect(secondSessionKey).toBeTypeOf("string");
    expect(firstSessionKey).not.toBe(secondSessionKey);
    expect(firstSessionKey).toContain("dreaming-narrative-light-");
    expect(secondSessionKey).toContain("dreaming-narrative-light-");
    expect(mockObjectArg(subagent.deleteSession, "delete session").sessionKey).toBe(
      firstSessionKey,
    );
    expect(mockObjectArg(subagent.deleteSession, "delete session", 1).sessionKey).toBe(
      secondSessionKey,
    );
  });
});

describe("runDetachedDreamNarrative", () => {
  type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
  function deferred<T>(): Deferred<T> {
    let resolve: ((v: T) => void) | undefined;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    if (!resolve) {
      throw new Error("Expected dream narrative deferred resolver to be initialized");
    }
    return { promise, resolve };
  }

  function createBlockingSubagent() {
    const runDeferreds: Array<Deferred<{ runId: string }>> = [];
    const subagent = {
      run: vi.fn(() => {
        const d = deferred<{ runId: string }>();
        runDeferreds.push(d);
        return d.promise;
      }),
      // Resolve the rest of the pipeline as a no-op so a single resolve()
      // on a deferred unblocks the slot for the queued task.
      waitForRun: vi.fn().mockResolvedValue({ status: "timeout" }),
      getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };
    return { subagent, runDeferreds };
  }

  function createMockLogger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  async function drainMicrotasks(rounds = 30): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve();
    }
  }

  it("caps the number of in-flight detached narratives at 3", async () => {
    const { subagent, runDeferreds } = createBlockingSubagent();
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-detach-");
    const logger = createMockLogger();

    for (let i = 0; i < 5; i += 1) {
      runDetachedDreamNarrative({
        subagent,
        workspaceDir,
        data: { phase: "light", snippets: [`fragment-${i}`] },
        nowMs: Date.parse("2026-04-28T03:00:00Z"),
        logger,
      });
    }

    await drainMicrotasks();

    // Only the first 3 should have reached subagent.run; the rest are queued.
    expect(subagent.run).toHaveBeenCalledTimes(3);

    // Drain the rest so module-level concurrency state does not leak into
    // subsequent tests. The mock subagent creates a new deferred every time
    // queued tasks acquire a slot, so loop until no new deferreds appear.
    for (let iter = 0; iter < 10; iter += 1) {
      const before = runDeferreds.length;
      for (const d of runDeferreds) {
        d.resolve({ runId: "drain" });
      }
      if (before >= 5) {
        break;
      }
      await vi.waitFor(() => {
        expect(runDeferreds.length).toBeGreaterThan(before);
      });
    }
    for (const d of runDeferreds) {
      d.resolve({ runId: "drain" });
    }
    await vi.waitFor(() => {
      expect(subagent.deleteSession).toHaveBeenCalledTimes(5);
    });
    expect(subagent.run).toHaveBeenCalledTimes(5);
    expect(subagent.waitForRun).toHaveBeenCalledTimes(5);
  });

  it("swallows underlying narrative errors instead of leaving an unhandled rejection", async () => {
    const error = new Error("boom");
    const subagent = {
      run: vi.fn().mockRejectedValue(error),
      waitForRun: vi.fn().mockResolvedValue({ status: "ok" }),
      getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };
    const logger = createMockLogger();
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-detach-");
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      runDetachedDreamNarrative({
        subagent,
        workspaceDir,
        data: { phase: "light", snippets: ["fragment"] },
        nowMs: Date.parse("2026-04-28T03:00:00Z"),
        logger,
      });

      await drainMicrotasks();

      expect(subagent.run).toHaveBeenCalledOnce();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
