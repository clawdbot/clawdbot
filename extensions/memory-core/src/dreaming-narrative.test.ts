// Memory Core tests cover dreaming narrative plugin behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  RequestScopedSubagentRuntimeError,
  SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE,
} from "openclaw/plugin-sdk/error-runtime";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import { resolveStateDir } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import * as runtimeConfigSnapshotModule from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  listSessionEntries,
  loadTranscriptEventsSync,
  upsertSessionEntry,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSqliteSessionTranscriptEventForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dedupeDreamDiaryEntries,
  generateAndAppendDreamNarrative,
  readRecentDreamDiaryEntries,
  removeBackfillDiaryEntries,
  runDetachedDreamNarrative,
  writeBackfillDiaryEntries,
} from "./dreaming-narrative.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", { spy: true });

const { createTempWorkspace } = createMemoryCoreTestHarness();
const DREAMS_FILE_LOCKS_KEY = Symbol.for("openclaw.memoryCore.dreamingNarrative.fileLocks");
const NARRATIVE_SESSION_LOCKS_KEY = Symbol.for(
  "openclaw.memoryCore.dreamingNarrative.sessionLocks",
);
const EXPECTS_POSIX_PRIVATE_FILE_MODE = process.platform !== "win32";
const originalNarrativeStateDir = process.env.OPENCLAW_STATE_DIR;

function setNarrativeTestEnv(stateDir: string): void {
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
}

function restoreNarrativeTestEnv(): void {
  if (originalNarrativeStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalNarrativeStateDir);
  }
}

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

async function seedSessionStore(
  storePath: string,
  entries: Record<string, SessionEntry>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await upsertSessionEntry({ storePath, sessionKey, entry });
  }
}

