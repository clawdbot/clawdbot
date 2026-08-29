// Memory Core tests cover dreaming narrative plugin behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  RequestScopedSubagentRuntimeError,
  SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE,
} from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
import { updateDreamsFile } from "./dreaming-dreams-file.js";
import {
  dedupeDreamDiaryEntries,
  readRecentDreamDiaryEntries,
  removeBackfillDiaryEntries,
  runDreamNarrative,
  writeBackfillDiaryEntries,
} from "./dreaming-narrative.js";
import {
  SHORT_TERM_LOCK_MAX_ENTRIES,
  SHORT_TERM_LOCK_NAMESPACE,
  memoryCoreWorkspaceStateKey,
  openMemoryCoreStateStore,
} from "./dreaming-state.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import { SESSION_CORPUS_RELATIVE_DIR } from "./session-ingestion.js";
import { readShortTermRecallEntries, recordShortTermRecalls } from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", { spy: true });

const { createTempWorkspace } = createMemoryCoreTestHarness();
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
  resolveGlobalMap<string, unknown>(NARRATIVE_SESSION_LOCKS_KEY).clear();
});

describe("dream diary file behavior", () => {
  it("does not restore deleted diary content from an update already in progress", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-forget-update-");
    setNarrativeTestEnv(path.join(workspaceDir, ".state"));
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    const claim = "A private cobalt archive phrase.";
    await fs.writeFile(dreamsPath, `# Diary\n\n## Session ID: forgotten\n${claim}\n`);
    const prepared = createDeferred<void>();
    const publish = createDeferred<void>();
    const update = updateDreamsFile({
      workspaceDir,
      updater: async (existing) => {
        expect(existing).toContain(claim);
        prepared.resolve();
        await publish.promise;
        return { content: `${existing}\n## Other\nA new unrelated entry.\n`, result: undefined };
      },
    });
    let forgotten: ReturnType<typeof forgetMemoryEntries> | undefined;
    try {
      await prepared.promise;
      const writerOwnsLock = await openMemoryCoreStateStore({
        namespace: SHORT_TERM_LOCK_NAMESPACE,
        maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
      }).lookup(memoryCoreWorkspaceStateKey(workspaceDir));
      forgotten = forgetMemoryEntries({
        cfg: { agents: { entries: { main: { workspace: workspaceDir } } } },
        agentId: "main",
        sessionIds: ["forgotten"],
      });
      if (!writerOwnsLock) {
        await forgotten;
      }
      publish.resolve();
      await Promise.all([update, forgotten]);
      const content = await fs.readFile(dreamsPath, "utf8");
      expect(content).not.toContain(claim);
      expect(content).toContain("A new unrelated entry.");
    } finally {
      publish.resolve();
      await Promise.allSettled([update, ...(forgotten ? [forgotten] : [])]);
    }
  });

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

describe("runDreamNarrative", () => {
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
    const expectedRunKey = `dreaming-narrative-main-light-${workspaceHash}`;
    const expectedSessionKey = `agent:main:dreaming-narrative-memory-core-v2-light-${workspaceHash}`;

    const outcome = await runDreamNarrative({
      agentId: "main",
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
    // The runId keeps the scrub marker's `dreaming-narrative-` prefix ahead of the agent scope.
    expect(runOptions.idempotencyKey).toBe(`${expectedRunKey}-${nowMs}`);
    expect(runOptions.idempotencyKey).toMatch(/^dreaming-narrative-/);
    expect(runOptions.sessionKey).toBe(expectedSessionKey);
    expect(runOptions.lane).toBe(`dreaming-narrative:${expectedSessionKey}`);
    expect(runOptions.lightContext).toBe(true);
    expect(runOptions.deliver).toBe(false);
    expect(runOptions.disableTools).toBe(true);
    expect(runOptions.promptMode).toBe("minimal");
    expect(runOptions.model).toBe("anthropic/claude-sonnet-4-6");
    expect(subagent.waitForRun).toHaveBeenCalledOnce();
    expect(subagent.deleteSession).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ status: "completed" });

    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(content).toContain("The repository whispered of forgotten endpoints.");
    expect(logger.info).toHaveBeenCalled();
  });

  it("keeps creation and cleanup on the memory-core-owned session identity", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-owner-");
    const workspaceHash = createHash("sha1").update(workspaceDir).digest("hex").slice(0, 12);
    const legacyUnownedKey = `agent:blockdigest:dreaming-narrative-rem-${workspaceHash}`;
    const ownedKey = `agent:blockdigest:dreaming-narrative-memory-core-v2-rem-${workspaceHash}`;
    const subagent = createMockSubagent("The digest folded itself into a paper moon.");
    subagent.deleteSession.mockImplementation(async ({ sessionKey }: { sessionKey: string }) => {
      if (sessionKey === legacyUnownedKey) {
        throw new Error('Plugin "memory-core" cannot delete session because it did not create it');
      }
    });
    const logger = createMockLogger();

    const outcome = await runDreamNarrative({
      agentId: "blockdigest",
      subagent,
      workspaceDir,
      data: { phase: "rem", snippets: ["A digest session needs one lifecycle owner."] },
      logger,
    });

    expect(mockObjectArg(subagent.run, "subagent run").sessionKey).toBe(ownedKey);
    expect(
      subagent.deleteSession.mock.calls.map(
        (call: unknown[]) => (call[0] as { sessionKey: string }).sessionKey,
      ),
    ).toEqual([ownedKey, ownedKey]);
    expect(outcome).toEqual({ status: "completed" });
    expectLogExcludes(logger.warn, "did not create it");
  });

  // Regression: unscoped narrative session keys cannot be resolved to a per-agent SQLite
  // store, so every subagent call failed with "Cannot resolve SQLite session scope without
  // an agent id" and the whole dreaming pipeline produced nothing.
  it("scopes narrative sessions to the workspace's owning agent", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("The night shift agent kept its own notebook.");
    const logger = createMockLogger();
    const nowMs = Date.parse("2026-04-05T03:00:00Z");
    const workspaceHash = createHash("sha1").update(workspaceDir).digest("hex").slice(0, 12);
    const sessionSuffix = `dreaming-narrative-memory-core-v2-rem-${workspaceHash}`;

    await runDreamNarrative({
      agentId: "researcher",
      subagent,
      workspaceDir,
      data: { phase: "rem", snippets: ["The index remembered a second agent."] },
      nowMs,
      timezone: "UTC",
      logger,
    });

    expect(mockObjectArg(subagent.run, "subagent run").sessionKey).toBe(
      `agent:researcher:${sessionSuffix}`,
    );
    expect(mockObjectArg(subagent.deleteSession, "delete session")).toEqual({
      sessionKey: `agent:researcher:${sessionSuffix}`,
    });
    // The runId names its owning agent too, so two agents sharing a workspace cannot collide
    // on one run; the scrub marker still matches because the agent scope follows the prefix.
    expect(mockObjectArg(subagent.run, "subagent run").idempotencyKey).toBe(
      `dreaming-narrative-researcher-rem-${workspaceHash}-${nowMs}`,
    );
    expectLogExcludes(logger.warn, "narrative generation failed");
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

      const operation = runDreamNarrative({
        agentId: "main",
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
        sessionKey: expect.stringContaining("dreaming-narrative-memory-core-v2-light-"),
        limit: expect.any(Number),
      });
      expect(subagent.getSessionMessages).toHaveBeenNthCalledWith(2, {
        sessionKey: expect.stringContaining("dreaming-narrative-memory-core-v2-light-"),
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

  it("writes the terminal reply text without polling the session store", async () => {
    vi.useFakeTimers();
    try {
      const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
      const subagent = createMockSubagent("");
      subagent.waitForRun.mockResolvedValue({
        status: "ok",
        terminalReply: {
          disposition: "visible",
          text: "The terminal reply carried the diary safely.",
        },
      });
      // Simulate the sibling-cleanup race from #123360: the store never shows the
      // completed run's text within the settle window.
      subagent.getSessionMessages.mockResolvedValue({ messages: [] });
      const logger = createMockLogger();

      const operation = runDreamNarrative({
        agentId: "main",
        subagent,
        workspaceDir,
        data: {
          phase: "light",
          snippets: ["The narrative raced a sibling phase's cleanup."],
        },
        nowMs: Date.parse("2026-04-05T03:00:00Z"),
        timezone: "UTC",
        logger,
      });
      await flushNarrativeSettleTimers(operation);

      expect(subagent.getSessionMessages).not.toHaveBeenCalled();
      const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
      expect(content).toContain("The terminal reply carried the diary safely.");
      expect(content).not.toContain("A memory trace surfaced");
      expectLogExcludes(logger.warn, "produced no text");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { label: "empty", reply: { disposition: "empty" } },
    { label: "silent", reply: { disposition: "silent" } },
    // `message-tool-not-called` is an explicit no-text fact too; history must
    // not resurface a transcript for it.
    {
      label: "empty (message-tool-not-called)",
      reply: { disposition: "empty", code: "message-tool-not-called" },
    },
  ] as const)(
    "treats an explicit $label terminal reply as authoritative no-text and never reads history",
    async ({ reply }) => {
      vi.useFakeTimers();
      try {
        const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
        const subagent = createMockSubagent("");
        subagent.waitForRun.mockResolvedValue({
          status: "ok",
          // Any `text` beside a non-visible disposition must be ignored.
          terminalReply: { ...reply, text: "text that must be ignored" },
        });
        // The store holds an OLD narrative from a previous run; reading it would
        // resurface stale text over the authoritative no-text result.
        subagent.getSessionMessages.mockResolvedValue({
          messages: [
            { role: "user", content: "prompt" },
            { role: "assistant", content: "A stale narrative from a previous run." },
          ],
        });
        const logger = createMockLogger();

        const operation = runDreamNarrative({
          agentId: "main",
          subagent,
          workspaceDir,
          data: {
            phase: "rem",
            snippets: ["The run was silent, so history must not speak for it."],
          },
          nowMs: Date.parse("2026-04-05T03:00:00Z"),
          timezone: "UTC",
          logger,
        });
        await flushNarrativeSettleTimers(operation);

        expect(subagent.getSessionMessages).not.toHaveBeenCalled();
        const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
        expect(content).toContain("A memory trace surfaced");
        expect(content).not.toContain("A stale narrative from a previous run.");
        expect(content).not.toContain("text that must be ignored");
        expectLogIncludes(logger.warn, "produced no text");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("treats a visible terminal reply with only whitespace as no-text", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("");
    subagent.waitForRun.mockResolvedValue({
      status: "ok",
      terminalReply: { disposition: "visible", text: "   \n  " },
    });
    subagent.getSessionMessages.mockResolvedValue({
      messages: [
        { role: "user", content: "prompt" },
        { role: "assistant", content: "A stale narrative from a previous run." },
      ],
    });
    const logger = createMockLogger();

    await runDreamNarrative({
      agentId: "main",
      subagent,
      workspaceDir,
      data: {
        phase: "light",
        snippets: ["A blank diary page must not borrow yesterday's words."],
      },
      nowMs: Date.parse("2026-04-05T03:00:00Z"),
      timezone: "UTC",
      logger,
    });

    expect(subagent.getSessionMessages).not.toHaveBeenCalled();
    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(content).toContain("A memory trace surfaced");
    expect(content).not.toContain("A stale narrative from a previous run.");
    expectLogIncludes(logger.warn, "produced no text");
  });

  it("falls back after settled assistant text never appears", async () => {
    vi.useFakeTimers();
    try {
      const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
      const subagent = createMockSubagent("");
      const logger = createMockLogger();

      const operation = runDreamNarrative({
        agentId: "main",
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
    const expectedSessionKey = `agent:main:dreaming-narrative-memory-core-v2-light-${workspaceHash}`;
    const retrySessionKey = `${expectedSessionKey}-retry-1`;

    await runDreamNarrative({
      agentId: "main",
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
    const expectedSessionKey = `agent:main:dreaming-narrative-memory-core-v2-rem-${workspaceHash}`;
    const retrySessionKey = `${expectedSessionKey}-retry-1`;

    await runDreamNarrative({
      agentId: "main",
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

    await runDreamNarrative({
      agentId: "main",
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

    await runDreamNarrative({
      agentId: "main",
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

    await runDreamNarrative({
      agentId: "main",
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

    await runDreamNarrative({
      agentId: "main",
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

    const outcome = await runDreamNarrative({
      agentId: "main",
      subagent,
      workspaceDir,
      data: { phase: "rem", snippets: ["some memory"] },
      logger,
    });

    expect(subagent.waitForRun).toHaveBeenCalledOnce();
    expect(mockObjectArg(subagent.waitForRun, "wait for run").timeoutMs).toBe(60_000);
    expectLogIncludes(logger.warn, "narrative session cleanup failed for rem phase");
    expect(outcome).toEqual({ status: "degraded", error: "still active" });
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

    await runDreamNarrative({
      agentId: "main",
      subagent,
      workspaceDir,
      data: { phase: "rem", snippets: ["pattern surfaced"] },
      logger,
    });

    // Should not throw, and an unexpected failure still leaves a dated diary trace
    // instead of silently skipping the entry.
    expectLogIncludes(logger.warn, "narrative generation failed");
    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(content).not.toContain("pattern surfaced");
    expect(content).toContain("A memory trace surfaced, but details were unavailable in this run.");
  });

  it("falls back to a local narrative when subagent runtime is request-scoped", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("");
    subagent.deleteSession.mockRejectedValueOnce(new RequestScopedSubagentRuntimeError());
    subagent.run.mockRejectedValue(new RequestScopedSubagentRuntimeError());
    const logger = createMockLogger();

    await runDreamNarrative({
      agentId: "main",
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

    await runDreamNarrative({
      agentId: "main",
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

    await runDreamNarrative({
      agentId: "main",
      subagent,
      workspaceDir,
      data: { phase: "deep", snippets: ["should not persist"] },
      logger,
    });

    // A spoofed code must not be treated as the request-scoped runtime, so this stays on the
    // unexpected-failure path: warn plus a generic fallback entry, never the request-scoped info.
    expectLogIncludes(logger.warn, "narrative generation failed");
    expectLogExcludes(logger.info, "request-scoped");
    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(content).not.toContain("should not persist");
    expect(content).toContain("A memory trace surfaced, but details were unavailable in this run.");
  });

  it("cleans up session even on failure", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = createMockSubagent("");
    subagent.getSessionMessages.mockRejectedValue(new Error("fetch failed"));
    const logger = createMockLogger();

    await runDreamNarrative({
      agentId: "main",
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
        updatedAt: updatedAt - 600_000,
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

    await runDreamNarrative({
      agentId: "main",
      subagent,
      workspaceDir,
      data: { phase: "light", snippets: ["memory fragment"] },
      logger,
    });

    const updatedStore = readSessionStoreEntries(storePath) as Record<string, unknown>;
    expect(updatedStore).not.toHaveProperty("agent:main:dreaming-narrative-light-1");
    expect(updatedStore).toHaveProperty("agent:main:dreaming-narrative-corrupt-normal");
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
        updatedAt: updatedAt - 600_000,
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

    await runDreamNarrative({
      agentId: "main",
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

    await runDreamNarrative({
      agentId: "main",
      subagent,
      workspaceDir: firstWorkspaceDir,
      data: { phase: "light", snippets: ["first workspace fragment"] },
      nowMs,
      logger,
    });
    await runDreamNarrative({
      agentId: "main",
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
    expect(firstSessionKey).toContain("dreaming-narrative-memory-core-v2-light-");
    expect(secondSessionKey).toContain("dreaming-narrative-memory-core-v2-light-");
    const deleteKeys = subagent.deleteSession.mock.calls.map(
      (call: unknown[]) => (call[0] as { sessionKey: string })?.sessionKey,
    );
    expect(deleteKeys.filter((key: string) => key === firstSessionKey)).toHaveLength(2);
    expect(deleteKeys.filter((key: string) => key === secondSessionKey)).toHaveLength(2);
  });
});

describe("runDreamNarrative deletion boundary", () => {
  it.each([
    { source: "tracked source", mutation: "forget" },
    { source: "prior diary", mutation: "forget" },
    { source: "prior diary", mutation: "unrelated append" },
  ] as const)(
    "validates $source before publishing generated quotes after $mutation",
    async ({ source, mutation }) => {
      const workspaceDir = await createTempWorkspace("dreaming-forget-generated-");
      setNarrativeTestEnv(path.join(workspaceDir, ".state"));
      const nowMs = Date.now();
      const claim = "The private cobalt archive opens every midnight.";
      const retainedClaim = "A public archive is open throughout the afternoon.";
      const sourcePath = "memory/2026-08-26.md";
      const dreamsPath = path.join(workspaceDir, "DREAMS.md");
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, sourcePath), `${claim}\n${retainedClaim}\n`);
      await fs.mkdir(path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR), { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR, "2026-08-26.txt"),
        `[main:forgotten-narrative-source#L1] ${claim}\n`,
      );
      await fs.writeFile(dreamsPath, "# Dream Diary\n\nA retained public diary entry.\n");
      await recordShortTermRecalls({
        workspaceDir,
        query: "archive opening time",
        signalType: "daily",
        nowMs,
        results: [
          {
            path: sourcePath,
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: claim,
            source: "memory",
            sessionOrigin: { agentId: "main", sessionId: "forgotten-narrative-source" },
          },
          {
            path: sourcePath,
            startLine: 2,
            endLine: 2,
            score: 0.9,
            snippet: retainedClaim,
            source: "memory",
          },
        ],
      });
      const entries = (await readShortTermRecallEntries({ workspaceDir, nowMs })).filter(
        (entry) => entry.snippet === (source === "prior diary" ? retainedClaim : claim),
      );
      if (source === "prior diary") {
        await writeBackfillDiaryEntries({
          workspaceDir,
          preserveExisting: true,
          entries: [{ isoDay: "2026-08-26", bodyLines: [claim] }],
        });
      }
      const waiting = createDeferred<void>();
      const terminal = createDeferred<{
        status: string;
        terminalReply: { disposition: "visible"; text: string };
      }>();
      const reply = {
        status: "ok",
        terminalReply: { disposition: "visible" as const, text: `I remembered: ${claim}` },
      };
      const subagent = {
        run: vi.fn().mockResolvedValue({ runId: "generated-after-forget" }),
        waitForRun: vi.fn(async () => {
          waiting.resolve();
          return await terminal.promise;
        }),
        getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      };
      const data = {
        phase: "light" as const,
        snippets: entries.map((entry) => entry.snippet),
        sourceEntryKeys: entries.map((entry) => entry.key),
        ...(source === "prior diary"
          ? { recentDiaryEntries: await readRecentDreamDiaryEntries({ workspaceDir }) }
          : {}),
      };
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const operation = runDreamNarrative({
        agentId: "main",
        subagent,
        workspaceDir,
        data,
        nowMs,
        logger,
      });
      try {
        await waiting.promise;
        expect(mockObjectArg(subagent.run, "subagent run").message).toContain(claim);
        if (mutation === "forget") {
          const forgotten = await forgetMemoryEntries({
            cfg: { agents: { entries: { main: { workspace: workspaceDir } } } },
            agentId: "main",
            sessionIds: ["forgotten-narrative-source"],
          });
          expect(forgotten.artifacts.shortTermEntries).toBe(1);
          expect(await fs.readFile(dreamsPath, "utf8")).not.toContain(claim);
        } else {
          // The original context remains valid even after it falls outside
          // the recent-entry window used to prepare the next narrative.
          await writeBackfillDiaryEntries({
            workspaceDir,
            preserveExisting: true,
            entries: Array.from({ length: 4 }, (_, index) => ({
              isoDay: "2026-08-26",
              bodyLines: [`Another retained diary entry ${index}.`],
            })),
          });
        }
        terminal.resolve(reply);
        const outcome = await operation;
        const content = await fs.readFile(dreamsPath, "utf8");
        expect(content).toContain("A retained public diary entry.");
        if (mutation === "forget") {
          expect(content).not.toContain(claim);
          expect(outcome).toEqual({ status: "skipped" });
          expectLogIncludes(logger.info, "narrative publication skipped");
        } else {
          expect(content).toContain(reply.terminalReply.text);
          expect(outcome).toEqual({ status: "completed" });
        }
      } finally {
        terminal.resolve(reply);
        await operation;
      }
    },
  );
});

describe("runDreamNarrative ownership gate", () => {
  it("keeps the sweep alive with a local fallback when no owning agent is known", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = {
      run: vi.fn(),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      deleteSession: vi.fn(),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await runDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "light", snippets: ["An ownerless sweep still leaves a trace."] },
      nowMs: Date.parse("2026-04-05T03:00:00Z"),
      timezone: "UTC",
      logger,
    });

    // No agent means no resolvable session store, so the subagent is never called.
    expect(subagent.run).not.toHaveBeenCalled();
    expect(subagent.deleteSession).not.toHaveBeenCalled();
    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(content).not.toContain("An ownerless sweep still leaves a trace.");
    expect(content).toContain("A memory trace surfaced, but details were unavailable in this run.");
    expectLogIncludes(logger.info, "no owning agent id");
  });

  it("queues the ownerless fallback through detached dispatch", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = {
      run: vi.fn(),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      deleteSession: vi.fn(),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // A detached cron sweep must not await the diary write, so the ownerless fallback rides
    // the same limiter as the subagent path instead of blocking inline.
    await runDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "light", snippets: ["A detached ownerless sweep still leaves a trace."] },
      nowMs: Date.parse("2026-04-05T03:00:00Z"),
      timezone: "UTC",
      logger,
      detached: true,
    });

    expect(subagent.run).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      expect(await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8")).toContain(
        "A memory trace surfaced, but details were unavailable in this run.",
      );
    });
  });

  it("stays a no-op for an ownerless sweep with nothing to narrate", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-narrative-");
    const subagent = {
      run: vi.fn(),
      waitForRun: vi.fn(),
      getSessionMessages: vi.fn(),
      deleteSession: vi.fn(),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await runDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "light", snippets: [] },
      nowMs: Date.parse("2026-04-05T03:00:00Z"),
      timezone: "UTC",
      logger,
    });

    // Empty narrative data is a no-op with or without an owner; the ownership fallback must
    // not invent a diary entry for material that never existed.
    expect(subagent.run).not.toHaveBeenCalled();
    await expectPathMissing(path.join(workspaceDir, "DREAMS.md"));
  });
});

describe("runDreamNarrative detached dispatch", () => {
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
      void runDreamNarrative({
        agentId: "main",
        subagent,
        workspaceDir,
        data: { phase: "light", snippets: [`fragment-${i}`] },
        nowMs: Date.parse("2026-04-28T03:00:00Z"),
        logger,
        detached: true,
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
      void runDreamNarrative({
        agentId: "main",
        subagent,
        workspaceDir,
        data: { phase: "light", snippets: [`fragment-${i}`] },
        nowMs: Date.parse("2026-04-28T03:00:00Z"),
        logger,
        detached: true,
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
      void runDreamNarrative({
        agentId: "main",
        subagent,
        workspaceDir,
        data: { phase: "light", snippets: ["fragment"] },
        nowMs: Date.parse("2026-04-28T03:00:00Z"),
        logger,
        detached: true,
      });

      await drainMicrotasks();

      expect(subagent.run).toHaveBeenCalledOnce();
      expect(unhandled).not.toHaveBeenCalled();
      // Settle the detached fallback write before the fixture workspace is torn down.
      await vi.waitFor(async () => {
        expect(await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8")).toContain(
          "A memory trace surfaced, but details were unavailable in this run.",
        );
      });
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
