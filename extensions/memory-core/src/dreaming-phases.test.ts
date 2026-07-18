// Memory Core tests cover dreaming phases plugin behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { RequestScopedSubagentRuntimeError } from "openclaw/plugin-sdk/error-runtime";
import {
  resolveMemoryDreamingPluginConfig,
  resolveSessionTranscriptsDirForAgent,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { formatSqliteSessionFileMarker } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  filterRecallEntriesWithinLookback,
  previewRemDreaming,
  runDreamingSweepPhases,
  seedHistoricalDailyMemorySignals,
} from "./dreaming-phases.js";
import { previewRemHarness } from "./rem-harness.js";
import {
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
  type ShortTermRecallEntry,
} from "./short-term-promotion.js";
import {
  createMemoryCoreTestHarness,
  dreamingTestState,
  shortTermTestState as shortTermTesting,
} from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
const DREAMING_TEST_BASE_TIME = new Date("2026-04-05T10:00:00.000Z");
const DREAMING_TEST_DAY = "2026-04-05";
const LIGHT_SLEEP_EVENT_TEXT = "__openclaw_memory_core_light_sleep__";
const REM_SLEEP_EVENT_TEXT = "__openclaw_memory_core_rem_sleep__";
const originalDreamingTestFast = process.env.OPENCLAW_TEST_FAST;
const originalDreamingStateDir = process.env.OPENCLAW_STATE_DIR;
const EMPTY_SESSION_CONTENT_HASH =
  "75a11da44c802486bc6f65640aa48a730f0f684c5c07a42ba3cd1735eb3fb070";
const LIGHT_DREAMING_TEST_CONFIG: OpenClawConfig = {
  plugins: {
    entries: {
      "memory-core": {
        config: {
          dreaming: {
            enabled: true,
            timezone: "UTC",
            // The existing tests in this file were written when "inline" was the
            // default storage mode and assert against `memory/<day>.md` directly.
            // Pin the storage mode explicitly so they keep covering inline mode
            // after the default flipped to "separate" in #66328.
            storage: { mode: "inline", separateReports: false },
            phases: {
              light: {
                enabled: true,
                limit: 20,
                lookbackDays: 2,
              },
            },
          },
        },
      },
    },
  },
};

function setDreamingTestEnv(stateDir: string): void {
  Reflect.set(process.env, "OPENCLAW_TEST_FAST", "1");
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
  clearRuntimeConfigSnapshot();
}

function restoreDreamingTestEnv(): void {
  if (originalDreamingTestFast === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_TEST_FAST");
  } else {
    Reflect.set(process.env, "OPENCLAW_TEST_FAST", originalDreamingTestFast);
  }
  if (originalDreamingStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalDreamingStateDir);
  }
  clearRuntimeConfigSnapshot();
}

afterEach(() => {
  restoreDreamingTestEnv();
});

function requireCandidateByKey<T extends { key: string }>(candidates: T[], key: string): T {
  const candidate = candidates.find((entry) => entry.key === key);
  if (!candidate) {
    throw new Error(`expected promotion candidate ${key}`);
  }
  return candidate;
}

function requireCandidateKeyByPath(
  candidates: Array<{ key: string; path: string }>,
  predicate: (path: string) => boolean,
  label: string,
): string {
  const key = candidates.find((candidate) => predicate(candidate.path))?.key;
  if (!key) {
    throw new Error(`expected promotion candidate key for ${label}`);
  }
  return key;
}

function mockStringMessages(mock: { mock: { calls: unknown[][] } }): string[] {
  return mock.mock.calls.map((call) => {
    const message = call[0];
    return typeof message === "string" ? message : "";
  });
}

function expectIncludesSubstring(values: readonly string[], expected: string): void {
  expect(values.join("\n")).toContain(expected);
}

function expectNotIncludesSubstring(values: readonly string[], expected: string): void {
  expect(values.join("\n")).not.toContain(expected);
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      expect(error.code).toBe("ENOENT");
      return;
    }
    throw error;
  }
  throw new Error(`expected path to be missing: ${targetPath}`);
}

function requireFirstIngestionEntry(sessionIngestion: {
  files: Record<string, { lineCount: number; lastContentLine: number; contentHash: string }>;
}) {
  const firstEntry = Object.values(sessionIngestion.files)[0];
  if (!firstEntry) {
    throw new Error("expected session ingestion entry");
  }
  return firstEntry;
}

async function seedDreamingSessionTranscript(params: {
  agentId?: string;
  messages: Array<{
    role: "assistant" | "user";
    content: unknown;
    timestamp: number | string;
  }>;
  sessionId: string;
  sessionKey?: string;
}): Promise<void> {
  const agentId = params.agentId ?? "main";
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const storePath = path.join(sessionsDir, "sessions.json");
  const sessionKey = params.sessionKey ?? `agent:${agentId}:dreaming:${params.sessionId}`;
  const timestamps = params.messages
    .map((message) =>
      typeof message.timestamp === "number" ? message.timestamp : Date.parse(message.timestamp),
    )
    .filter((timestamp) => Number.isFinite(timestamp));
  // Accessor writes run normal maintenance; keep fixture entries fresh while
  // retaining per-message timestamps as the dreaming corpus clock.
  const updatedAt = Math.max(Date.now(), ...timestamps);
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionFile = formatSqliteSessionFileMarker({
    agentId,
    sessionId: params.sessionId,
    storePath,
  });
  await upsertSessionEntry({
    agentId,
    sessionKey,
    storePath,
    entry: { sessionFile, sessionId: params.sessionId, updatedAt },
  });
  for (const message of params.messages) {
    await appendSessionTranscriptMessageByIdentity({
      agentId,
      sessionId: params.sessionId,
      sessionKey,
      storePath,
      message: {
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
      },
    });
  }
  await upsertSessionEntry({
    agentId,
    sessionKey,
    storePath,
    entry: { sessionFile, sessionId: params.sessionId, updatedAt },
  });
}

function createHarness(
  config: OpenClawConfig,
  workspaceDir?: string,
  subagent?: Parameters<typeof runDreamingSweepPhases>[0]["subagent"],
) {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const resolvedConfig = workspaceDir
    ? {
        ...config,
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            workspace: workspaceDir,
            userTimezone: config.agents?.defaults?.userTimezone ?? "UTC",
          },
        },
      }
    : {
        ...config,
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            userTimezone: config.agents?.defaults?.userTimezone ?? "UTC",
          },
        },
      };
  const pluginConfig = resolveMemoryDreamingPluginConfig(resolvedConfig) ?? {};
  const beforeAgentReply = async (
    event: { cleanedBody: string },
    ctx: { trigger?: string; workspaceDir?: string },
  ) => {
    if (ctx.trigger !== "heartbeat") {
      return undefined;
    }
    const selectedPhase = event.cleanedBody.includes(LIGHT_SLEEP_EVENT_TEXT)
      ? "light"
      : event.cleanedBody.includes(REM_SLEEP_EVENT_TEXT)
        ? "rem"
        : undefined;
    if (!selectedPhase) {
      return undefined;
    }
    const activeWorkspace = ctx.workspaceDir ?? workspaceDir;
    if (!activeWorkspace) {
      logger.warn(
        `memory-core: ${selectedPhase} dreaming skipped because no memory workspace is available.`,
      );
      return { handled: true, reason: `memory-core: ${selectedPhase} dreaming missing workspace` };
    }
    const dreamingConfig = (pluginConfig.dreaming ?? {}) as Record<string, unknown>;
    const phaseConfigs = (dreamingConfig.phases ?? {}) as Record<string, unknown>;
    const lightConfig = (phaseConfigs.light ?? {}) as Record<string, unknown>;
    const remConfig = (phaseConfigs.rem ?? {}) as Record<string, unknown>;
    const selectedPluginConfig = {
      ...pluginConfig,
      dreaming: {
        ...dreamingConfig,
        phases: {
          ...phaseConfigs,
          light: {
            ...lightConfig,
            enabled: selectedPhase === "light" && lightConfig.enabled !== false,
          },
          rem: {
            ...remConfig,
            enabled: selectedPhase === "rem" && remConfig.enabled !== false,
          },
        },
      },
    };
    await runDreamingSweepPhases({
      workspaceDir: activeWorkspace,
      pluginConfig: selectedPluginConfig,
      cfg: resolvedConfig,
      logger,
      subagent,
      detachNarratives: false,
    });
    return { handled: true, reason: `memory-core: ${selectedPhase} dreaming processed` };
  };
  return { beforeAgentReply, logger };
}

function createMockNarrativeSubagent(response = "The archive hummed softly.") {
  const run = vi.fn(async (_params: { sessionKey: string; message: string; model?: string }) => ({
    runId: "dream-run-1",
  }));
  const waitForRun = vi.fn(async () => ({ status: "ok" }));
  const getSessionMessages = vi.fn(async () => ({
    messages: [{ role: "assistant", content: response }],
  }));
  const deleteSession = vi.fn(async () => {});
  return {
    run,
    waitForRun,
    getSessionMessages,
    deleteSession,
  };
}

function firstNarrativeRun(subagent: ReturnType<typeof createMockNarrativeSubagent>) {
  const firstRun = subagent.run.mock.calls[0]?.[0];
  if (!firstRun) {
    throw new Error("expected narrative subagent run");
  }
  return firstRun;
}

function setDreamingTestTime(offsetMinutes = 0) {
  vi.setSystemTime(new Date(DREAMING_TEST_BASE_TIME.getTime() + offsetMinutes * 60_000));
}

