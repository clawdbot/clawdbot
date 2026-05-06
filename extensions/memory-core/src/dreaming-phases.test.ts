import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { RequestScopedSubagentRuntimeError } from "openclaw/plugin-sdk/error-runtime";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  resolveMemoryCorePluginConfig,
  resolveMemoryLightDreamingConfig,
  resolveMemoryRemDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { describe, expect, it, vi } from "vitest";
import {
  __testing,
  filterRecallEntriesWithinLookback,
  runDreamingSweepPhases,
} from "./dreaming-phases.js";
import { previewRemHarness } from "./rem-harness.js";
import {
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
  resolveShortTermPhaseSignalStorePath,
  type ShortTermRecallEntry,
} from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
const DREAMING_TEST_BASE_TIME = new Date("2026-04-05T10:00:00.000Z");
const DREAMING_TEST_DAY = "2026-04-05";
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

function createHarness(
  config: OpenClawConfig,
  workspaceDir?: string,
  subagent?: Parameters<typeof __testing.runPhaseIfTriggered>[0]["subagent"],
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
  const pluginConfig = resolveMemoryCorePluginConfig(resolvedConfig) ?? {};
  const beforeAgentReply = async (
    event: { cleanedBody: string },
    ctx: { trigger?: string; workspaceDir?: string },
  ) => {
    const light = resolveMemoryLightDreamingConfig({ pluginConfig, cfg: resolvedConfig });
    const lightResult = await __testing.runPhaseIfTriggered({
      cleanedBody: event.cleanedBody,
      trigger: ctx.trigger,
      workspaceDir: ctx.workspaceDir,
      cfg: resolvedConfig,
      logger,
      subagent,
      phase: "light",
      eventText: __testing.constants.LIGHT_SLEEP_EVENT_TEXT,
      config: light,
    });
    if (lightResult) {
      return lightResult;
    }
    const rem = resolveMemoryRemDreamingConfig({ pluginConfig, cfg: resolvedConfig });
    return await __testing.runPhaseIfTriggered({
      cleanedBody: event.cleanedBody,
      trigger: ctx.trigger,
      workspaceDir: ctx.workspaceDir,
      cfg: resolvedConfig,
      logger,
      subagent,
      phase: "rem",
      eventText: __testing.constants.REM_SLEEP_EVENT_TEXT,
      config: rem,
    });
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
    const expectedSessionKey = `dreaming-narrative-light-${workspaceHash}-${nowMs}`;

    await runDreamingSweepPhases({
      workspaceDir,
      cfg: testConfig,
      pluginConfig: resolveMemoryCorePluginConfig(testConfig),
      logger,
      subagent,
      nowMs,
    });

    expect(subagent.deleteSession).toHaveBeenCalledOnce();
    expect(subagent.deleteSession).toHaveBeenCalledWith({ sessionKey: expectedSessionKey });
  });

  it("skips session cleanup after request-scoped narrative fallback", async () => {
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
        pluginConfig: resolveMemoryCorePluginConfig(testConfig),
        logger,
        subagent,
        nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
      }),
    ).resolves.toBeUndefined();

    const dreams = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(dreams).toContain("Move backups to S3 Glacier.");
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("request-scoped"));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("request-scoped"));
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("narrative session cleanup failed"),
    );
    expect(subagent.deleteSession).not.toHaveBeenCalled();
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
      expect(dailyContent.match(/^- Candidate:/gm)).toHaveLength(1);
      expect(dailyContent).not.toContain("Light Sleep: Candidate:");
    });
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
    await expect(
      fs.access(path.join(workspaceDir, "memory", ".dreams", "daily-ingestion.json")),
    ).resolves.toBeUndefined();
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
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, "dreaming-main.jsonl");
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "session",
          id: "dreaming-main",
          timestamp: "2026-04-05T18:00:00.000Z",
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-05T18:01:00.000Z",
            content: [{ type: "text", text: "Move backups to S3 Glacier." }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: "2026-04-05T18:02:00.000Z",
            content: [{ type: "text", text: "Set retention to 365 days." }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

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

    const readSpy = vi.spyOn(fs, "readFile");
    let transcriptReadCount = 0;
    try {
      await withDreamingTestClock(async () => {
        await triggerLightDreaming(beforeAgentReply, workspaceDir, 5);
        await triggerLightDreaming(beforeAgentReply, workspaceDir, 6);
      });
    } finally {
      transcriptReadCount = readSpy.mock.calls.filter(
        ([target]) => typeof target === "string" && target === transcriptPath,
      ).length;
      readSpy.mockRestore();
      vi.unstubAllEnvs();
    }

    expect(transcriptReadCount).toBeLessThanOrEqual(1);

    await expect(
      fs.access(path.join(workspaceDir, "memory", ".dreams", "session-ingestion.json")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-05.txt")),
    ).resolves.toBeUndefined();

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
    expect(ranked.map((candidate) => candidate.snippet)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Move backups to S3 Glacier."),
        expect.stringContaining("Set retention to 365 days."),
      ]),
    );
  });

  it("keeps primary session transcripts out of configured subagent workspaces", async () => {
    const workspaceDir = await createDreamingWorkspace();
    const subagentWorkspaceDir = await createDreamingWorkspace();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));

    const mainSessionsDir = resolveSessionTranscriptsDirForAgent("main");
    const subagentSessionsDir = resolveSessionTranscriptsDirForAgent("agi-ceo");
    await fs.mkdir(mainSessionsDir, { recursive: true });
    await fs.mkdir(subagentSessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(mainSessionsDir, "main-session.jsonl"),
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-05T18:01:00.000Z",
            content: [{ type: "text", text: "Main workspace should stay in main dreams." }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(subagentSessionsDir, "subagent-session.jsonl"),
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-05T18:02:00.000Z",
            content: [{ type: "text", text: "CEO workspace should stay in CEO dreams." }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const { beforeAgentReply } = createHarness(
      {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
          list: [{ id: "agi-ceo", workspace: subagentWorkspaceDir }],
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
      vi.unstubAllEnvs();
    }

    const mainCorpus = await fs.readFile(
      path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-05.txt"),
      "utf-8",
    );
    const subagentCorpus = await fs.readFile(
      path.join(subagentWorkspaceDir, "memory", ".dreams", "session-corpus", "2026-04-05.txt"),
      "utf-8",
    );
    expect(mainCorpus).toContain("Main workspace should stay in main dreams.");
    expect(mainCorpus).not.toContain("CEO workspace should stay in CEO dreams.");
    expect(subagentCorpus).toContain("CEO workspace should stay in CEO dreams.");
    expect(subagentCorpus).not.toContain("Main workspace should stay in main dreams.");
  });

  it("redacts sensitive session content before writing session corpus", async () => {
    const workspaceDir = await createDreamingWorkspace();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, "dreaming-main.jsonl");
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-05T18:01:00.000Z",
            content: [{ type: "text", text: "OPENAI_API_KEY=sk-1234567890abcdef" }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const mtime = new Date("2026-04-05T18:05:00.000Z");
    await fs.utimes(transcriptPath, mtime, mtime);

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
      vi.unstubAllEnvs();
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
    expect(corpus).toContain("OPENAI_API_KEY=sk-123…cdef");
  });

  it("skips dreaming-generated narrative transcripts during session ingestion", async () => {
    const workspaceDir = await createDreamingWorkspace();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, "dreaming-narrative.jsonl");
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "custom",
          customType: "openclaw:bootstrap-context:full",
          data: {
            runId: "dreaming-narrative-light-1775894400455",
            sessionId: "dream-session-1",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-05T18:01:00.000Z",
            content: [
              { type: "text", text: "Write a dream diary entry from these memory fragments." },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: "2026-04-05T18:02:00.000Z",
            content: [{ type: "text", text: "I drift through the same archive again." }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const mtime = new Date("2026-04-05T18:05:00.000Z");
    await fs.utimes(transcriptPath, mtime, mtime);

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
      vi.unstubAllEnvs();
    }

    await expect(
      fs.access(path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-05.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const sessionIngestion = JSON.parse(
      await fs.readFile(
        path.join(workspaceDir, "memory", ".dreams", "session-ingestion.json"),
        "utf-8",
      ),
    ) as {
      files: Record<
        string,
        {
          lineCount: number;
          lastContentLine: number;
          contentHash: string;
        }
      >;
    };
    expect(Object.keys(sessionIngestion.files)).toHaveLength(1);
    expect(Object.values(sessionIngestion.files)).toEqual([
      expect.objectContaining({
        lineCount: 0,
        lastContentLine: 0,
        contentHash: expect.any(String),
      }),
    ]);
  });

  it("skips dreaming transcripts when the session store identifies them before bootstrap lands", async () => {
    const workspaceDir = await createDreamingWorkspace();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, "dreaming-narrative.jsonl");
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-05T18:01:00.000Z",
            content: [
              { type: "text", text: "Write a dream diary entry from these memory fragments." },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: "2026-04-05T18:02:00.000Z",
            content: [{ type: "text", text: "I drift through the same archive again." }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:dreaming-narrative-light-1775894400455": {
          sessionId: "dreaming-narrative",
          sessionFile: transcriptPath,
          updatedAt: Date.parse("2026-04-05T18:05:00.000Z"),
        },
      }),
      "utf-8",
    );
    const mtime = new Date("2026-04-05T18:05:00.000Z");
    await fs.utimes(transcriptPath, mtime, mtime);

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
      vi.unstubAllEnvs();
    }

    await expect(
      fs.access(path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-05.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const sessionIngestion = JSON.parse(
      await fs.readFile(
        path.join(workspaceDir, "memory", ".dreams", "session-ingestion.json"),
        "utf-8",
      ),
    ) as {
      files: Record<
        string,
        {
          lineCount: number;
          lastContentLine: number;
          contentHash: string;
        }
      >;
    };
    expect(Object.keys(sessionIngestion.files)).toHaveLength(1);
    expect(Object.values(sessionIngestion.files)).toEqual([
      expect.objectContaining({
        lineCount: 0,
        lastContentLine: 0,
        contentHash: expect.any(String),
      }),
    ]);
  });

  it("skips isolated cron run transcripts during session ingestion", async () => {
    const workspaceDir = await createDreamingWorkspace();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, "cron-run.jsonl");
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-05T18:01:00.000Z",
            content:
              "[cron:job-1 Codex Sessions Sync] Run Codex sessions sync: 1. Convert sessions 2. Update qmd",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: "2026-04-05T18:02:00.000Z",
            content: "Running Codex sessions sync...",
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:cron:job-1:run:run-1": {
          sessionId: "cron-run",
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
        },
      }),
      "utf-8",
    );

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
      vi.unstubAllEnvs();
    }

    await expect(
      fs.access(path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-05.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const sessionIngestion = JSON.parse(
      await fs.readFile(
        path.join(workspaceDir, "memory", ".dreams", "session-ingestion.json"),
        "utf-8",
      ),
    ) as {
      files: Record<
        string,
        {
          lineCount: number;
          lastContentLine: number;
          contentHash: string;
        }
      >;
    };
    expect(Object.values(sessionIngestion.files)).toEqual([
      expect.objectContaining({
        lineCount: 0,
        lastContentLine: 0,
        contentHash: expect.any(String),
      }),
    ]);
  });

  it("drops generated system wrapper text without suppressing paired assistant replies", async () => {
    const workspaceDir = await createDreamingWorkspace();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, "ordinary-session.jsonl");
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-16T18:01:00.000Z",
            content:
              "System (untrusted): [2026-04-16 11:01:00 PDT] Exec completed (quiet-fo, code 0) :: Converted: 1",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: "2026-04-16T18:01:30.000Z",
            content: "Handled internally.",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-16T18:02:00.000Z",
            content: "What changed in the sync?",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: "2026-04-16T18:03:00.000Z",
            content: "One new session was converted.",
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

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
      vi.unstubAllEnvs();
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
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
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
    await fs.writeFile(
      path.join(sessionsDir, "ordinary.jsonl"),
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-16T18:04:00.000Z",
            content:
              "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: "2026-04-16T18:05:00.000Z",
            content: "HEARTBEAT_OK",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-16T18:06:00.000Z",
            content: "[cron:job-2 Example] Run the qmd sync",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: "2026-04-16T18:07:00.000Z",
            content: "Running the qmd sync now.",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-16T18:08:00.000Z",
            content: "Document the Ollama provider setup.",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: "2026-04-16T18:09:00.000Z",
            content: "I documented the Ollama provider setup in the workspace notes.",
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

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
      vi.unstubAllEnvs();
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
    const preview = __testing.previewRemDreaming({
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
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, "dreaming-narrative.jsonl");
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "custom",
          customType: "openclaw:bootstrap-context:full",
          data: {
            runId: "dreaming-narrative-light-1775894400455",
            sessionId: "dream-session-1",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-05T18:01:00.000Z",
            content: [
              { type: "text", text: "Write a dream diary entry from these memory fragments." },
            ],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const mtime = new Date("2026-04-05T18:05:00.000Z");
    await fs.utimes(transcriptPath, mtime, mtime);

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

      const readFileSpy = vi.spyOn(fs, "readFile");
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );

      expect(
        readFileSpy.mock.calls.some(
          ([target]) => typeof target === "string" && target === transcriptPath,
        ),
      ).toBe(false);
      readFileSpy.mockRestore();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  it("dedupes reset/deleted session archives instead of double-ingesting", async () => {
    const workspaceDir = await createDreamingWorkspace();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, "dreaming-main.jsonl");
    const oldMessage = "Move backups to S3 Glacier.";
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-05T18:01:00.000Z",
            content: [{ type: "text", text: oldMessage }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const dayOne = new Date("2026-04-05T18:05:00.000Z");
    await fs.utimes(transcriptPath, dayOne, dayOne);

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
      await fs.writeFile(resetPath, await fs.readFile(transcriptPath, "utf-8"), "utf-8");
      const newMessage = "Keep retention at 365 days.";
      await fs.writeFile(
        transcriptPath,
        [
          JSON.stringify({
            type: "message",
            message: {
              role: "user",
              timestamp: "2026-04-05T18:01:00.000Z",
              content: [{ type: "text", text: oldMessage }],
            },
          }),
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              timestamp: "2026-04-06T01:02:00.000Z",
              content: [{ type: "text", text: newMessage }],
            },
          }),
        ].join("\n") + "\n",
        "utf-8",
      );
      const dayTwo = new Date("2026-04-06T01:05:00.000Z");
      await fs.utimes(transcriptPath, dayTwo, dayTwo);
      await fs.utimes(resetPath, dayTwo, dayTwo);

      await withDreamingTestClock(async () => {
        await triggerLightDreaming(beforeAgentReply, workspaceDir, 910);
      });
    } finally {
      vi.unstubAllEnvs();
    }

    const ranked = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-04-06T02:00:00.000Z"),
    });
    const oldCandidate = ranked.find((candidate) => candidate.snippet.includes(oldMessage));
    const newCandidate = ranked.find((candidate) => candidate.snippet.includes("retention at 365"));
    expect(oldCandidate?.dailyCount).toBe(1);
    expect(newCandidate?.dailyCount).toBe(1);

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

  it("buckets session snippets by per-message day rather than file mtime", async () => {
    const workspaceDir = await createDreamingWorkspace();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, "dreaming-main.jsonl");
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-01T12:00:00.000Z",
            content: [
              { type: "text", text: "Old planning note that should stay out of lookback." },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: "2026-04-05T18:02:00.000Z",
            content: [{ type: "text", text: "Current reminder that should be in today corpus." }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const freshMtime = new Date("2026-04-06T01:05:00.000Z");
    await fs.utimes(transcriptPath, freshMtime, freshMtime);

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
      vi.unstubAllEnvs();
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
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, "dreaming-main.jsonl");
    const lines: string[] = [];
    for (let index = 0; index < 160; index += 1) {
      lines.push(
        JSON.stringify({
          type: "message",
          message: {
            role: index % 2 === 0 ? "user" : "assistant",
            timestamp: "2026-04-05T18:00:00.000Z",
            content: [{ type: "text", text: `bulk-line-${index}` }],
          },
        }),
      );
    }
    await fs.writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf-8");
    const mtime = new Date("2026-04-05T18:05:00.000Z");
    await fs.utimes(transcriptPath, mtime, mtime);

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
      vi.unstubAllEnvs();
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

  it("re-ingests rewritten session transcripts after truncate/reset", async () => {
    const workspaceDir = await createDreamingWorkspace();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, "dreaming-main.jsonl");

    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-05T18:01:00.000Z",
            content: [{ type: "text", text: "Move backups to S3 Glacier." }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const dayOne = new Date("2026-04-05T18:05:00.000Z");
    await fs.utimes(transcriptPath, dayOne, dayOne);

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

      await fs.writeFile(
        transcriptPath,
        [
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              timestamp: "2026-04-06T01:02:00.000Z",
              content: [{ type: "text", text: "Retention policy stays at 365 days." }],
            },
          }),
        ].join("\n") + "\n",
        "utf-8",
      );
      const dayTwo = new Date("2026-04-06T01:05:00.000Z");
      await fs.utimes(transcriptPath, dayTwo, dayTwo);

      await withDreamingTestClock(async () => {
        await triggerLightDreaming(beforeAgentReply, workspaceDir, 910);
      });
    } finally {
      vi.unstubAllEnvs();
    }

    const ranked = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-04-06T02:00:00.000Z"),
    });
    expect(ranked.map((candidate) => candidate.snippet)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Move backups to S3 Glacier."),
        expect.stringContaining("Retention policy stays at 365 days."),
      ]),
    );
  });

  it("ingests sessions when dreaming is enabled even if memorySearch is disabled", async () => {
    const workspaceDir = await createDreamingWorkspace();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, "dreaming-main.jsonl");
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: "2026-04-05T18:01:00.000Z",
            content: [{ type: "text", text: "Glacier archive migration is now complete." }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const mtime = new Date("2026-04-05T18:05:00.000Z");
    await fs.utimes(transcriptPath, mtime, mtime);

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
      vi.unstubAllEnvs();
    }

    const ranked = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-04-05T19:00:00.000Z"),
    });
    expect(ranked.map((candidate) => candidate.snippet)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Glacier archive migration is now complete."),
      ]),
    );
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
    expect(after.map((candidate) => candidate.snippet)).toEqual(
      expect.arrayContaining([
        "Reviewed travel timing and calendar placement.",
        expect.stringContaining("Emma Rees:"),
      ]),
    );
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
    expect(after.map((candidate) => candidate.snippet)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Operations: Restarted the gateway after auth drift.; Tokens now line up again.",
        ),
        expect.stringContaining(
          "Bex: She prefers direct plans over open-ended maybes.; Better to offer one concrete time window.",
        ),
        expect.stringContaining("Travel: Flight lands at 08:10."),
      ]),
    );
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
    const baselineScore = baseline[0].score;

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
    const reinforcedCandidate = reinforced.find((candidate) => candidate.key === baseline[0].key);
    expect(reinforcedCandidate).toBeDefined();
    expect(reinforcedCandidate!.score).toBeGreaterThan(baselineScore);

    const phaseSignalPath = resolveShortTermPhaseSignalStorePath(workspaceDir);
    const phaseSignalStore = JSON.parse(await fs.readFile(phaseSignalPath, "utf-8")) as {
      entries: Record<string, { lightHits: number; remHits: number }>;
    };
    expect(phaseSignalStore.entries[baseline[0].key]).toMatchObject({
      lightHits: 1,
      remHits: 1,
    });
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
          snippet: "Assistant: Documented Ollama provider setup.",
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
    const liveKey = baseline.find((candidate) => candidate.path === "memory/2026-04-03.md")?.key;
    const staleKey = baseline.find((candidate) =>
      candidate.path.includes("session-corpus/2026-04-16.txt"),
    )?.key;
    expect(liveKey).toBeDefined();
    expect(staleKey).toBeDefined();

    await withDreamingTestClock(async () => {
      setDreamingTestTime();
      await __testing.runPhaseIfTriggered({
        cleanedBody: __testing.constants.REM_SLEEP_EVENT_TEXT,
        trigger: "heartbeat",
        workspaceDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        phase: "rem",
        eventText: __testing.constants.REM_SLEEP_EVENT_TEXT,
        config: {
          enabled: true,
          lookbackDays: 7,
          limit: 10,
          minPatternStrength: 0,
          timezone: "UTC",
          storage: { mode: "inline", separateReports: false },
        },
      });
    });

    const phaseSignalPath = resolveShortTermPhaseSignalStorePath(workspaceDir);
    const phaseSignalStore = JSON.parse(await fs.readFile(phaseSignalPath, "utf-8")) as {
      entries: Record<string, { remHits: number }>;
    };
    expect(phaseSignalStore.entries[liveKey!]).toMatchObject({ remHits: 1 });
    expect(phaseSignalStore.entries[staleKey!]).toBeUndefined();

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
    const firstRun = subagent.run.mock.calls[0]?.[0];
    expect(firstRun?.message).toContain("Move backups to S3 Glacier.");
    expect(firstRun?.message).toContain("Keep retention at 365 days.");
    expect(firstRun?.model).toBe("anthropic/claude-sonnet-4-6");
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
    const firstRun = subagent.run.mock.calls[0]?.[0];
    expect(firstRun?.message).toContain("Move backups to S3 Glacier.");
    expect(firstRun?.message).toContain("Keep retention at 365 days.");
    expect(firstRun?.model).toBe("xai/grok-4.1-fast");
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

    expect(preview.groundedInputPaths).toEqual([]);
    expect(preview.grounded).toBeNull();
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
    expect(preview.rem.candidateTruths).toEqual([]);
    expect(preview.rem.bodyLines).toEqual([]);
    expect(preview.deep.candidates[0]?.snippet).toContain("Always check weather");
  });
});
