import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core";
import {
  resolveMemoryCorePluginConfig,
  resolveMemoryLightDreamingConfig,
  resolveMemoryRemDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { describe, expect, it, vi } from "vitest";
import { __testing } from "./dreaming-phases.js";
import {
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
  resolveShortTermPhaseSignalStorePath,
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

function createHarness(config: OpenClawConfig, workspaceDir?: string) {
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
      phase: "rem",
      eventText: __testing.constants.REM_SLEEP_EVENT_TEXT,
      config: rem,
    });
  };
  return { beforeAgentReply, logger };
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
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
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
        lineCount: 2,
        lastContentLine: 2,
        contentHash: expect.any(String),
      }),
    ]);
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
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );

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

      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
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
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
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
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );

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

      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
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
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
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
    await recordShortTermRecalls({
      workspaceDir,
      query: "glacier backup",
      nowMs,
      results: [
        {
          path: "memory/2026-04-03.md",
          startLine: 1,
          endLine: 2,
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
          endLine: 2,
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
    await beforeAgentReply(
      { cleanedBody: "__openclaw_memory_core_rem_sleep__" },
      { trigger: "heartbeat", workspaceDir },
    );

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
});