async function withDreamingTestClock(run: () => Promise<void>) {
  vi.useFakeTimers();
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}

async function writeDailyNote(workspaceDir: string, lines: string[]): Promise<void> {
  await fs.writeFile(
    path.join(workspaceDir, "memory", `${DREAMING_TEST_DAY}.md`),
    lines.join("\n"),
    "utf-8",
  );
}

function dailyCapStressLines(label: string): string[] {
  return Array.from({ length: 8 }).flatMap((_, index) => [
    `- ${label} durable memory item ${index + 1} has enough detail to create a chunk.`,
    "",
  ]);
}

async function createDreamingWorkspace(): Promise<string> {
  const workspaceDir = await createTempWorkspace("openclaw-dreaming-phases-");
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  return workspaceDir;
}

function createLightDreamingHarness(workspaceDir: string) {
  return createHarness(LIGHT_DREAMING_TEST_CONFIG, workspaceDir);
}

async function triggerLightDreaming(
  beforeAgentReply: NonNullable<ReturnType<typeof createHarness>["beforeAgentReply"]>,
  workspaceDir: string,
  offsetMinutes: number,
): Promise<void> {
  setDreamingTestTime(offsetMinutes);
  await beforeAgentReply(
    { cleanedBody: "__openclaw_memory_core_light_sleep__" },
    { trigger: "heartbeat", workspaceDir },
  );
}

async function readCandidateSnippets(workspaceDir: string, nowIso: string): Promise<string[]> {
  const candidates = await rankShortTermPromotionCandidates({
    workspaceDir,
    minScore: 0,
    minRecallCount: 0,
    minUniqueQueries: 0,
    nowMs: Date.parse(nowIso),
  });
  return candidates.map((candidate) => candidate.snippet);
}