function readSessionStoreEntries(storePath: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntries({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

async function seedDreamingTranscriptEvent(params: {
  sessionId: string;
  sessionKey: string;
  storePath: string;
  timestampMs: number;
  runId?: string;
}): Promise<void> {
  await appendSqliteSessionTranscriptEventForTest({
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    event: {
      type: "metadata",
      timestamp: params.timestampMs,
      runId: params.runId ?? `dreaming-narrative-${params.sessionId}`,
    },
  });
}

async function flushNarrativeSettleTimers<T>(operation: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return operation;
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
  restoreNarrativeTestEnv();
  resolveGlobalMap<string, unknown>(DREAMS_FILE_LOCKS_KEY).clear();
  resolveGlobalMap<string, unknown>(NARRATIVE_SESSION_LOCKS_KEY).clear();
});

describe("dream diary file behavior", () => {
  it("writes, reads, deduplicates, and removes backfill entries", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-narrative-backfill-");
    const written = await writeBackfillDiaryEntries({
      workspaceDir,
      entries: [
        {
          isoDay: "2026-04-05",
          bodyLines: ["The archive remembered a durable fact."],
          sourcePath: "memory/2026-04-05.md",
        },
      ],
      timezone: "UTC",
    });
    expect(written.written).toBe(1);

    const existing = await fs.readFile(written.dreamsPath, "utf8");
    const startMarker = "<!-- openclaw:dreaming:diary:start -->";
    const endMarker = "<!-- openclaw:dreaming:diary:end -->";
    const block = existing.slice(
      existing.indexOf(startMarker) + startMarker.length,
      existing.indexOf(endMarker),
    );
    await fs.writeFile(written.dreamsPath, existing.replace(endMarker, `${block}\n${endMarker}`));

    await expect(dedupeDreamDiaryEntries({ workspaceDir })).resolves.toMatchObject({ removed: 1 });
    await expect(readRecentDreamDiaryEntries({ workspaceDir })).resolves.toHaveLength(1);
    await expect(removeBackfillDiaryEntries({ workspaceDir })).resolves.toMatchObject({
      removed: 1,
    });
  });

  it("refuses to overwrite a symlinked DREAMS.md", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-narrative-symlink-");
    const targetPath = path.join(workspaceDir, "outside.txt");
    await fs.writeFile(targetPath, "outside\n", "utf8");
    await fs.symlink(targetPath, path.join(workspaceDir, "DREAMS.md"));

    await expect(
      writeBackfillDiaryEntries({
        workspaceDir,
        entries: [
          {
            isoDay: "2026-04-05",
            bodyLines: ["The archive remembered a durable fact."],
          },
        ],
        timezone: "UTC",
      }),
    ).rejects.toThrow("Refusing to write symlinked DREAMS.md");
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("outside\n");
  });

  it("keeps truncated recent diary entries UTF-16 safe", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-narrative-utf16-");
    const prefix = "a".repeat(359);
    await writeBackfillDiaryEntries({
      workspaceDir,
      entries: [
        {
          isoDay: "2026-04-05",
          bodyLines: [`${prefix}😀tail`],
        },
      ],
      timezone: "UTC",
    });

    await expect(readRecentDreamDiaryEntries({ workspaceDir, limit: 1 })).resolves.toEqual([
      `${prefix}...`,
    ]);
  });

  it("skips symlinked and non-file DREAMS.md when reading recent context", async () => {
    const symlinkWorkspace = await createTempWorkspace("dreaming-narrative-read-symlink-");
    const targetPath = path.join(symlinkWorkspace, "target-dreams.md");
    await fs.writeFile(
      targetPath,
      [
        "# Dream Diary",
        "",
        "<!-- openclaw:dreaming:diary:start -->",
        "---",
        "",
        "*April 5, 2026*",
        "",
        "Symlink target diary text must not enter the prompt.",
        "",
        "<!-- openclaw:dreaming:diary:end -->",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.symlink(targetPath, path.join(symlinkWorkspace, "DREAMS.md"));

    await expect(
      readRecentDreamDiaryEntries({ workspaceDir: symlinkWorkspace, limit: 3 }),
    ).resolves.toEqual([]);

    const directoryWorkspace = await createTempWorkspace("dreaming-narrative-read-directory-");
    await fs.mkdir(path.join(directoryWorkspace, "DREAMS.md"));
    await expect(
      readRecentDreamDiaryEntries({ workspaceDir: directoryWorkspace, limit: 3 }),
    ).resolves.toEqual([]);
  });

  it("keeps existing content intact when the atomic replace fails", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-narrative-atomic-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(dreamsPath, "# Existing\n", "utf8");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(
      Object.assign(new Error("replace failed"), { code: "ENOSPC" }),
    );

    await expect(
      writeBackfillDiaryEntries({
        workspaceDir,
        entries: [
          {
            isoDay: "2026-04-05",
            bodyLines: ["The archive remembered a durable fact."],
          },
        ],
        timezone: "UTC",
      }),
    ).rejects.toThrow("replace failed");
    await expect(fs.readFile(dreamsPath, "utf8")).resolves.toBe("# Existing\n");
  });

  it("preserves restrictive DREAMS.md permissions across atomic replace", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-narrative-mode-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(dreamsPath, "# Existing\n", { encoding: "utf8", mode: 0o600 });
    await fs.chmod(dreamsPath, 0o600);

    await writeBackfillDiaryEntries({
      workspaceDir,
      entries: [
        {
          isoDay: "2026-04-05",
          bodyLines: ["The archive remembered a durable fact."],
        },
      ],
      timezone: "UTC",
    });

    if (EXPECTS_POSIX_PRIVATE_FILE_MODE) {
      expect((await fs.stat(dreamsPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("deduplicates exact matches while keeping distinct timestamps", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-narrative-dedupe-");
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
      "utf8",
    );

    await expect(dedupeDreamDiaryEntries({ workspaceDir })).resolves.toMatchObject({
      removed: 1,
      kept: 2,
    });
    const content = await fs.readFile(dreamsPath, "utf8");
    expect(content.match(/The server room smelled like rain\./g)?.length).toBe(2);
    expect(content).toContain("*April 11, 2026, 8:00 AM*");
    expect(content).toContain("*April 11, 2026, 8:30 AM*");
  });

  it("serializes concurrent writes and deduplication", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-narrative-concurrent-");
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
      "utf8",
    );

    await Promise.all([
      dedupeDreamDiaryEntries({ workspaceDir }),
      writeBackfillDiaryEntries({
        workspaceDir,
        entries: [
          {
            isoDay: "2026-04-11",
            bodyLines: ["A fresh signal arrived after the cleanup started."],
          },
        ],
        timezone: "UTC",
      }),
    ]);

    const content = await fs.readFile(dreamsPath, "utf8");
    expect(content.match(/The server room smelled like rain\./g)?.length).toBe(1);
    expect(content).toContain("A fresh signal arrived after the cleanup started.");
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
    const expectedSessionKey = `dreaming-narrative-light-${workspaceHash}`;

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
    expect(runOptions.idempotencyKey).toBe(`${expectedSessionKey}-${nowMs}`);
    expect(runOptions.sessionKey).toBe(expectedSessionKey);
    expect(runOptions.lane).toBe(`dreaming-narrative:${expectedSessionKey}`);
    expect(runOptions.lightContext).toBe(true);
    expect(runOptions.deliver).toBe(false);
    expect(runOptions.model).toBe("anthropic/claude-sonnet-4-6");
    expect(subagent.waitForRun).toHaveBeenCalledOnce();
    expect(subagent.deleteSession).toHaveBeenCalledTimes(2);

    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(content).toContain("The repository whispered of forgotten endpoints.");
    expect(logger.info).toHaveBeenCalled();
  });

  it("waits for persisted assistant text before falling back", async () => {
    vi.useFakeTimers();
    try {
      const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
      const subagent = createMockSubagent("");
      subagent.getSessionMessages
        .mockResolvedValueOnce({
          messages: [{ role: "user", content: "prompt" }],
        })
        .mockResolvedValueOnce({
          messages: [
            { role: "user", content: "prompt" },
            {
              role: "assistant",
              content: [{ type: "text", text: "The delayed diary text finally settled." }],
            },
          ],
        });
      const logger = createMockLogger();

      const operation = generateAndAppendDreamNarrative({
        subagent,
        workspaceDir,
        data: {
          phase: "light",
          snippets: ["The narrative assistant persisted after the run completed."],
        },
        nowMs: Date.parse("2026-04-05T03:00:00Z"),
        timezone: "UTC",
        logger,
      });
      await flushNarrativeSettleTimers(operation);

      expect(subagent.getSessionMessages).toHaveBeenCalledTimes(2);
      expect(subagent.getSessionMessages).toHaveBeenNthCalledWith(1, {
        sessionKey: expect.stringContaining("dreaming-narrative-light-"),
        limit: expect.any(Number),
      });
      expect(subagent.getSessionMessages).toHaveBeenNthCalledWith(2, {
        sessionKey: expect.stringContaining("dreaming-narrative-light-"),
        limit: expect.any(Number),
      });
      const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
      expect(content).toContain("The delayed diary text finally settled.");
      expect(content).not.toContain("A memory trace surfaced");
      expectLogExcludes(logger.warn, "produced no text");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back after settled assistant text never appears", async () => {
    vi.useFakeTimers();
    try {
      const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
      const subagent = createMockSubagent("");
      const logger = createMockLogger();

      const operation = generateAndAppendDreamNarrative({
        subagent,
        workspaceDir,
        data: {
          phase: "light",
          snippets: ["The narrative assistant never persisted text."],
        },
        nowMs: Date.parse("2026-04-05T03:00:00Z"),
        timezone: "UTC",
        logger,
      });
      await flushNarrativeSettleTimers(operation);

      expect(subagent.getSessionMessages).toHaveBeenCalledTimes(5);
      const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
      expect(content).toContain(
        "A memory trace surfaced, but details were unavailable in this run.",
      );
      expectLogIncludes(logger.warn, "produced no text");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries with the session default when the configured model cannot start", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("The default model carried the diary home.");
    subagent.run.mockRejectedValueOnce(new Error("model unavailable"));
    const logger = createMockLogger();
    const nowMs = Date.parse("2026-04-05T03:00:00Z");
    const workspaceHash = createHash("sha1").update(workspaceDir).digest("hex").slice(0, 12);
    const expectedSessionKey = `dreaming-narrative-light-${workspaceHash}`;
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
    expect(subagent.deleteSession).toHaveBeenCalledTimes(3);
    expect(mockObjectArg(subagent.deleteSession, "delete session")).toEqual({
      sessionKey: expectedSessionKey,
    });
    expect(mockObjectArg(subagent.deleteSession, "delete session", 1)).toEqual({
      sessionKey: retrySessionKey,
    });
    expect(mockObjectArg(subagent.deleteSession, "delete session", 2)).toEqual({
      sessionKey: retrySessionKey,
    });
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
    const expectedSessionKey = `dreaming-narrative-rem-${workspaceHash}`;
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
    expect(subagent.deleteSession).toHaveBeenCalledTimes(4);
    expect(mockObjectArg(subagent.deleteSession, "delete session")).toEqual({
      sessionKey: expectedSessionKey,
    });
    expect(mockObjectArg(subagent.deleteSession, "delete session", 1)).toEqual({
      sessionKey: retrySessionKey,
    });
    expect(mockObjectArg(subagent.deleteSession, "delete session", 2)).toEqual({
      sessionKey: expectedSessionKey,
    });
    expect(mockObjectArg(subagent.deleteSession, "delete session", 3)).toEqual({
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
    expect(subagent.deleteSession).toHaveBeenCalledOnce();
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

  it("writes a fallback diary entry when the subagent times out", async () => {
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
    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    // Raw staging snippets must never leak into the diary; only the generic
    // placeholder is written on fallback.
    expect(content).not.toContain("some memory");
    expect(content).toContain("A memory trace surfaced, but details were unavailable in this run.");
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("status=timeout"));
  });

  it("does not leak sensitive raw staging fragments into the diary on fallback", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("");
    subagent.waitForRun.mockResolvedValue({ status: "timeout" });
    const logger = createMockLogger();

    // Realistic staging fragments as described in issue #88391: session
    // metadata, conversation summaries, and operational logs that must never
    // be persisted to the human-readable dream diary.
    const sensitiveSnippets = [
      "Conversation Summary: 343 files copied, 30 MB on B2 so far",
      "Session: 2026-05-22 00:02:16 GMT+1: Session Key: agent:main:dashboard:secret",
    ];

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "deep", snippets: sensitiveSnippets },
      logger,
    });

    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    for (const fragment of sensitiveSnippets) {
      expect(content).not.toContain(fragment);
    }
    expect(content).not.toContain("Session Key:");
    expect(content).not.toContain("agent:main:dashboard");
    expect(content).toContain("A memory trace surfaced, but details were unavailable in this run.");
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
    subagent.deleteSession.mockRejectedValueOnce(new RequestScopedSubagentRuntimeError());
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
    // Raw staging snippets must never leak into the diary on fallback.
    expect(content).not.toContain("API endpoints need authentication");
    expect(content).toContain("A memory trace surfaced, but details were unavailable in this run.");
    expectLogIncludes(logger.info, "request-scoped");
    expectLogExcludes(logger.warn, "request-scoped");
    expectLogExcludes(logger.warn, workspaceDir);
    expectLogExcludes(logger.warn, "narrative pre-cleanup");
    expectLogExcludes(logger.warn, "narrative session cleanup failed");
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
    // Raw staging promotions must never leak into the diary on fallback.
    expect(content).not.toContain("A durable candidate surfaced.");
    expect(content).toContain("A memory trace surfaced, but details were unavailable in this run.");
    expectLogIncludes(logger.info, "request-scoped");
    expectLogExcludes(logger.warn, "request-scoped");
    expect(subagent.deleteSession).toHaveBeenCalledOnce();
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
    const normalTranscriptPath = path.join(sessionsDir, "normal-user-session.jsonl");
    const updatedAt = Date.now();
    await seedSessionStore(storePath, {
      "agent:main:dreaming-narrative-light-1": {
        sessionId: "orphan",
        sessionFile: orphanPath,
        updatedAt,
      },
      "agent:main:kept-session": {
        sessionId: "still-live",
        sessionFile: livePath,
        updatedAt,
      },
      "agent:main:telegram:group:dreaming-narrative-room": {
        sessionId: "still-missing-non-dreaming",
        updatedAt,
      },
      "agent:main:dreaming-narrative-corrupt-normal": {
        sessionId: "normal-user-session",
        sessionFile: normalTranscriptPath,
        updatedAt,
      },
    });
    await seedDreamingTranscriptEvent({
      sessionId: "orphan",
      sessionKey: "agent:main:dreaming-narrative-light-1",
      storePath,
      timestampMs: Date.now() - 600_000,
      runId: "dreaming-narrative-light-123",
    });
    await seedDreamingTranscriptEvent({
      sessionId: "still-live",
      sessionKey: "agent:main:kept-session",
      storePath,
      timestampMs: Date.now(),
      runId: "dreaming-narrative-light-keep",
    });
    await fs.writeFile(orphanPath, '{"runId":"dreaming-narrative-light-123"}\n', "utf-8");
    await fs.writeFile(livePath, '{"runId":"dreaming-narrative-light-keep"}\n', "utf-8");
    await fs.writeFile(normalTranscriptPath, '{"runId":"ordinary-user-session"}\n', "utf-8");
    const oldDate = new Date(Date.now() - 600_000);
    await fs.utimes(orphanPath, oldDate, oldDate);
    await fs.utimes(livePath, oldDate, oldDate);
    await fs.utimes(normalTranscriptPath, oldDate, oldDate);

    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfig").mockReturnValue({
      session: {},
    } as never);
    setNarrativeTestEnv(stateDir);
    vi.mocked(resolveStateDir).mockReturnValue(stateDir);

    const subagent = createMockSubagent("The repository whispered of forgotten endpoints.");
    const logger = createMockLogger();

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "light", snippets: ["memory fragment"] },
      logger,
    });

    const updatedStore = readSessionStoreEntries(storePath) as Record<string, unknown>;
    expect(updatedStore).not.toHaveProperty("agent:main:dreaming-narrative-light-1");
    expect(updatedStore).not.toHaveProperty("agent:main:dreaming-narrative-corrupt-normal");
    expect(updatedStore).toHaveProperty("agent:main:kept-session");
    expect(updatedStore).toHaveProperty("agent:main:telegram:group:dreaming-narrative-room");
    expect(loadTranscriptEventsSync({ agentId: "main", sessionId: "orphan", storePath })).toEqual(
      [],
    );
    expect(
      loadTranscriptEventsSync({ agentId: "main", sessionId: "still-live", storePath }),
    ).not.toEqual([]);
    const sessionFiles = await fs.readdir(sessionsDir);
    expect(sessionFiles).toContain("still-live.jsonl");
    expect(sessionFiles).toContain("normal-user-session.jsonl");
    expectLogIncludes(logger.info, "dreaming cleanup scrubbed");
  });

  it("reclaims an aged dreaming row whose transcript still exists (failed deleteSession)", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const stateDir = await createTempWorkspace("openclaw-dreaming-state-");
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const storePath = path.join(sessionsDir, "sessions.json");
    // Orphan: a completed dreaming row whose deleteSession previously threw, so
    // BOTH the store row and its transcript still exist (issue #88322).
    const orphanTranscript = path.join(sessionsDir, "orphan-dreaming.jsonl");
    // A second dreaming row whose transcript is fresh (a live/just-started run)
    // must be preserved.
    const liveTranscript = path.join(sessionsDir, "live-dreaming.jsonl");
    const updatedAt = Date.now();
    await seedSessionStore(storePath, {
      "agent:main:dreaming-narrative-deep-orphan": {
        sessionId: "orphan-dreaming",
        sessionFile: orphanTranscript,
        updatedAt,
      },
      "agent:main:dreaming-narrative-deep-live": {
        sessionId: "live-dreaming",
        sessionFile: liveTranscript,
        updatedAt,
      },
      "agent:main:kept-session": {
        sessionId: "still-live",
        sessionFile: path.join(sessionsDir, "still-live.jsonl"),
        updatedAt,
      },
    });
    await seedDreamingTranscriptEvent({
      sessionId: "orphan-dreaming",
      sessionKey: "agent:main:dreaming-narrative-deep-orphan",
      storePath,
      timestampMs: Date.now() - 600_000,
      runId: "dreaming-narrative-deep-orphan",
    });
    await seedDreamingTranscriptEvent({
      sessionId: "live-dreaming",
      sessionKey: "agent:main:dreaming-narrative-deep-live",
      storePath,
      timestampMs: Date.now(),
      runId: "dreaming-narrative-deep-live",
    });
    await fs.writeFile(orphanTranscript, '{"runId":"dreaming-narrative-deep-orphan"}\n', "utf-8");
    await fs.writeFile(liveTranscript, '{"runId":"dreaming-narrative-deep-live"}\n', "utf-8");
    await fs.writeFile(path.join(sessionsDir, "still-live.jsonl"), "{}\n", "utf-8");
    // Age the orphan transcript past the 5-minute orphan threshold; keep the
    // live transcript fresh.
    const aged = new Date(Date.now() - 600_000);
    await fs.utimes(orphanTranscript, aged, aged);

    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfig").mockReturnValue({
      session: {},
    } as never);
    setNarrativeTestEnv(stateDir);
    vi.mocked(resolveStateDir).mockReturnValue(stateDir);

    const subagent = createMockSubagent("A forgotten endpoint hummed in the dark.");
    const logger = createMockLogger();

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "light", snippets: ["memory fragment"] },
      logger,
    });

    const updatedStore = readSessionStoreEntries(storePath) as Record<string, unknown>;
    // The aged orphan dreaming row is reclaimed even though its transcript existed.
    expect(updatedStore).not.toHaveProperty("agent:main:dreaming-narrative-deep-orphan");
    // The fresh dreaming row and the non-dreaming row survive.
    expect(updatedStore).toHaveProperty("agent:main:dreaming-narrative-deep-live");
    expect(updatedStore).toHaveProperty("agent:main:kept-session");
    expect(
      loadTranscriptEventsSync({ agentId: "main", sessionId: "orphan-dreaming", storePath }),
    ).toEqual([]);
    expect(
      loadTranscriptEventsSync({ agentId: "main", sessionId: "live-dreaming", storePath }),
    ).not.toEqual([]);

    const sessionFiles = await fs.readdir(sessionsDir);
    // SQLite transcript state is archived while legacy JSONL support files are left alone.
    expect(sessionFiles).toContain("orphan-dreaming.jsonl");
    expect(sessionFiles).toContain("live-dreaming.jsonl");
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
    const deleteKeys = subagent.deleteSession.mock.calls.map(
      (call: unknown[]) => (call[0] as { sessionKey: string })?.sessionKey,
    );
    expect(deleteKeys.filter((key: string) => key === firstSessionKey)).toHaveLength(2);
    expect(deleteKeys.filter((key: string) => key === secondSessionKey)).toHaveLength(2);
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
    const workspaceDirs = await Promise.all(
      Array.from({ length: 5 }, () => createTempWorkspace("openclaw-dreaming-detach-")),
    );
    const logger = createMockLogger();

    for (const [i, workspaceDir] of workspaceDirs.entries()) {
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
      expect(subagent.deleteSession).toHaveBeenCalledTimes(10);
    });
    expect(subagent.run).toHaveBeenCalledTimes(5);
    expect(subagent.waitForRun).toHaveBeenCalledTimes(5);
  });

  it("serializes detached narratives that reuse a workspace and phase session", async () => {
    let nextRunId = 0;
    const waitDeferreds: Array<Deferred<{ status: string }>> = [];
    const subagent = {
      run: vi.fn(() => {
        nextRunId += 1;
        return Promise.resolve({ runId: `run-${nextRunId}` });
      }),
      waitForRun: vi.fn(() => {
        const d = deferred<{ status: string }>();
        waitDeferreds.push(d);
        return d.promise;
      }),
      getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };
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

    await vi.waitFor(() => {
      expect(waitDeferreds.length).toBe(1);
    });

    expect(subagent.run).toHaveBeenCalledTimes(1);
    expect(subagent.waitForRun).toHaveBeenCalledTimes(1);
    // The first run is still active, so later same-key jobs must not pre-delete its session.
    expect(subagent.deleteSession).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i += 1) {
      const currentDeferred = waitDeferreds[i];
      if (!currentDeferred) {
        throw new Error(`Expected wait deferred ${i} to exist`);
      }
      currentDeferred.resolve({ status: "timeout" });
      if (i < 4) {
        await vi.waitFor(() => {
          expect(waitDeferreds.length).toBeGreaterThan(i + 1);
        });
      }
    }

    await vi.waitFor(() => {
      expect(subagent.deleteSession).toHaveBeenCalledTimes(10);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