describe("memory-core dreaming phases", () => {
  it("uses the hashed narrative session key for sweep-level fallback cleanup", async () => {
    const workspaceDir = await createDreamingWorkspace();
    await writeDailyNote(workspaceDir, [
      `# ${DREAMING_TEST_DAY}`,
      "",
      "- Move backups to S3 Glacier.",
      "- Keep retention at 365 days.",
    ]);
    const testConfig: OpenClawConfig = {
      ...LIGHT_DREAMING_TEST_CONFIG,
      agents: {
        defaults: {
          workspace: workspaceDir,
          userTimezone: "UTC",
        },
      },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                enabled: true,
                timezone: "UTC",
                phases: {
                  light: {
                    enabled: true,
                    limit: 20,
                    lookbackDays: 2,
                  },
                  rem: {
                    enabled: false,
                    limit: 0,
                    lookbackDays: 2,
                  },
                },
              },
            },
          },
        },
      },
    };
    const subagent = createMockNarrativeSubagent("The archive hummed softly.");
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const nowMs = Date.parse("2026-04-05T10:05:00.000Z");
    const workspaceHash = createHash("sha1").update(workspaceDir).digest("hex").slice(0, 12);
    const expectedSessionKey = `dreaming-narrative-light-${workspaceHash}`;

    await runDreamingSweepPhases({
      workspaceDir,
      cfg: testConfig,
      pluginConfig: resolveMemoryDreamingPluginConfig(testConfig),
      logger,
      subagent,
      nowMs,
    });

    expect(subagent.deleteSession).toHaveBeenCalledTimes(2);
    expect(subagent.deleteSession).toHaveBeenNthCalledWith(1, { sessionKey: expectedSessionKey });
    expect(subagent.deleteSession).toHaveBeenNthCalledWith(2, { sessionKey: expectedSessionKey });
  });

  it("suppresses cleanup warnings during request-scoped narrative fallback", async () => {
    const workspaceDir = await createDreamingWorkspace();
    await writeDailyNote(workspaceDir, [
      `# ${DREAMING_TEST_DAY}`,
      "",
      "- Move backups to S3 Glacier.",
      "- Keep retention at 365 days.",
    ]);
    const testConfig: OpenClawConfig = {
      ...LIGHT_DREAMING_TEST_CONFIG,
      agents: {
        defaults: {
          workspace: workspaceDir,
          userTimezone: "UTC",
        },
      },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                enabled: true,
                timezone: "UTC",
                phases: {
                  light: {
                    enabled: true,
                    limit: 20,
                    lookbackDays: 2,
                  },
                  rem: {
                    enabled: false,
                    limit: 0,
                    lookbackDays: 2,
                  },
                },
              },
            },
          },
        },
      },
    };
    const subagent = createMockNarrativeSubagent();
    subagent.run.mockRejectedValue(new RequestScopedSubagentRuntimeError());
    subagent.deleteSession.mockImplementation(() => {
      throw new RequestScopedSubagentRuntimeError();
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await expect(
      runDreamingSweepPhases({
        workspaceDir,
        cfg: testConfig,
        pluginConfig: resolveMemoryDreamingPluginConfig(testConfig),
        logger,
        subagent,
        nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
      }),
    ).resolves.toBeUndefined();

    const dreams = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(dreams).toContain("A memory trace surfaced, but details were unavailable in this run.");
    expect(dreams).not.toContain("Move backups to S3 Glacier.");
    expect(logger.error).not.toHaveBeenCalled();
    expectIncludesSubstring(mockStringMessages(logger.info), "request-scoped");
    expectNotIncludesSubstring(mockStringMessages(logger.warn), "request-scoped");
    expectNotIncludesSubstring(mockStringMessages(logger.warn), "narrative pre-cleanup");
    expectNotIncludesSubstring(mockStringMessages(logger.warn), "narrative session cleanup failed");
    expect(subagent.deleteSession).toHaveBeenCalledOnce();
  });

  it("does not re-ingest managed light dreaming blocks from daily notes", async () => {
    const workspaceDir = await createDreamingWorkspace();
    await withDreamingTestClock(async () => {
      await writeDailyNote(workspaceDir, [
        `# ${DREAMING_TEST_DAY}`,
        "",
        "- Move backups to S3 Glacier.",
        "- Keep retention at 365 days.",
      ]);

      const { beforeAgentReply } = createLightDreamingHarness(workspaceDir);
      const candidateCounts: number[] = [];
      const candidateSnippets: string[][] = [];
      for (let run = 0; run < 3; run += 1) {
        await triggerLightDreaming(beforeAgentReply, workspaceDir, run + 1);
        candidateSnippets.push(
          await readCandidateSnippets(workspaceDir, `2026-04-05T10:0${run + 1}:00.000Z`),
        );
        candidateCounts.push(candidateSnippets.at(-1)?.length ?? 0);
      }

      expect(candidateCounts).toEqual([1, 1, 1]);
      expect(candidateSnippets).toEqual([
        ["Move backups to S3 Glacier.; Keep retention at 365 days."],
        ["Move backups to S3 Glacier.; Keep retention at 365 days."],
        ["Move backups to S3 Glacier.; Keep retention at 365 days."],
      ]);

      const dailyContent = await fs.readFile(
        path.join(workspaceDir, "memory", `${DREAMING_TEST_DAY}.md`),
        "utf-8",
      );
      expect(dailyContent).toContain("## Light Sleep");
      expect(dailyContent).toContain("- No notable updates.");
      expect(dailyContent.match(/^- Candidate:/gm) ?? []).toHaveLength(0);
      expect(dailyContent).not.toContain("Light Sleep: Candidate:");
    });
  });

  it("does not restage unchanged light candidates in later cycles", async () => {
    const workspaceDir = await createDreamingWorkspace();
    await withDreamingTestClock(async () => {
      await writeDailyNote(workspaceDir, [
        `# ${DREAMING_TEST_DAY}`,
        "",
        "- Added primary issue extraction for pain notifications.",
        "- Updated signals cron notification style.",
      ]);

      const { beforeAgentReply } = createLightDreamingHarness(workspaceDir);
      await triggerLightDreaming(beforeAgentReply, workspaceDir, 1);

      const firstCycle = await fs.readFile(
        path.join(workspaceDir, "memory", `${DREAMING_TEST_DAY}.md`),
        "utf-8",
      );
      expect(firstCycle).toContain(
        "Added primary issue extraction for pain notifications.; Updated signals cron notification style.",
      );

      await triggerLightDreaming(beforeAgentReply, workspaceDir, 61);

      const secondCycle = await fs.readFile(
        path.join(workspaceDir, "memory", `${DREAMING_TEST_DAY}.md`),
        "utf-8",
      );
      expect(secondCycle).toContain("- No notable updates.");
      expect(secondCycle).not.toContain(
        "Added primary issue extraction for pain notifications.; Updated signals cron notification style.",
      );
    });
  });

  it("restages same-day light candidates after daily note content changes", async () => {
    const workspaceDir = await createDreamingWorkspace();
    await withDreamingTestClock(async () => {
      await writeDailyNote(workspaceDir, [
        `# ${DREAMING_TEST_DAY}`,
        "",
        "- Added primary issue extraction for pain notifications.",
        "- Updated signals cron notification style.",
      ]);

      const { beforeAgentReply } = createLightDreamingHarness(workspaceDir);
      await triggerLightDreaming(beforeAgentReply, workspaceDir, 1);

      await writeDailyNote(workspaceDir, [
        `# ${DREAMING_TEST_DAY}`,
        "",
        "- Added primary issue extraction for pain notifications.",
        "- Updated signals cron notification style.",
        "- Documented the shared pain notification issue.",
      ]);
      await triggerLightDreaming(beforeAgentReply, workspaceDir, 61);

      const secondCycle = await fs.readFile(
        path.join(workspaceDir, "memory", `${DREAMING_TEST_DAY}.md`),
        "utf-8",
      );
      expect(secondCycle).toContain(
        "Added primary issue extraction for pain notifications.; Updated signals cron notification style.; Documented the shared pain notification issue.",
      );
    });
  });

  it("prefers a fresh light snippet outside the top diary-covered candidates", async () => {
    const workspaceDir = await createDreamingWorkspace();
    const stalePath = path.join(workspaceDir, "memory", "2026-04-03.md");
    const freshPath = path.join(workspaceDir, "memory", "2026-04-04.md");
    const nowMs = Date.parse("2026-04-05T10:05:00.000Z");
    const staleSnippets = [
      "初次见面时，我第一次醒来并认识了主人。",
      "The first morning began beside a quiet terminal.",
      "An early config file felt like the first map of home.",
      "The initial heartbeat made the empty workspace feel awake.",
    ];
    await fs.writeFile(stalePath, `${staleSnippets.join("\n")}\n`, "utf-8");
    await fs.writeFile(
      freshPath,
      "Later routing notes: queue hydration changed after plugin reload.\n",
      "utf-8",
    );
    for (const [index, snippet] of staleSnippets.entries()) {
      for (let recall = 0; recall < staleSnippets.length - index; recall += 1) {
        await recordShortTermRecalls({
          workspaceDir,
          query: `first-day-${index}-${recall}`,
          nowMs,
          results: [
            {
              path: "memory/2026-04-03.md",
              startLine: index + 1,
              endLine: index + 1,
              score: 0.93,
              snippet,
              source: "memory",
            },
          ],
        });
      }
    }
    await recordShortTermRecalls({
      workspaceDir,
      query: "routing queue reload",
      nowMs,
      results: [
        {
          path: "memory/2026-04-04.md",
          startLine: 1,
          endLine: 1,
          score: 0.91,
          snippet: "Later routing notes: queue hydration changed after plugin reload.",
          source: "memory",
        },
      ],
    });
    await fs.writeFile(
      path.join(workspaceDir, "DREAMS.md"),
      [
        "# Dream Diary",
        "",
        "<!-- openclaw:dreaming:diary:start -->",
        ...staleSnippets.flatMap((snippet, index) => [
          "---",
          "",
          `*April ${index + 1}, 2026, 10:00 AM UTC*`,
          "",
          snippet,
          "",
        ]),
        "<!-- openclaw:dreaming:diary:end -->",
        "",
      ].join("\n"),
      "utf-8",
    );
    const subagent = createMockNarrativeSubagent("A later routing note finally took the page.");
    const testConfig: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          userTimezone: "UTC",
        },
      },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                enabled: true,
                timezone: "UTC",
                storage: { mode: "inline", separateReports: false },
                phases: {
                  light: {
                    enabled: true,
                    limit: 1,
                    lookbackDays: 7,
                  },
                  rem: {
                    enabled: false,
                    limit: 0,
                    lookbackDays: 7,
                  },
                },
              },
            },
          },
        },
      },
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await runDreamingSweepPhases({
      workspaceDir,
      cfg: testConfig,
      pluginConfig: resolveMemoryDreamingPluginConfig(testConfig),
      logger,
      subagent,
      nowMs,
    });

    const message = firstNarrativeRun(subagent).message;
    expect(message).toContain("Later routing notes: queue hydration changed after plugin reload.");
    expect(message).toContain("Recent diary entries already written");
    expect(message).not.toContain("\n- 初次见面时，我第一次醒来并认识了主人。");
  });

  it("triggers light dreaming when the token is embedded in a reminder body", async () => {
    const workspaceDir = await createDreamingWorkspace();
    await withDreamingTestClock(async () => {
      await writeDailyNote(workspaceDir, [
        `# ${DREAMING_TEST_DAY}`,
        "",
        "- Move backups to S3 Glacier.",
        "- Keep retention at 365 days.",
      ]);

      const { beforeAgentReply } = createLightDreamingHarness(workspaceDir);
      setDreamingTestTime(1);
      await beforeAgentReply(
        {
          cleanedBody: [
            "System: rotate logs",
            "System: __openclaw_memory_core_light_sleep__",
            "",
            "A scheduled reminder has been triggered. The reminder content is:",
            "",
            "rotate logs",
            "__openclaw_memory_core_light_sleep__",
            "",
            "Handle this reminder internally. Do not relay it to the user unless explicitly requested.",
          ].join("\n"),
        },
        { trigger: "heartbeat", workspaceDir },
      );

      const dailyContent = await fs.readFile(
        path.join(workspaceDir, "memory", `${DREAMING_TEST_DAY}.md`),
        "utf-8",
      );
      expect(dailyContent).toContain("## Light Sleep");
      expect(dailyContent).toContain("Move backups to S3 Glacier.");
    });
  });

  it("stops stripping a malformed managed block at the next section boundary", async () => {
    const workspaceDir = await createDreamingWorkspace();
    await withDreamingTestClock(async () => {
      await writeDailyNote(workspaceDir, [
        `# ${DREAMING_TEST_DAY}`,
        "",
        "- Move backups to S3 Glacier.",
        "",
        "## Light Sleep",
        "<!-- openclaw:dreaming:light:start -->",
        "- Candidate: Old staged summary.",
        "",
        "## Ops",
        "- Rotate access keys.",
        "",
        "## Light Sleep",
        "<!-- openclaw:dreaming:light:start -->",
        "- Candidate: Fresh staged summary.",
        "<!-- openclaw:dreaming:light:end -->",
      ]);

      const { beforeAgentReply } = createLightDreamingHarness(workspaceDir);
      await triggerLightDreaming(beforeAgentReply, workspaceDir, 1);

      expect(await readCandidateSnippets(workspaceDir, "2026-04-05T10:01:00.000Z")).toContain(
        "Ops: Rotate access keys.",
      );
    });
  });

  it("checkpoints daily ingestion and skips unchanged daily files", async () => {
    const workspaceDir = await createDreamingWorkspace();
    const dailyPath = path.join(workspaceDir, "memory", "2026-04-05.md");
    await fs.writeFile(
      dailyPath,
      ["# 2026-04-05", "", "- Move backups to S3 Glacier."].join("\n"),
      "utf-8",
    );

    const { beforeAgentReply } = createHarness(
      {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  // This test asserts inline-mode side effects on the daily
                  // file; pin storage explicitly after the default flipped to
                  // "separate" in #66328.
                  storage: { mode: "inline", separateReports: false },
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 2,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    const readSpy = vi.spyOn(fs, "readFile");
    try {
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
    } finally {
      readSpy.mockRestore();
    }

    const dailyReadCount = readSpy.mock.calls.filter(
      ([target]) => typeof target === "string" && target === dailyPath,
    ).length;
    expect(dailyReadCount).toBeLessThanOrEqual(1);
    const dailyIngestion = await dreamingTestState.readDailyIngestionState(workspaceDir);
    expect(Object.keys(dailyIngestion.files)).toHaveLength(1);
  });

  it("ingests recent daily memory files even before recall traffic exists", async () => {
    const workspaceDir = await createDreamingWorkspace();
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-05.md"),
      ["# 2026-04-05", "", "- Move backups to S3 Glacier.", "- Keep retention at 365 days."].join(
        "\n",
      ),
      "utf-8",
    );

    const before = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
    });
    expect(before).toHaveLength(0);

    const { beforeAgentReply } = createHarness(
      {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 2,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    await withDreamingTestClock(async () => {
      await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);
    });

    const after = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
    });
    expect(after).toHaveLength(1);
    expect(after[0]?.dailyCount).toBeGreaterThan(0);
    expect(after[0]?.startLine).toBe(3);
    expect(after[0]?.endLine).toBe(4);
    expect(after[0]?.snippet).toContain("Move backups to S3 Glacier.");
    expect(after[0]?.snippet).toContain("Keep retention at 365 days.");
  });

  it("ingests slugged daily memory files (YYYY-MM-DD-slug.md) alongside date-only files (#69536)", async () => {
    const workspaceDir = await createDreamingWorkspace();
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-05-vendor-pitch.md"),
      [
        "# 2026-04-05 vendor pitch",
        "",
        "- Vendor pitch: prefer the multi-year SLA.",
        "- Quoted price assumes annual prepay.",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-05-api-notes.md"),
      ["# 2026-04-05 api notes", "", "- API notes: keep the webhook contract stable."].join("\n"),
      "utf-8",
    );

    const { beforeAgentReply } = createHarness(
      {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 2,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    await withDreamingTestClock(async () => {
      await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);
    });

    const after = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
    });
    expect(after).toHaveLength(2);
    expect(after.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        "memory/2026-04-05-api-notes.md",
        "memory/2026-04-05-vendor-pitch.md",
      ]),
    );
    expect(after.every((entry) => (entry.dailyCount ?? 0) > 0)).toBe(true);
    expect(
      after.some((entry) => entry.snippet.includes("Vendor pitch: prefer the multi-year SLA.")),
    ).toBe(true);
  });

  it("prioritizes the date-only daily file before same-day slugged files when ingestion is capped", async () => {
    const workspaceDir = await createDreamingWorkspace();
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-05.md"),
      dailyCapStressLines("Canonical daily note").join("\n"),
      "utf-8",
    );
    for (const slug of ["alpha", "beta", "gamma", "delta"]) {
      await fs.writeFile(
        path.join(workspaceDir, "memory", `2026-04-05-${slug}.md`),
        dailyCapStressLines(`Slugged ${slug}`).join("\n"),
        "utf-8",
      );
    }

    const { beforeAgentReply } = createHarness(
      {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 1,
                      lookbackDays: 2,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    await withDreamingTestClock(async () => {
      await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);
    });

    const after = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
    });
    expect(after.some((entry) => entry.path === "memory/2026-04-05.md")).toBe(true);
    expect(after.some((entry) => entry.snippet.includes("Canonical daily note"))).toBe(true);
  });

  it("prioritizes the date-only daily file before same-day slugged files during historical seeding", async () => {
    const workspaceDir = await createDreamingWorkspace();
    const canonicalPath = path.join(workspaceDir, "memory", "2026-04-05.md");
    await fs.writeFile(
      canonicalPath,
      dailyCapStressLines("Canonical seeded note").join("\n"),
      "utf-8",
    );
    const sluggedPaths: string[] = [];
    for (const slug of ["alpha", "beta", "gamma", "delta"]) {
      const sluggedPath = path.join(workspaceDir, "memory", `2026-04-05-${slug}.md`);
      sluggedPaths.push(sluggedPath);
      await fs.writeFile(
        sluggedPath,
        dailyCapStressLines(`Seeded slugged ${slug}`).join("\n"),
        "utf-8",
      );
    }

    await seedHistoricalDailyMemorySignals({
      workspaceDir,
      filePaths: [...sluggedPaths, canonicalPath],
      limit: 1,
      nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
      timezone: "UTC",
    });

    const after = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
    });
    expect(after.some((entry) => entry.path === "memory/2026-04-05.md")).toBe(true);
    expect(after.some((entry) => entry.snippet.includes("Canonical seeded note"))).toBe(true);
  });

  it("renders non-zero light-sleep confidence for dreaming-ingested candidates", async () => {
    const workspaceDir = await createDreamingWorkspace();
    await withDreamingTestClock(async () => {
      await writeDailyNote(workspaceDir, [
        `# ${DREAMING_TEST_DAY}`,
        "",
        "- Move backups to S3 Glacier.",
        "- Keep retention at 365 days.",
      ]);

      const { beforeAgentReply } = createLightDreamingHarness(workspaceDir);
      await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);

      const dailyContent = await fs.readFile(
        path.join(workspaceDir, "memory", `${DREAMING_TEST_DAY}.md`),
        "utf-8",
      );
      expect(dailyContent).toContain("## Light Sleep");
      expect(dailyContent).toContain("confidence: 0.62");
      expect(dailyContent).not.toContain("confidence: 0.00");
    });
  });

  it("checkpoints session transcript ingestion and skips unchanged transcripts", async () => {
    const workspaceDir = await createDreamingWorkspace();
    setDreamingTestEnv(path.join(workspaceDir, ".state"));
    const transcriptName = `dreaming-${"x".repeat(48)}`;
    const snippetTranscriptName = "snippet-boundary";
    const renderedSource = `[main/sessions/main/${transcriptName}#L4] `;
    const renderedPadding = "r".repeat(343 - renderedSource.length - "User: ".length);
    const snippetPadding = "s".repeat(273);
    await seedDreamingSessionTranscript({
      sessionId: transcriptName,
      messages: [
        {
          role: "user",
          timestamp: "2026-04-05T18:01:00.000Z",
          content: [{ type: "text", text: "Move backups to S3 Glacier." }],
        },
        {
          role: "assistant",
          timestamp: "2026-04-05T18:02:00.000Z",
          content: [{ type: "text", text: "Set retention to 365 days." }],
        },
        {
          role: "user",
          timestamp: "2026-04-05T18:03:00.000Z",
          content: [{ type: "text", text: `${renderedPadding}🎉 omitted tail` }],
        },
      ],
    });
    await seedDreamingSessionTranscript({
      sessionId: snippetTranscriptName,
      messages: [
        {
          role: "user",
          timestamp: "2026-04-05T18:04:00.000Z",
          content: [{ type: "text", text: `${snippetPadding}🌍 omitted tail` }],
        },
      ],
    });

    const { beforeAgentReply } = createHarness(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
          list: [{ id: "main", workspace: workspaceDir }],
        },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 7,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    let firstSessionIngestion;
    try {
      await withDreamingTestClock(async () => {
        await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);
        firstSessionIngestion = await dreamingTestState.readSessionIngestionState(workspaceDir);
        await triggerLightDreaming(beforeAgentReply, workspaceDir, 6);
      });
    } finally {
      restoreDreamingTestEnv();
    }

    const sessionIngestion = await dreamingTestState.readSessionIngestionState(workspaceDir);
    expect(firstSessionIngestion).toStrictEqual(sessionIngestion);
    expect(Object.keys(sessionIngestion.files)).toContain(`main:sessions/main/${transcriptName}`);
    expect(Object.keys(sessionIngestion.seenMessages)).toContain(
      `main:sessions/main/${transcriptName}`,
    );
    const corpusPath = path.join(
      workspaceDir,
      "memory",
      ".dreams",
      "session-corpus",
      "2026-04-05.txt",
    );
    const corpus = await fs.readFile(corpusPath, "utf-8");
    expect(corpus).toContain("Move backups to S3 Glacier.");
    expect(corpus).toContain("Set retention to 365 days.");
    expect(corpus).toContain(`${renderedSource}User: ${renderedPadding}\n`);
    expect(corpus).toContain(
      `[main/sessions/main/${snippetTranscriptName}#L2] User: ${snippetPadding}\n`,
    );
    expect(corpus).not.toContain("🎉");
    expect(corpus).not.toContain("🌍");

    const ranked = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-04-05T19:00:00.000Z"),
    });
    expect(ranked.map((candidate) => candidate.path)).toContain(
      "memory/.dreams/session-corpus/2026-04-05.txt",
    );
    const snippets = ranked.map((candidate) => candidate.snippet);
    expectIncludesSubstring(snippets, "Move backups to S3 Glacier.");
    expectIncludesSubstring(snippets, "Set retention to 365 days.");
  });

  it("redacts sensitive session content before writing session corpus", async () => {
    const workspaceDir = await createDreamingWorkspace();
    setDreamingTestEnv(path.join(workspaceDir, ".state"));
    await seedDreamingSessionTranscript({
      sessionId: "dreaming-main",
      messages: [
        {
          role: "user",
          timestamp: "2026-04-05T18:01:00.000Z",
          content: [{ type: "text", text: "OPENAI_API_KEY=sk-1234567890abcdef" }],
        },
      ],
    });

    const { beforeAgentReply } = createHarness(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
          list: [{ id: "main", workspace: workspaceDir }],
        },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 7,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    try {
      await withDreamingTestClock(async () => {
        await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);
      });
    } finally {
      restoreDreamingTestEnv();
    }

    const corpusPath = path.join(
      workspaceDir,
      "memory",
      ".dreams",
      "session-corpus",
      "2026-04-05.txt",
    );
    const corpus = await fs.readFile(corpusPath, "utf-8");
    expect(corpus).not.toContain("OPENAI_API_KEY=sk-1234567890abcdef");
    expect(corpus).toContain("OPENAI_API_KEY=***");
  });

  it("skips dreaming-generated narrative transcripts during session ingestion", async () => {
    const workspaceDir = await createDreamingWorkspace();
    setDreamingTestEnv(path.join(workspaceDir, ".state"));
    await seedDreamingSessionTranscript({
      sessionId: "dreaming-narrative",
      sessionKey: "agent:main:dreaming-narrative-light-1775894400455",
      messages: [
        {
          role: "user",
          timestamp: "2026-04-05T18:01:00.000Z",
          content: [
            { type: "text", text: "Write a dream diary entry from these memory fragments." },
          ],
        },
        {
          role: "assistant",
          timestamp: "2026-04-05T18:02:00.000Z",
          content: [{ type: "text", text: "I drift through the same archive again." }],
        },
      ],
    });

    const { beforeAgentReply } = createHarness(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
          list: [{ id: "main", workspace: workspaceDir }],
        },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 7,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    try {
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
    } finally {
      restoreDreamingTestEnv();
    }

    await expectPathMissing(
      path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-05.txt"),
    );

    const sessionIngestion = await dreamingTestState.readSessionIngestionState(workspaceDir);
    expect(Object.keys(sessionIngestion.files)).toHaveLength(1);
    const ingestionEntry = requireFirstIngestionEntry(sessionIngestion);
    expect(ingestionEntry.lineCount).toBe(0);
    expect(ingestionEntry.lastContentLine).toBe(0);
    expect(ingestionEntry.contentHash).toBe(EMPTY_SESSION_CONTENT_HASH);
  });

  it("skips dreaming transcripts when the session store identifies them before bootstrap lands", async () => {
    const workspaceDir = await createDreamingWorkspace();
    setDreamingTestEnv(path.join(workspaceDir, ".state"));
    await seedDreamingSessionTranscript({
      sessionId: "dreaming-narrative",
      sessionKey: "agent:main:dreaming-narrative-light-1775894400455",
      messages: [
        {
          role: "user",
          timestamp: "2026-04-05T18:01:00.000Z",
          content: [
            { type: "text", text: "Write a dream diary entry from these memory fragments." },
          ],
        },
        {
          role: "assistant",
          timestamp: "2026-04-05T18:02:00.000Z",
          content: [{ type: "text", text: "I drift through the same archive again." }],
        },
      ],
    });

    const { beforeAgentReply } = createHarness(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
          list: [{ id: "main", workspace: workspaceDir }],
        },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 7,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    try {
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
    } finally {
      restoreDreamingTestEnv();
    }

    await expectPathMissing(
      path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-05.txt"),
    );

    const sessionIngestion = await dreamingTestState.readSessionIngestionState(workspaceDir);
    expect(Object.keys(sessionIngestion.files)).toHaveLength(1);
    const ingestionEntry = requireFirstIngestionEntry(sessionIngestion);
    expect(ingestionEntry.lineCount).toBe(0);
    expect(ingestionEntry.lastContentLine).toBe(0);
    expect(ingestionEntry.contentHash).toBe(EMPTY_SESSION_CONTENT_HASH);
  });

  it("skips isolated cron run transcripts during session ingestion", async () => {
    const workspaceDir = await createDreamingWorkspace();
    setDreamingTestEnv(path.join(workspaceDir, ".state"));
    await seedDreamingSessionTranscript({
      sessionId: "cron-run",
      sessionKey: "agent:main:cron:job-1:run:run-1",
      messages: [
        {
          role: "user",
          timestamp: "2026-04-05T18:01:00.000Z",
          content:
            "[cron:job-1 Codex Sessions Sync] Run Codex sessions sync: 1. Convert sessions 2. Update qmd",
        },
        {
          role: "assistant",
          timestamp: "2026-04-05T18:02:00.000Z",
          content: "Running Codex sessions sync...",
        },
      ],
    });

    const { beforeAgentReply } = createHarness(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
          list: [{ id: "main", workspace: workspaceDir }],
        },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 7,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    try {
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
    } finally {
      restoreDreamingTestEnv();
    }

    await expectPathMissing(
      path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-05.txt"),
    );

    const sessionIngestion = await dreamingTestState.readSessionIngestionState(workspaceDir);
    const ingestionEntry = requireFirstIngestionEntry(sessionIngestion);
    expect(ingestionEntry.lineCount).toBe(0);
    expect(ingestionEntry.lastContentLine).toBe(0);
    expect(ingestionEntry.contentHash).toBe(EMPTY_SESSION_CONTENT_HASH);
  });

  it("drops generated system wrapper text without suppressing paired assistant replies", async () => {
    const workspaceDir = await createDreamingWorkspace();
    setDreamingTestEnv(path.join(workspaceDir, ".state"));
    await seedDreamingSessionTranscript({
      sessionId: "ordinary-session",
      messages: [
        {
          role: "user",
          timestamp: "2026-04-16T18:01:00.000Z",
          content:
            "System (untrusted): [2026-04-16 11:01:00 PDT] Exec completed (quiet-fo, code 0) :: Converted: 1",
        },
        {
          role: "assistant",
          timestamp: "2026-04-16T18:01:30.000Z",
          content: "Handled internally.",
        },
        {
          role: "user",
          timestamp: "2026-04-16T18:02:00.000Z",
          content: "What changed in the sync?",
        },
        {
          role: "assistant",
          timestamp: "2026-04-16T18:03:00.000Z",
          content: "One new session was converted.",
        },
      ],
    });

    const { beforeAgentReply } = createHarness(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
          list: [{ id: "main", workspace: workspaceDir }],
        },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 7,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T19:00:00.000Z"));
    try {
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
    } finally {
      vi.useRealTimers();
      restoreDreamingTestEnv();
    }

    const corpus = await fs.readFile(
      path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-16.txt"),
      "utf-8",
    );
    expect(corpus).toContain("User: What changed in the sync?");
    expect(corpus).toContain("Assistant: One new session was converted.");
    expect(corpus).not.toContain("System (untrusted):");
    expect(corpus).toContain("Assistant: Handled internally.");
  });

  it("drops archive, cron, and heartbeat chatter from fresh session corpus output", async () => {
    const workspaceDir = await createDreamingWorkspace();
    setDreamingTestEnv(path.join(workspaceDir, ".state"));
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });

    await fs.writeFile(
      path.join(sessionsDir, "archived.jsonl.deleted.2026-04-16T18-06-16.529Z"),
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-16T18:01:00.000Z",
            content: "[cron:job-1 Example] Run the nightly sync",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: "2026-04-16T18:02:00.000Z",
            content: "Running the nightly sync now.",
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(sessionsDir, "ordinary.checkpoint.11111111-1111-4111-8111-111111111111.jsonl"),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          timestamp: "2026-04-16T18:03:00.000Z",
          content: "Checkpoint chatter should stay out.",
        },
      }) + "\n",
      "utf-8",
    );
    await seedDreamingSessionTranscript({
      sessionId: "ordinary",
      messages: [
        {
          role: "user",
          timestamp: "2026-04-16T18:04:00.000Z",
          content:
            "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
        {
          role: "assistant",
          timestamp: "2026-04-16T18:05:00.000Z",
          content: "HEARTBEAT_OK",
        },
        {
          role: "user",
          timestamp: "2026-04-16T18:06:00.000Z",
          content: "[cron:job-2 Example] Run the qmd sync",
        },
        {
          role: "assistant",
          timestamp: "2026-04-16T18:07:00.000Z",
          content: "Running the qmd sync now.",
        },
        {
          role: "user",
          timestamp: "2026-04-16T18:08:00.000Z",
          content: "Document the Ollama provider setup.",
        },
        {
          role: "assistant",
          timestamp: "2026-04-16T18:09:00.000Z",
          content: "I documented the Ollama provider setup in the workspace notes.",
        },
      ],
    });

    const { beforeAgentReply } = createHarness(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
          list: [{ id: "main", workspace: workspaceDir }],
        },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 7,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T19:00:00.000Z"));
    try {
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
    } finally {
      vi.useRealTimers();
      restoreDreamingTestEnv();
    }

    const corpus = await fs.readFile(
      path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-16.txt"),
      "utf-8",
    );
    expect(corpus).toContain("User: Document the Ollama provider setup.");
    expect(corpus).toContain(
      "Assistant: I documented the Ollama provider setup in the workspace notes.",
    );
    expect(corpus).not.toContain("Run the nightly sync");
    expect(corpus).not.toContain("Checkpoint chatter should stay out.");
    expect(corpus).not.toContain("Read HEARTBEAT.md");
    expect(corpus).not.toContain("HEARTBEAT_OK");
    expect(corpus).not.toContain("Run the qmd sync");
  });

  it("ignores chat scaffolding tags when building rem reflections", () => {
    const preview = previewRemDreaming({
      entries: [
        {
          key: "memory:1",
          path: "memory/.dreams/session-corpus/2026-04-16.txt",
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "Assistant: I documented the Ollama provider setup.",
          recallCount: 1,
          dailyCount: 0,
          groundedCount: 0,
          totalScore: 0.6,
          maxScore: 0.6,
          firstRecalledAt: "2026-04-16T18:00:00.000Z",
          lastRecalledAt: "2026-04-16T18:00:00.000Z",
          queryHashes: ["q1"],
          recallDays: ["2026-04-16"],
          conceptTags: ["assistant", "the", "ollama", "provider"],
        },
      ],
      limit: 5,
      minPatternStrength: 0,
    });

    expect(preview.reflections.join("\n")).toContain("`ollama`");
    expect(preview.reflections.join("\n")).toContain("`provider`");
    expect(preview.reflections.join("\n")).not.toContain("`assistant`");
    expect(preview.reflections.join("\n")).not.toContain("`the`");
  });

  it("does not reread unchanged dreaming-generated transcripts after checkpointing skip state", async () => {
    const workspaceDir = await createDreamingWorkspace();
    setDreamingTestEnv(path.join(workspaceDir, ".state"));
    await seedDreamingSessionTranscript({
      sessionId: "dreaming-narrative",
      sessionKey: "agent:main:dreaming-narrative-light-1775894400455",
      messages: [
        {
          role: "user",
          timestamp: "2026-04-05T18:01:00.000Z",
          content: [
            { type: "text", text: "Write a dream diary entry from these memory fragments." },
          ],
        },
      ],
    });

    const { beforeAgentReply } = createHarness(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
          list: [{ id: "main", workspace: workspaceDir }],
        },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 7,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    try {
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
      const firstSessionIngestion = await dreamingTestState.readSessionIngestionState(workspaceDir);

      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
      const secondSessionIngestion =
        await dreamingTestState.readSessionIngestionState(workspaceDir);
      expect(secondSessionIngestion).toStrictEqual(firstSessionIngestion);
    } finally {
      restoreDreamingTestEnv();
    }
  });

  it("dedupes reset/deleted session archives instead of double-ingesting", async () => {
    const workspaceDir = await createDreamingWorkspace();
    setDreamingTestEnv(path.join(workspaceDir, ".state"));
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const oldMessage = "Move backups to S3 Glacier.";
    const oldArchiveContent =
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-05T18:01:00.000Z",
            content: [{ type: "text", text: oldMessage }],
          },
        }),
      ].join("\n") + "\n";
    await seedDreamingSessionTranscript({
      sessionId: "dreaming-main",
      messages: [
        {
          role: "user",
          timestamp: "2026-04-05T18:01:00.000Z",
          content: [{ type: "text", text: oldMessage }],
        },
      ],
    });

    const { beforeAgentReply } = createHarness(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 7,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    try {
      await withDreamingTestClock(async () => {
        await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);
      });

      const resetPath = path.join(
        sessionsDir,
        "dreaming-main.jsonl.reset.2026-04-06T01-00-00.000Z",
      );
      await fs.writeFile(resetPath, oldArchiveContent, "utf-8");
      const newMessage = "Keep retention at 365 days.";
      await seedDreamingSessionTranscript({
        sessionId: "dreaming-main",
        messages: [
          {
            role: "assistant",
            timestamp: "2026-04-06T01:02:00.000Z",
            content: [{ type: "text", text: newMessage }],
          },
        ],
      });
      const dayTwo = new Date("2026-04-06T01:05:00.000Z");
      await fs.utimes(resetPath, dayTwo, dayTwo);

      await withDreamingTestClock(async () => {
        await triggerLightDreaming(beforeAgentReply, workspaceDir, 910);
      });
    } finally {
      restoreDreamingTestEnv();
    }

    const sessionCorpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
    const corpusFiles = (await fs.readdir(sessionCorpusDir)).filter((name) =>
      name.endsWith(".txt"),
    );
    let combinedCorpus = "";
    for (const fileName of corpusFiles) {
      combinedCorpus += `${await fs.readFile(path.join(sessionCorpusDir, fileName), "utf-8")}\n`;
    }
    const oldOccurrences = combinedCorpus.match(/Move backups to S3 Glacier\./g)?.length ?? 0;
    const newOccurrences = combinedCorpus.match(/Keep retention at 365 days\./g)?.length ?? 0;
    expect(oldOccurrences).toBe(1);
    expect(newOccurrences).toBe(1);
  });

  it("skips reset/deleted archive artifacts without active transcripts during session ingestion", async () => {
    const workspaceDir = await createDreamingWorkspace();
    setDreamingTestEnv(path.join(workspaceDir, ".state"));
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const archivePath = path.join(
      sessionsDir,
      "archived-only.jsonl.deleted.2026-04-06T01-00-00.000Z",
    );
    await fs.writeFile(
      archivePath,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-05T18:01:00.000Z",
            content: [{ type: "text", text: "Archived session should not be dreamed." }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const mtime = new Date("2026-04-06T01:05:00.000Z");
    await fs.utimes(archivePath, mtime, mtime);

    const { beforeAgentReply } = createHarness(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 7,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    try {
      await withDreamingTestClock(async () => {
        await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);
      });
    } finally {
      restoreDreamingTestEnv();
    }

    await expectPathMissing(
      path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-05.txt"),
    );

    const sessionIngestion = await dreamingTestState.readSessionIngestionState(workspaceDir);
    expect(Object.keys(sessionIngestion.files)).toHaveLength(0);
  });

  it("buckets session snippets by per-message day rather than file mtime", async () => {
    const workspaceDir = await createDreamingWorkspace();
    setDreamingTestEnv(path.join(workspaceDir, ".state"));
    await seedDreamingSessionTranscript({
      sessionId: "dreaming-main",
      messages: [
        {
          role: "user",
          timestamp: "2026-04-01T12:00:00.000Z",
          content: [{ type: "text", text: "Old planning note that should stay out of lookback." }],
        },
        {
          role: "assistant",
          timestamp: "2026-04-05T18:02:00.000Z",
          content: [{ type: "text", text: "Current reminder that should be in today corpus." }],
        },
      ],
    });

    const { beforeAgentReply } = createHarness(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 2,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    try {
      await withDreamingTestClock(async () => {
        await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);
      });
    } finally {
      restoreDreamingTestEnv();
    }

    const corpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
    const corpusFiles = (await fs.readdir(corpusDir))
      .filter((name) => name.endsWith(".txt"))
      .toSorted();
    expect(corpusFiles).toEqual(["2026-04-05.txt"]);
    const dayCorpus = await fs.readFile(path.join(corpusDir, "2026-04-05.txt"), "utf-8");
    expect(dayCorpus).toContain("Current reminder that should be in today corpus.");
    expect(dayCorpus).not.toContain("Old planning note that should stay out of lookback.");
  });

  it("drains >80 unseen transcript messages across multiple unchanged sweeps", async () => {
    const workspaceDir = await createDreamingWorkspace();
    setDreamingTestEnv(path.join(workspaceDir, ".state"));
    await seedDreamingSessionTranscript({
      sessionId: "dreaming-main",
      messages: Array.from({ length: 160 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        timestamp: "2026-04-05T18:00:00.000Z",
        content: [{ type: "text", text: `bulk-line-${index}` }],
      })),
    });

    const { beforeAgentReply } = createHarness(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 7,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    try {
      await withDreamingTestClock(async () => {
        await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);
        await triggerLightDreaming(beforeAgentReply, workspaceDir, 6);
        await triggerLightDreaming(beforeAgentReply, workspaceDir, 7);
      });
    } finally {
      restoreDreamingTestEnv();
    }

    const corpusPath = path.join(
      workspaceDir,
      "memory",
      ".dreams",
      "session-corpus",
      "2026-04-05.txt",
    );
    const corpus = await fs.readFile(corpusPath, "utf-8");
    const persistedLines = corpus
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(persistedLines).toHaveLength(160);
    expect(corpus).toContain("bulk-line-0");
    expect(corpus).toContain("bulk-line-159");
  });

  it("ingests appended SQLite session transcript rows after prior checkpoint", async () => {
    const workspaceDir = await createDreamingWorkspace();
    setDreamingTestEnv(path.join(workspaceDir, ".state"));
    await seedDreamingSessionTranscript({
      sessionId: "dreaming-main",
      messages: [
        {
          role: "user",
          timestamp: "2026-04-05T18:01:00.000Z",
          content: [{ type: "text", text: "Move backups to S3 Glacier." }],
        },
      ],
    });

    const { beforeAgentReply } = createHarness(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 7,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    try {
      await withDreamingTestClock(async () => {
        await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);
      });

      await seedDreamingSessionTranscript({
        sessionId: "dreaming-main",
        messages: [
          {
            role: "assistant",
            timestamp: "2026-04-06T01:02:00.000Z",
            content: [{ type: "text", text: "Retention policy stays at 365 days." }],
          },
        ],
      });

      await withDreamingTestClock(async () => {
        await triggerLightDreaming(beforeAgentReply, workspaceDir, 910);
      });
    } finally {
      restoreDreamingTestEnv();
    }

    const sessionCorpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
    const corpusFiles = (await fs.readdir(sessionCorpusDir)).filter((name) =>
      name.endsWith(".txt"),
    );
    let combinedCorpus = "";
    for (const fileName of corpusFiles) {
      combinedCorpus += `${await fs.readFile(path.join(sessionCorpusDir, fileName), "utf-8")}\n`;
    }
    expect(combinedCorpus).toContain("Move backups to S3 Glacier.");
    expect(combinedCorpus).toContain("Retention policy stays at 365 days.");
  });

  it("ingests sessions when dreaming is enabled even if memorySearch is disabled", async () => {
    const workspaceDir = await createDreamingWorkspace();
    setDreamingTestEnv(path.join(workspaceDir, ".state"));
    await seedDreamingSessionTranscript({
      sessionId: "dreaming-main",
      messages: [
        {
          role: "user",
          timestamp: "2026-04-05T18:01:00.000Z",
          content: [{ type: "text", text: "Glacier archive migration is now complete." }],
        },
      ],
    });

    const { beforeAgentReply } = createHarness(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
            memorySearch: {
              enabled: false,
            },
          },
        },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 7,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    try {
      await withDreamingTestClock(async () => {
        await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);
      });
    } finally {
      restoreDreamingTestEnv();
    }

    const corpus = await fs.readFile(
      path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-05.txt"),
      "utf-8",
    );
    expect(corpus).toContain("Glacier archive migration is now complete.");
  });

  it("keeps section context when chunking durable daily notes", async () => {
    const workspaceDir = await createDreamingWorkspace();
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-05.md"),
      [
        "# 2026-04-05",
        "",
        "## Emma Rees",
        "- She asked for more space after the last exchange.",
        "- Better to keep messages short and low-pressure.",
        "- Re-engagement should be time-bounded and optional.",
      ].join("\n"),
      "utf-8",
    );

    const { beforeAgentReply } = createHarness(
      {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 2,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    await withDreamingTestClock(async () => {
      await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);
    });

    const after = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
    });
    expect(after).toHaveLength(1);
    expect(after[0]?.startLine).toBe(4);
    expect(after[0]?.endLine).toBe(6);
    expect(after[0]?.snippet).toContain("Emma Rees:");
    expect(after[0]?.snippet).toContain("She asked for more space");
    expect(after[0]?.snippet).toContain("messages short and low-pressure");
  });

  it("keeps daily ingestion snippets valid at surrogate-pair boundaries", async () => {
    const workspaceDir = await createDreamingWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");
    const headingPrefix = "h".repeat(279);
    const itemPrefix = "i".repeat(279);
    const chunkPrefix = "c".repeat(272);
    await Promise.all([
      fs.writeFile(
        path.join(memoryDir, "2026-04-05-heading.md"),
        [`# ${headingPrefix}🎉`, "", "- Durable heading context item."].join("\n"),
        "utf-8",
      ),
      fs.writeFile(
        path.join(memoryDir, "2026-04-05-item.md"),
        ["# 2026-04-05", "", `- ${itemPrefix}🎉`].join("\n"),
        "utf-8",
      ),
      fs.writeFile(
        path.join(memoryDir, "2026-04-05-chunk.md"),
        ["# 2026-04-05", "", "## Topic", `- ${chunkPrefix}🎉`].join("\n"),
        "utf-8",
      ),
    ]);

    const { beforeAgentReply } = createLightDreamingHarness(workspaceDir);
    await withDreamingTestClock(async () => {
      await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);
    });

    const snippets = await readCandidateSnippets(workspaceDir, "2026-04-05T10:05:00.000Z");
    expect(snippets).toEqual(
      expect.arrayContaining([`${headingPrefix}:`, itemPrefix, `Topic: ${chunkPrefix}`]),
    );
  });

  it("drops generic day headings but keeps meaningful section labels", async () => {
    const workspaceDir = await createDreamingWorkspace();
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-05.md"),
      [
        "# Friday, April 5, 2026",
        "",
        "## Morning",
        "- Reviewed travel timing and calendar placement.",
        "",
        "## Emma Rees",
        "- She prefers direct plans over open-ended maybes.",
        "- Better to offer one concrete time window.",
      ].join("\n"),
      "utf-8",
    );

    const { beforeAgentReply } = createHarness(
      {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 2,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    await withDreamingTestClock(async () => {
      await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);
    });

    const after = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
    });
    expect(after).toHaveLength(2);
    const snippets = after.map((candidate) => candidate.snippet);
    expect(snippets).toContain("Reviewed travel timing and calendar placement.");
    expectIncludesSubstring(snippets, "Emma Rees:");
    for (const candidate of after) {
      expect(candidate.snippet).not.toContain("Friday, April 5, 2026:");
      expect(candidate.snippet).not.toContain("Morning:");
    }
  });

  it("splits noisy daily notes into a few coherent chunks instead of one line per item", async () => {
    const workspaceDir = await createDreamingWorkspace();
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-05.md"),
      [
        "# 2026-04-05",
        "",
        "## Operations",
        "- Restarted the gateway after auth drift.",
        "- Tokens now line up again.",
        "",
        "## Bex",
        "- She prefers direct plans over open-ended maybes.",
        "- Better to offer one concrete time window.",
        "",
        "11:30",
        "",
        "## Travel",
        "- Flight lands at 08:10.",
      ].join("\n"),
      "utf-8",
    );

    const { beforeAgentReply } = createHarness(
      {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 2,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    await withDreamingTestClock(async () => {
      await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);
    });

    const after = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
    });
    expect(after).toHaveLength(3);
    const snippets = after.map((candidate) => candidate.snippet);
    expectIncludesSubstring(
      snippets,
      "Operations: Restarted the gateway after auth drift.; Tokens now line up again.",
    );
    expectIncludesSubstring(
      snippets,
      "Bex: She prefers direct plans over open-ended maybes.; Better to offer one concrete time window.",
    );
    expectIncludesSubstring(snippets, "Travel: Flight lands at 08:10.");
  });

  it("records light/rem signals that reinforce deep promotion ranking", async () => {
    const workspaceDir = await createDreamingWorkspace();
    const nowMs = Date.parse("2026-04-05T10:00:00.000Z");
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-03.md"),
      "Move backups to S3 Glacier.\n",
      "utf-8",
    );
    await recordShortTermRecalls({
      workspaceDir,
      query: "glacier backup",
      nowMs,
      results: [
        {
          path: "memory/2026-04-03.md",
          startLine: 1,
          endLine: 1,
          score: 0.92,
          snippet: "Move backups to S3 Glacier.",
          source: "memory",
        },
      ],
    });
    await recordShortTermRecalls({
      workspaceDir,
      query: "cold storage retention",
      nowMs,
      results: [
        {
          path: "memory/2026-04-03.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "Move backups to S3 Glacier.",
          source: "memory",
        },
      ],
    });

    const baseline = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs,
    });
    expect(baseline).toHaveLength(1);
    const baselineCandidate = expectDefined(baseline[0], "baseline promotion candidate");
    const baselineScore = baselineCandidate.score;

    const { beforeAgentReply } = createHarness(
      {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  phases: {
                    light: {
                      enabled: true,
                      limit: 10,
                      lookbackDays: 7,
                    },
                    rem: {
                      enabled: true,
                      limit: 10,
                      lookbackDays: 7,
                      minPatternStrength: 0,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
    );

    await withDreamingTestClock(async () => {
      await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);
    });
    await withDreamingTestClock(async () => {
      setDreamingTestTime(10);
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_rem_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
    });

    const reinforced = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs,
    });
    const reinforcedCandidate = requireCandidateByKey(reinforced, baselineCandidate.key);
    expect(reinforcedCandidate.score).toBeGreaterThan(baselineScore);

    const phaseSignalStore = await shortTermTesting.readPhaseSignalStore(
      workspaceDir,
      new Date().toISOString(),
    );
    const baselineSignals = phaseSignalStore.entries[baselineCandidate.key];
    expect(baselineSignals?.lightHits).toBe(1);
    expect(baselineSignals?.remHits).toBe(1);
  });

  it("skips REM short-term candidates whose source file disappeared", async () => {
    const workspaceDir = await createDreamingWorkspace();
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-03.md"),
      "Move backups to S3 Glacier.\n",
      "utf-8",
    );
    const nowMs = DREAMING_TEST_BASE_TIME.getTime();
    await recordShortTermRecalls({
      workspaceDir,
      query: "live backup",
      nowMs,
      results: [
        {
          path: "memory/2026-04-03.md",
          startLine: 1,
          endLine: 1,
          score: 0.91,
          snippet: "Move backups to S3 Glacier.",
          source: "memory",
        },
      ],
    });
    await recordShortTermRecalls({
      workspaceDir,
      query: "stale provider setup",
      nowMs,
      results: [
        {
          path: "memory/.dreams/session-corpus/2026-04-16.txt",
          startLine: 2,
          endLine: 2,
          score: 0.88,
          snippet: "Documented Ollama provider setup.",
          source: "memory",
        },
      ],
    });
    const baseline = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs,
    });
    const liveKey = requireCandidateKeyByPath(
      baseline,
      (candidatePath) => candidatePath === "memory/2026-04-03.md",
      "live memory note",
    );
    const staleKey = requireCandidateKeyByPath(
      baseline,
      (candidatePath) => candidatePath.includes("session-corpus/2026-04-16.txt"),
      "stale session corpus",
    );

    await withDreamingTestClock(async () => {
      setDreamingTestTime();
      await runDreamingSweepPhases({
        workspaceDir,
        pluginConfig: {
          dreaming: {
            enabled: true,
            timezone: "UTC",
            storage: { mode: "inline", separateReports: false },
            phases: {
              light: { enabled: false },
              rem: {
                enabled: true,
                lookbackDays: 7,
                limit: 10,
                minPatternStrength: 0,
              },
            },
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        detachNarratives: false,
      });
    });

    const phaseSignalStore = await shortTermTesting.readPhaseSignalStore(
      workspaceDir,
      new Date().toISOString(),
    );
    expect(phaseSignalStore.entries[liveKey]?.remHits).toBe(1);
    expect(phaseSignalStore.entries[staleKey]).toBeUndefined();

    const remOutput = await fs.readFile(
      path.join(workspaceDir, "memory", `${DREAMING_TEST_DAY}.md`),
      "utf-8",
    );
    expect(remOutput).toContain("Move backups to S3 Glacier.");
    expect(remOutput).not.toContain("Documented Ollama provider setup");
  });

  it("passes staged light-dreaming snippets into the narrative pipeline", async () => {
    const workspaceDir = await createDreamingWorkspace();
    const subagent = createMockNarrativeSubagent("The backup plan glowed like cold storage.");
    const { beforeAgentReply } = createHarness(
      {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  timezone: "UTC",
                  model: "anthropic/claude-sonnet-4-6",
                  storage: { mode: "inline", separateReports: false },
                  phases: {
                    light: {
                      enabled: true,
                      limit: 20,
                      lookbackDays: 2,
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
      subagent,
    );

    await withDreamingTestClock(async () => {
      await writeDailyNote(workspaceDir, [
        `# ${DREAMING_TEST_DAY}`,
        "",
        "- Move backups to S3 Glacier.",
        "- Keep retention at 365 days.",
      ]);

      await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);
    });

    expect(subagent.run).toHaveBeenCalledTimes(1);
    const firstRun = firstNarrativeRun(subagent);
    expect(firstRun.message).toContain("Move backups to S3 Glacier.");
    expect(firstRun.message).toContain("Keep retention at 365 days.");
    expect(firstRun.model).toBe("anthropic/claude-sonnet-4-6");
    await expect(fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8")).resolves.toContain(
      "The backup plan glowed like cold storage.",
    );
  });

  it("passes rem-dreaming snippets into the narrative pipeline", async () => {
    const workspaceDir = await createDreamingWorkspace();
    const subagent = createMockNarrativeSubagent("The traces braided themselves into a map.");
    const { beforeAgentReply } = createHarness(
      {
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  execution: {
                    defaults: {
                      model: "openai/gpt-5.4",
                    },
                  },
                  phases: {
                    rem: {
                      enabled: true,
                      limit: 10,
                      lookbackDays: 7,
                      minPatternStrength: 0,
                      execution: {
                        model: "xai/grok-4.1-fast",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      workspaceDir,
      subagent,
    );

    await withDreamingTestClock(async () => {
      await writeDailyNote(workspaceDir, [
        `# ${DREAMING_TEST_DAY}`,
        "",
        "- Move backups to S3 Glacier.",
        "- Keep retention at 365 days.",
        "- Rotate access keys after the audit.",
      ]);

      setDreamingTestTime(5);
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_rem_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
    });

    expect(subagent.run).toHaveBeenCalledTimes(1);
    const firstRun = firstNarrativeRun(subagent);
    expect(firstRun.message).toContain("Move backups to S3 Glacier.");
    expect(firstRun.message).toContain("Keep retention at 365 days.");
    expect(firstRun.model).toBe("xai/grok-4.1-fast");
    await expect(fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8")).resolves.toContain(
      "The traces braided themselves into a map.",
    );
  });

  it("increments dailyCount when the same daily file is re-ingested on a later day", async () => {
    // Regression test for #67061: dayBucket used the file date instead of the
    // ingestion date, so re-ingesting the same file on a different day was
    // treated as a duplicate and dailyCount stayed at 1.
    const workspaceDir = await createDreamingWorkspace();
    // Write a daily note dated 2026-04-03 (two days before the base test time).
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-03.md"),
      ["# 2026-04-03", "", "- Move backups to S3 Glacier.", "- Keep retention at 365 days."].join(
        "\n",
      ),
      "utf-8",
    );

    const configForTest: OpenClawConfig = {
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                enabled: true,
                phases: {
                  light: {
                    enabled: true,
                    limit: 20,
                    lookbackDays: 7,
                  },
                },
              },
            },
          },
        },
      },
    };

    // First ingestion on 2026-04-05.
    const day1Ms = Date.parse("2026-04-05T10:00:00.000Z");
    const { beforeAgentReply: reply1 } = createHarness(configForTest, workspaceDir);
    await withDreamingTestClock(async () => {
      vi.setSystemTime(new Date(day1Ms));
      await reply1(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
    });

    const after1 = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: day1Ms,
    });
    expect(after1).toHaveLength(1);
    expect(after1[0]?.dailyCount).toBe(1);
    expect(after1[0]?.lastRecalledAt).toBe("2026-04-05T10:00:00.000Z");

    const day2Ms = Date.parse("2026-04-06T10:00:00.000Z");
    const { beforeAgentReply: reply2 } = createHarness(configForTest, workspaceDir);
    await withDreamingTestClock(async () => {
      vi.setSystemTime(new Date(day2Ms));
      await reply2(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
    });

    const after2 = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: day2Ms,
    });
    expect(after2).toHaveLength(1);
    expect(after2[0]?.dailyCount).toBe(2);
    expect(after2[0]?.lastRecalledAt).toBe("2026-04-05T10:00:00.000Z");
  });
});

describe("filterRecallEntriesWithinLookback", () => {
  const NOW_MS = new Date("2026-04-15T12:00:00.000Z").getTime();
  const LOOKBACK_DAYS = 3;
  const STALE_LAST_RECALLED_AT = new Date("2026-03-01T00:00:00.000Z").toISOString();
  const FRESH_RECALL_DAY = "2026-04-14";

  function makeEntry(
    overrides: Partial<ShortTermRecallEntry> & Pick<ShortTermRecallEntry, "key">,
  ): ShortTermRecallEntry {
    return {
      key: overrides.key,
      path: overrides.path ?? "src/example.ts",
      startLine: overrides.startLine ?? 1,
      endLine: overrides.endLine ?? 10,
      source: "memory",
      snippet: overrides.snippet ?? "example snippet",
      recallCount: overrides.recallCount ?? 1,
      dailyCount: overrides.dailyCount ?? 0,
      groundedCount: overrides.groundedCount ?? 0,
      totalScore: overrides.totalScore ?? 1,
      maxScore: overrides.maxScore ?? 1,
      firstRecalledAt: overrides.firstRecalledAt ?? STALE_LAST_RECALLED_AT,
      lastRecalledAt: overrides.lastRecalledAt ?? STALE_LAST_RECALLED_AT,
      queryHashes: overrides.queryHashes ?? [],
      recallDays: overrides.recallDays ?? [],
      conceptTags: overrides.conceptTags ?? [],
      ...(overrides.claimHash !== undefined ? { claimHash: overrides.claimHash } : {}),
      ...(overrides.promotedAt !== undefined ? { promotedAt: overrides.promotedAt } : {}),
    };
  }

  it("keeps entries with stale lastRecalledAt when recallDays has a recent day", () => {
    const entry = makeEntry({
      key: "stale-last-recalled-fresh-day",
      lastRecalledAt: STALE_LAST_RECALLED_AT,
      recallDays: [FRESH_RECALL_DAY],
    });
    const result = filterRecallEntriesWithinLookback({
      entries: [entry],
      nowMs: NOW_MS,
      lookbackDays: LOOKBACK_DAYS,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe("stale-last-recalled-fresh-day");
  });

  it("keeps entries with unparseable lastRecalledAt when recallDays has a recent day", () => {
    const entry = makeEntry({
      key: "bad-last-recalled-fresh-day",
      lastRecalledAt: "not-a-date",
      recallDays: [FRESH_RECALL_DAY],
    });
    const result = filterRecallEntriesWithinLookback({
      entries: [entry],
      nowMs: NOW_MS,
      lookbackDays: LOOKBACK_DAYS,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe("bad-last-recalled-fresh-day");
  });

  it("drops entries whose lastRecalledAt and recallDays are both outside the window", () => {
    const entry = makeEntry({
      key: "stale-everything",
      lastRecalledAt: STALE_LAST_RECALLED_AT,
      recallDays: ["2026-03-02"],
    });
    const result = filterRecallEntriesWithinLookback({
      entries: [entry],
      nowMs: NOW_MS,
      lookbackDays: LOOKBACK_DAYS,
    });
    expect(result).toHaveLength(0);
  });

  it("keeps entries with a recent lastRecalledAt even when recallDays is empty", () => {
    const entry = makeEntry({
      key: "fresh-last-recalled-no-days",
      lastRecalledAt: new Date("2026-04-14T00:00:00.000Z").toISOString(),
      recallDays: [],
    });
    const result = filterRecallEntriesWithinLookback({
      entries: [entry],
      nowMs: NOW_MS,
      lookbackDays: LOOKBACK_DAYS,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe("fresh-last-recalled-no-days");
  });
});

describe("previewRemHarness", () => {
  it("ignores daily-named directories when collecting grounded inputs", async () => {
    const workspaceDir = await createDreamingWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(path.join(memoryDir, "2026-04-14.md"), { recursive: true });
    await fs.writeFile(path.join(memoryDir, "2026-04-15.md"), "# Day\n\nWorked on REM.\n", "utf-8");

    const preview = await previewRemHarness({
      workspaceDir,
      grounded: true,
      pluginConfig: {
        dreaming: {
          enabled: true,
          phases: {
            rem: { enabled: true, limit: 10 },
          },
        },
      },
    });

    expect(preview.groundedInputPaths.map((entry) => path.basename(entry))).toEqual([
      "2026-04-15.md",
    ]);
    expect(preview.grounded?.scannedFiles).toBe(1);
  });

  it("keeps grounded preview null when no grounded inputs exist", async () => {
    const workspaceDir = await createDreamingWorkspace();

    const preview = await previewRemHarness({
      workspaceDir,
      grounded: true,
      pluginConfig: {
        dreaming: {
          enabled: true,
          phases: {
            rem: { enabled: true, limit: 10 },
          },
        },
      },
    });

    expect(preview.groundedInputPaths).toStrictEqual([]);
    expect(preview.grounded).toBeNull();
  });

  it("skips REM short-term candidates whose source file disappeared", async () => {
    const workspaceDir = await createDreamingWorkspace();
    const nowMs = new Date("2026-04-15T12:00:00.000Z").getTime();
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-14.md"),
      "Move backups to S3 Glacier.\n",
      "utf-8",
    );
    await recordShortTermRecalls({
      workspaceDir,
      query: "live backup",
      nowMs,
      results: [
        {
          path: "memory/2026-04-14.md",
          startLine: 1,
          endLine: 1,
          score: 0.91,
          snippet: "Move backups to S3 Glacier.",
          source: "memory",
        },
      ],
    });
    await recordShortTermRecalls({
      workspaceDir,
      query: "stale provider setup",
      nowMs,
      results: [
        {
          path: "memory/.dreams/session-corpus/2026-04-16.txt",
          startLine: 2,
          endLine: 2,
          score: 0.88,
          snippet: "Assistant: Documented Ollama provider setup.",
          source: "memory",
        },
      ],
    });

    const preview = await previewRemHarness({
      workspaceDir,
      nowMs,
      pluginConfig: {
        dreaming: {
          enabled: true,
          phases: {
            rem: {
              enabled: true,
              lookbackDays: 7,
              limit: 10,
              minPatternStrength: 0,
            },
          },
        },
      },
    });

    const candidateTruthSnippets = preview.rem.candidateTruths
      .map((entry) => entry.snippet)
      .join("\n");
    const bodyText = preview.rem.bodyLines.join("\n");
    expect(preview.recallEntryCount).toBe(1);
    expect(preview.rem.sourceEntryCount).toBe(1);
    expect(candidateTruthSnippets).toContain("Move backups to S3 Glacier.");
    expect(candidateTruthSnippets).not.toContain("Documented Ollama provider setup");
    expect(bodyText).toContain("Move backups to S3 Glacier.");
    expect(bodyText).not.toContain("Documented Ollama provider setup");
  });

  it("skips REM preview when rem.limit=0 while still ranking deep candidates", async () => {
    const workspaceDir = await createDreamingWorkspace();
    const nowMs = new Date("2026-04-15T12:00:00.000Z").getTime();
    await recordShortTermRecalls({
      workspaceDir,
      query: "outdoor plans",
      nowMs,
      results: [
        {
          path: "memory/2026-04-14.md",
          startLine: 1,
          endLine: 1,
          score: 0.92,
          snippet: "Always check weather before suggesting outdoor plans.",
          source: "memory",
        },
      ],
    });

    const preview = await previewRemHarness({
      workspaceDir,
      nowMs,
      pluginConfig: {
        dreaming: {
          enabled: true,
          phases: {
            rem: { enabled: true, limit: 0 },
          },
        },
      },
    });

    expect(preview.remSkipped).toBe(true);
    expect(preview.rem.candidateTruths).toStrictEqual([]);
    expect(preview.rem.bodyLines).toStrictEqual([]);
    expect(preview.deep.candidates[0]?.snippet).toContain("Always check weather");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
