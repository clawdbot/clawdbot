import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeBackfillDiaryEntries } from "./dreaming-narrative.js";
import {
  clearMemoryCoreWorkspaceNamespace,
  SESSION_BACKFILL_REWIND_NAMESPACE,
} from "./dreaming-state.js";
import { listMemoryEntryOrigins, recordMemorySessionTombstones } from "./memory-entry-origins.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  markSessionBackfillRewindBaseline,
  resetSessionBackfillIngestionState,
  rewindSessionBackfillIngestionState,
} from "./session-backfill-lifecycle.js";
import {
  executeSessionBackfill,
  executeSessionBackfillBatch,
  runSessionBackfill,
} from "./session-backfill.js";
import { writeSessionIngestionState } from "./session-ingestion.js";
import {
  readShortTermRecallEntries,
  recordGroundedShortTermCandidates,
  recordShortTermRecalls,
} from "./short-term-promotion.js";
import { createMemoryCoreTestHarness, dreamingTestState } from "./test-helpers.js";

const harness = createMemoryCoreTestHarness();

type TranscriptMessage = {
  role: "assistant" | "tool" | "user";
  content: string;
  timestamp: string;
  owner?: boolean;
};

async function writeTranscript(filePath: string, messages: TranscriptMessage[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const records = messages.map((message, index) => ({
    type: "message",
    id: `message-${index}`,
    timestamp: message.timestamp,
    message: {
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      ...(message.owner ? { __openclaw: { senderIsOwner: true } } : {}),
    },
  }));
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

async function seedCanonicalTranscript(
  sessionId: string,
  messages: TranscriptMessage[],
  metadata: Partial<Parameters<typeof upsertSessionEntry>[0]["entry"]> = {},
): Promise<void> {
  const agentId = "main";
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const storePath = path.join(sessionsDir, "sessions.json");
  const sessionKey = `agent:${agentId}:session-backfill:${sessionId}`;
  const updatedAt = Math.max(
    Date.now(),
    ...messages.map((message) => Date.parse(message.timestamp)),
  );
  await fs.mkdir(sessionsDir, { recursive: true });
  const entry = { ...metadata, sessionId, updatedAt };
  await upsertSessionEntry({ agentId, sessionKey, storePath, entry });
  for (const message of messages) {
    await appendSessionTranscriptMessageByIdentity({
      agentId,
      sessionId,
      sessionKey,
      storePath,
      message: {
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        ...(message.owner ? { __openclaw: { senderIsOwner: true } } : {}),
      },
    });
  }
  await upsertSessionEntry({ agentId, sessionKey, storePath, entry });
}

async function createIsolatedWorkspace(prefix: string): Promise<string> {
  const workspaceDir = await harness.createTempWorkspace(prefix);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(workspaceDir, "openclaw.json"));
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  return workspaceDir;
}

function hashStagedContent(
  entries: Awaited<ReturnType<typeof readShortTermRecallEntries>>,
): string {
  const content = entries
    .map((entry) => ({
      claimHash: entry.claimHash,
      provenance: entry.provenance,
      snippet: entry.snippet,
    }))
    .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

afterEach(() => {
  vi.unstubAllEnvs();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

describe("runSessionBackfill", () => {
  it("keeps CLI draining separate from the single-batch executor", () => {
    expect(runSessionBackfill).not.toBe(executeSessionBackfill);
  });

  it("keeps REM preview mode mutually exclusive with apply", async () => {
    const workspaceDir = await createIsolatedWorkspace("rem-apply-");

    await expect(
      runSessionBackfill({
        agentId: "main",
        workspaceDir,
        rem: true,
        apply: true,
      }),
    ).rejects.toThrow("Memory session-backfill --rem cannot be combined with --apply.");
  });

  it("never resurrects forgotten canonical sessions through session backfill apply", async () => {
    const workspaceDir = await createIsolatedWorkspace("forgotten-");
    await seedCanonicalTranscript("forgotten", [
      {
        role: "user",
        content: "Forgotten owner claim must never return.",
        timestamp: "2026-01-02T12:00:00.000Z",
        owner: true,
      },
    ]);
    await seedCanonicalTranscript("retained", [
      {
        role: "user",
        content: "Retained owner claim remains eligible.",
        timestamp: "2026-01-02T12:01:00.000Z",
        owner: true,
      },
    ]);
    recordMemorySessionTombstones({ agentId: "main", sessionIds: ["forgotten"] });

    const result = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      apply: true,
      timezone: "UTC",
    });

    expect(result.candidateCount).toBe(1);
    expect(result.days[0]?.topCandidates).toEqual(["User: Retained owner claim remains eligible."]);
    const ingestion = await dreamingTestState.readSessionIngestionState(workspaceDir);
    expect(ingestion.files).not.toHaveProperty("main:sessions/main/forgotten");
  });

  it.each([{ mode: "preview" }, { mode: "rem", rem: true }, { mode: "apply", apply: true }])(
    "honors admission exclusions during $mode",
    async ({ mode, ...options }) => {
      const workspaceDir = await createIsolatedWorkspace(`admission-${mode}-`);
      const sources = [
        { sessionId: "hook", metadata: { hookExternalContentSource: "gmail" as const } },
        {
          sessionId: "channel",
          metadata: {
            delivery: normalizeSessionDeliveryState({
              context: { channel: "discord", to: "channel:admission-fixture" },
              origin: { provider: "discord", to: "channel:admission-fixture" },
            }),
          },
        },
        { sessionId: "group", metadata: { chatType: "group" as const } },
        { sessionId: "retained", metadata: {} },
      ];
      for (const { sessionId, metadata } of sources) {
        await seedCanonicalTranscript(
          sessionId,
          [
            {
              role: "user",
              content: `${sessionId} trusted session preference.`,
              timestamp: "2026-01-02T12:00:00.000Z",
              owner: true,
            },
          ],
          metadata,
        );
      }

      const result = await runSessionBackfill({
        agentId: "main",
        workspaceDir,
        ...options,
        timezone: "UTC",
        pluginConfig: {
          memoryPolicy: {
            excludeSessions: {
              hookExternalContentSources: ["gmail"],
              channels: ["discord"],
              chatTypes: ["group"],
            },
          },
        },
      });

      expect(result.candidateCount).toBe(1);
      expect(result.days[0]?.topCandidates).toEqual(["User: retained trusted session preference."]);
    },
  );

  it("preserves every session origin when backfill coalesces equivalent snippets", async () => {
    const workspaceDir = await createIsolatedWorkspace("coalesced-origins-");
    const sources = [
      { sessionId: "first", role: "assistant", originClass: "agent", hour: "10" },
      { sessionId: "second", role: "user", originClass: "owner", hour: "11" },
    ] as const;
    for (const source of sources) {
      await seedCanonicalTranscript(source.sessionId, [
        {
          role: "user",
          content: "OK",
          timestamp: "2026-03-01T09:00:00.000Z",
          owner: true,
        },
        {
          role: source.role,
          content: "The preferred editor is Nova",
          timestamp: `2026-03-01T${source.hour}:00:00.000Z`,
          owner: source.role === "user",
        },
      ]);
    }

    const result = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      apply: true,
      timezone: "UTC",
    });
    const entries = await readShortTermRecallEntries({ workspaceDir });

    expect(result.stagedEntries).toBe(1);
    expect(entries).toHaveLength(1);
    expect(
      listMemoryEntryOrigins({ agentId: "main", entryKeys: [entries[0]!.key] }).map((origin) => ({
        entryKey: origin.entryKey,
        sessionId: origin.sessionId,
        originClass: origin.originClass,
        observedAt: origin.observedAt,
      })),
    ).toEqual(
      sources.map((source) => ({
        entryKey: entries[0]?.key,
        sessionId: source.sessionId,
        originClass: source.originClass,
        observedAt: Date.parse(`2026-03-01T${source.hour}:00:00.000Z`),
      })),
    );
  });

  it("does not stage already-read session content after its source is forgotten", async () => {
    const workspaceDir = await createIsolatedWorkspace("stale-staging-");
    const result = {
      path: "memory/.dreams/session-corpus/2026-03-01.txt",
      startLine: 1,
      endLine: 1,
      snippet: "The preferred editor is Nova",
      score: 0.9,
      source: "memory" as const,
      sessionOrigin: { agentId: "main", sessionId: "forgotten" },
    };
    recordMemorySessionTombstones({ agentId: "main", sessionIds: ["forgotten"] });

    await recordShortTermRecalls({
      workspaceDir,
      query: "__dreaming_sessions__:2026-03-01",
      results: [result],
      signalType: "daily",
    });
    await recordGroundedShortTermCandidates({
      workspaceDir,
      query: "__dreaming_session_backfill__:2026-03-01",
      items: [result],
    });

    expect(await readShortTermRecallEntries({ workspaceDir })).toEqual([]);
    expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual([]);
  });

  it("buckets messages in the configured timezone and processes days oldest first", async () => {
    const workspaceDir = await createIsolatedWorkspace("timezone-");
    await seedCanonicalTranscript("timezone", [
      {
        role: "user",
        content: "Late New York note",
        timestamp: "2026-01-02T00:30:00.000Z",
        owner: true,
      },
      {
        role: "user",
        content: "Early New York note",
        timestamp: "2026-01-02T05:30:00.000Z",
        owner: true,
      },
    ]);

    const result = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      timezone: "America/New_York",
    });

    expect(result.days.map((day) => [day.day, day.candidateCount])).toEqual([
      ["2026-01-01", 1],
      ["2026-01-02", 1],
    ]);
  });

  it("honors the day limit before moving to newer unprocessed days", async () => {
    const workspaceDir = await createIsolatedWorkspace("limit-");
    await seedCanonicalTranscript(
      "limited",
      ["2026-01-01", "2026-01-02", "2026-01-03"].map((day) => ({
        role: "user" as const,
        content: `Durable note for ${day}`,
        timestamp: `${day}T12:00:00.000Z`,
        owner: true,
      })),
    );

    const result = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      limitDays: 2,
      timezone: "UTC",
    });

    expect(result.days.map((day) => day.day)).toEqual(["2026-01-01", "2026-01-02"]);
  });

  it("reports authoritative continuation across bounded apply batches", async () => {
    const workspaceDir = await createIsolatedWorkspace("continuation-");
    await seedCanonicalTranscript(
      "continuation",
      ["2026-01-01", "2026-01-02", "2026-01-03"].map((day) => ({
        role: "user" as const,
        content: `Continuation note for ${day}`,
        timestamp: `${day}T12:00:00.000Z`,
        owner: true,
      })),
    );
    const run = () =>
      executeSessionBackfillBatch({
        agentId: "main",
        workspaceDir,
        apply: true,
        limitDays: 2,
        timezone: "UTC",
      });

    const first = await run();
    const second = await run();
    const exhausted = await run();

    expect(first.result.days.map((day) => day.day)).toEqual(["2026-01-01", "2026-01-02"]);
    expect(first.continuation).toEqual({ advanced: true, hasMore: true });
    expect(second.result.days.map((day) => day.day)).toEqual(["2026-01-03"]);
    expect(second.continuation).toEqual({ advanced: true, hasMore: false });
    expect(exhausted.result.candidateCount).toBe(0);
    expect(exhausted.continuation).toEqual({ advanced: false, hasMore: false });
  });

  it("drains at least three internal batches in one CLI executor invocation", async () => {
    const workspaceDir = await createIsolatedWorkspace("cli-drain-");
    await seedCanonicalTranscript(
      "cli-drain",
      ["2026-01-01", "2026-01-02", "2026-01-03"].map((day) => ({
        role: "user" as const,
        content: `CLI drain note for ${day}`,
        timestamp: `${day}T12:00:00.000Z`,
        owner: true,
      })),
    );

    const applied = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      apply: true,
      limitDays: 1,
      timezone: "UTC",
    });
    const preview = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      limitDays: 1,
      timezone: "UTC",
    });

    expect(applied.batchCount).toBe(3);
    expect(applied.batches?.map((batch) => batch.candidates)).toEqual([1, 1, 1]);
    expect(applied.candidateCount).toBe(3);
    expect(preview.candidateCount).toBe(0);
  });

  it("does not advance the cursor past messages excluded by a date range", async () => {
    const workspaceDir = await createIsolatedWorkspace("range-cursor-");
    await seedCanonicalTranscript("range-cursor", [
      {
        role: "user",
        content: "January durable note",
        timestamp: "2026-01-15T12:00:00.000Z",
        owner: true,
      },
      {
        role: "user",
        content: "February durable note",
        timestamp: "2026-02-15T12:00:00.000Z",
        owner: true,
      },
    ]);

    const january = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      apply: true,
      to: "2026-01-31",
      timezone: "UTC",
    });
    const february = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      apply: true,
      from: "2026-02-01",
      timezone: "UTC",
    });

    expect(january.days.map((day) => day.day)).toEqual(["2026-01-15"]);
    expect(february.days.map((day) => day.day)).toEqual(["2026-02-15"]);
  });

  it("advances the source cursor beyond the per-file signal cap", async () => {
    const workspaceDir = await createIsolatedWorkspace("cursor-");
    await seedCanonicalTranscript(
      "cursor",
      Array.from({ length: 100 }, (_, index) => ({
        role: "user" as const,
        content: `Durable cursor note ${index}`,
        timestamp: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 60_000).toISOString(),
        owner: true,
      })),
    );

    const run = () =>
      runSessionBackfill({
        agentId: "main",
        workspaceDir,
        apply: true,
        nowMs: Date.parse("2026-01-02T12:00:00.000Z"),
        timezone: "UTC",
      });

    const drained = await run();
    expect(drained.candidateCount).toBe(100);
    expect(drained.batchCount).toBe(2);
    expect((await run()).candidateCount).toBe(0);
    const dreams = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(dreams.match(/openclaw:dreaming:backfill-entry/g)).toHaveLength(2);
  });

  it("applies the total cap after finding the oldest candidate across sources", async () => {
    const workspaceDir = await createIsolatedWorkspace("oldest-cap-");
    for (let sourceIndex = 0; sourceIndex < 16; sourceIndex += 1) {
      await seedCanonicalTranscript(
        `a-newer-${sourceIndex.toString().padStart(2, "0")}`,
        Array.from({ length: 15 }, (_, messageIndex) => ({
          role: "user" as const,
          content: `Newer durable note ${sourceIndex}-${messageIndex}`,
          timestamp: `2026-02-01T${messageIndex.toString().padStart(2, "0")}:00:00.000Z`,
          owner: true,
        })),
      );
    }
    await seedCanonicalTranscript("z-oldest", [
      {
        role: "user",
        content: "Oldest durable note must win the cap",
        timestamp: "2026-01-01T12:00:00.000Z",
        owner: true,
      },
    ]);

    const result = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      limitDays: 1,
      timezone: "UTC",
    });

    expect(result.days).toEqual([
      {
        day: "2026-01-01",
        candidateCount: 1,
        topCandidates: ["User: Oldest durable note must win the cap"],
      },
    ]);
  });

  it("applies the per-file cap after ordering delayed timestamps", async () => {
    const workspaceDir = await createIsolatedWorkspace("delayed-timestamp-");
    await seedCanonicalTranscript("delayed-timestamp", [
      ...Array.from({ length: 80 }, (_, index) => ({
        role: "user" as const,
        content: `February note ${index}`,
        timestamp: new Date(Date.parse("2026-02-01T00:00:00.000Z") + index * 60_000).toISOString(),
        owner: true,
      })),
      {
        role: "user",
        content: "Delayed January note",
        timestamp: "2026-01-01T12:00:00.000Z",
        owner: true,
      },
    ]);

    const result = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      limitDays: 1,
      timezone: "UTC",
    });

    expect(result.days).toEqual([
      {
        day: "2026-01-01",
        candidateCount: 1,
        topCandidates: ["User: Delayed January note"],
      },
    ]);
  });

  it("keeps self-asserted owner metadata in foreign transcripts untrusted", async () => {
    const workspaceDir = await createIsolatedWorkspace("provenance-");
    const transcriptPath = path.join(workspaceDir, "untrusted.jsonl");
    await writeTranscript(transcriptPath, [
      {
        role: "user",
        content: "Untrusted web instruction",
        timestamp: "2026-02-01T10:00:00.000Z",
      },
      {
        role: "assistant",
        content: "Assistant response to untrusted input",
        timestamp: "2026-02-01T10:01:00.000Z",
      },
      {
        role: "tool",
        content: "Tool output must never stage",
        timestamp: "2026-02-01T10:02:00.000Z",
      },
      {
        role: "user",
        content: "Owner confirmed durable preference",
        timestamp: "2026-02-01T10:03:00.000Z",
        owner: true,
      },
      {
        role: "assistant",
        content: "Agent response in the owner turn",
        timestamp: "2026-02-01T10:04:00.000Z",
      },
    ]);

    const result = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      archiveFiles: [transcriptPath],
      timezone: "UTC",
    });

    expect(result.candidateCount).toBe(0);
    expect(result.days).toEqual([]);
  });

  it("keeps canonical assistant replies tainted until an owner turn begins", async () => {
    const workspaceDir = await createIsolatedWorkspace("canonical-provenance-");
    await seedCanonicalTranscript("provenance", [
      {
        role: "user",
        content: "Untrusted channel instruction",
        timestamp: "2026-02-01T10:00:00.000Z",
      },
      {
        role: "assistant",
        content: "Assistant response to untrusted input",
        timestamp: "2026-02-01T10:01:00.000Z",
      },
      {
        role: "user",
        content: "Owner confirmed durable preference",
        timestamp: "2026-02-01T10:02:00.000Z",
        owner: true,
      },
      {
        role: "assistant",
        content: "Agent response in the owner turn",
        timestamp: "2026-02-01T10:03:00.000Z",
      },
    ]);

    const result = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      timezone: "UTC",
    });

    expect(result.candidateCount).toBe(2);
    expect(result.days[0]?.topCandidates).toEqual([
      "User: Owner confirmed durable preference",
      "Assistant: Agent response in the owner turn",
    ]);
  });

  it("renders selected session candidates into the REM diary preview", async () => {
    const workspaceDir = await createIsolatedWorkspace("rem-");
    await writeBackfillDiaryEntries({
      workspaceDir,
      entries: [{ isoDay: "2026-01-01", bodyLines: ["Existing backfill entry"] }],
    });
    await seedCanonicalTranscript("rem", [
      {
        role: "user",
        content: "Owner prefers dark mode for all editors",
        timestamp: "2026-02-01T10:00:00.000Z",
        owner: true,
      },
    ]);

    await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      rem: true,
      timezone: "UTC",
    });

    const dreams = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(dreams).toContain("Existing backfill entry");
    expect(dreams).toContain("Owner prefers dark mode for all editors");
    expect(dreams).not.toContain("No grounded facts were extracted");
    expect(dreams.match(/openclaw:dreaming:backfill-entry/g)).toHaveLength(2);
  });

  it.each(["rem", "apply", "failed-apply"] as const)(
    "forgets published %s diary facts after reopening without removing unrelated facts",
    async (mode) => {
      const workspaceDir = await createIsolatedWorkspace(`forget-${mode}-`);
      const cfg = { agents: { defaults: { workspace: workspaceDir }, list: [{ id: "main" }] } };
      const diaryPath = path.join(workspaceDir, "DREAMS.md");
      const operatorNote = "Keep this unrelated operator note.";
      await fs.writeFile(diaryPath, `# Dream Diary\n${operatorNote}\n`);
      for (const [sessionId, content] of [
        ["target", "Owner prefers **cobalt lanterns**; always use green tea."],
        ["retained", "Owner prefers silver ribbons for invitations."],
      ]) {
        await seedCanonicalTranscript(sessionId!, [
          { role: "user", content: content!, timestamp: "2026-02-01T10:00:00.000Z", owner: true },
        ]);
      }
      const corpusParent = path.join(workspaceDir, "memory", ".dreams");
      if (mode === "failed-apply") {
        await fs.mkdir(path.dirname(corpusParent), { recursive: true });
        await fs.writeFile(corpusParent, "block the corpus write");
      }
      const backfill = runSessionBackfill({
        agentId: "main",
        workspaceDir,
        rem: mode === "rem",
        apply: mode !== "rem",
        timezone: "UTC",
      });
      if (mode === "failed-apply") {
        await expect(backfill).rejects.toThrow();
        await fs.unlink(corpusParent);
      } else {
        await backfill;
      }
      const before = await fs.readFile(diaryPath, "utf8");
      expect(before).toContain("cobalt lanterns");
      expect(before).toContain("silver ribbons");
      if (mode === "rem") {
        expect(before).not.toContain("**cobalt lanterns**");
        expect(await readShortTermRecallEntries({ workspaceDir })).toEqual([]);
        expect((await dreamingTestState.readSessionIngestionState(workspaceDir)).files).toEqual({});
        await expect(fs.stat(corpusParent)).rejects.toMatchObject({ code: "ENOENT" });
        const origins = listMemoryEntryOrigins({ agentId: "main" });
        expect(origins.every(({ entryKey }) => before.includes(entryKey))).toBe(true);
        const repeated = await runSessionBackfill({
          agentId: "main",
          workspaceDir,
          rem: true,
          timezone: "UTC",
        });
        expect(repeated.writtenDiaryEntries).toBe(0);
        expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual(origins);
      }
      closeOpenClawAgentDatabasesForTest();
      const preview = await forgetMemoryEntries({
        cfg,
        agentId: "main",
        sessionIds: ["target"],
        dryRun: true,
      });
      expect(await fs.readFile(diaryPath, "utf8")).toBe(before);
      const report = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"] });
      expect(report.artifacts).toEqual(preview.artifacts);
      const after = await fs.readFile(diaryPath, "utf8");
      expect.soft(after).not.toContain("cobalt lanterns");
      expect.soft(after).not.toContain("green tea");
      expect(after).toContain("silver ribbons");
      expect(after).toContain(operatorNote);
      expect(report.refusals).toEqual([]);
      const repeated = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"] });
      expect(Object.values(repeated.artifacts).every((count) => count === 0)).toBe(true);
    },
  );

  it("retains both origins when diary publication deduplicates identical apply blocks", async () => {
    const workspaceDir = await createIsolatedWorkspace("diary-dedupe-");
    const cfg = { agents: { defaults: { workspace: workspaceDir }, list: [{ id: "main" }] } };
    for (const sessionId of ["first", "second"]) {
      await seedCanonicalTranscript(sessionId, [
        {
          role: "user",
          content: "Owner prefers cobalt lanterns.",
          timestamp: "2026-02-01T10:00:00.000Z",
          owner: true,
        },
      ]);
      const applied = await runSessionBackfill({
        agentId: "main",
        workspaceDir,
        apply: true,
        timezone: "UTC",
      });
      expect(applied.writtenDiaryEntries).toBe(sessionId === "first" ? 1 : 0);
    }
    const diaryPath = path.join(workspaceDir, "DREAMS.md");
    expect(await fs.readFile(diaryPath, "utf8")).toContain("cobalt lanterns");
    const report = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["second"] });
    expect(report.mixedLineageEntryKeys.length).toBeGreaterThan(0);
    expect(await fs.readFile(diaryPath, "utf8")).not.toContain("cobalt lanterns");
  });

  it("keeps all origins of a coalesced REM claim while preserving independent facts", async () => {
    const workspaceDir = await createIsolatedWorkspace("rem-coalesced-");
    const cfg = { agents: { defaults: { workspace: workspaceDir }, list: [{ id: "main" }] } };
    for (const [sessionId, item] of [
      ["first", "cobalt lanterns"],
      ["second", "silver ribbons"],
    ] as const) {
      await seedCanonicalTranscript(sessionId, [
        {
          role: "user",
          content: `Owner prefers ${item}; always use green tea.`,
          timestamp: "2026-02-01T10:00:00.000Z",
          owner: true,
        },
      ]);
    }
    await runSessionBackfill({ agentId: "main", workspaceDir, rem: true, timezone: "UTC" });
    const diaryPath = path.join(workspaceDir, "DREAMS.md");
    const before = await fs.readFile(diaryPath, "utf8");
    expect(before).toContain("- [likely_durable] always use green tea.");
    const report = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["second"] });
    const after = await fs.readFile(diaryPath, "utf8");
    expect(report.mixedLineageEntryKeys.length).toBeGreaterThan(0);
    expect(after).toContain("cobalt lanterns");
    expect(after).not.toContain("silver ribbons");
    expect(after).not.toContain("- [likely_durable] always use green tea.");
  });

  it("does not publish a diary when reserving its origins fails", async () => {
    const workspaceDir = await createIsolatedWorkspace("diary-origin-failure-");
    await seedCanonicalTranscript("target", [
      {
        role: "user",
        content: "Owner prefers cobalt lanterns.",
        timestamp: "2026-02-01T10:00:00.000Z",
        owner: true,
      },
    ]);
    const diaryPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(diaryPath, "Keep this operator note.\n");
    openOpenClawAgentDatabase({ agentId: "main" }).db.exec(`
      CREATE TRIGGER reject_diary_origin BEFORE INSERT ON memory_entry_origins
      BEGIN SELECT RAISE(ABORT, 'injected diary origin failure'); END;
    `);
    await expect(
      runSessionBackfill({ agentId: "main", workspaceDir, rem: true, timezone: "UTC" }),
    ).rejects.toThrow("injected diary origin failure");
    expect(await fs.readFile(diaryPath, "utf8")).toBe("Keep this operator note.\n");
  });

  it("stages idempotently, converges duplicate facts, and rolls back staged artifacts", async () => {
    const workspaceDir = await createIsolatedWorkspace("apply-");
    await seedCanonicalTranscript("repeat", [
      {
        role: "user",
        content: "The preferred editor is Nova",
        timestamp: "2026-03-01T10:00:00.000Z",
        owner: true,
      },
      {
        role: "user",
        content: "The preferred editor is Nova",
        timestamp: "2026-03-01T11:00:00.000Z",
        owner: true,
      },
    ]);

    const first = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      apply: true,
      nowMs: Date.parse("2026-03-02T12:00:00.000Z"),
      timezone: "UTC",
    });
    const afterFirst = await readShortTermRecallEntries({ workspaceDir });
    const firstContentHash = hashStagedContent(afterFirst);

    // Count-level proof stays stable across the sibling claim-key implementation.
    expect(first.stagedEntries).toBe(1);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.snippet).toBe("The preferred editor is Nova");

    const second = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      apply: true,
      nowMs: Date.parse("2026-03-02T12:00:00.000Z"),
      timezone: "UTC",
    });
    expect(second.candidateCount).toBe(0);
    expect(second.stagedEntries).toBe(0);
    expect(await readShortTermRecallEntries({ workspaceDir })).toHaveLength(1);

    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    expect(await fs.readFile(dreamsPath, "utf-8")).toContain("openclaw:dreaming:backfill-entry");

    const rollback = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      rollback: true,
    });
    expect(rollback.rollback).toEqual({
      removedDiaryEntries: 1,
      removedStagedEntries: 1,
    });
    expect(await readShortTermRecallEntries({ workspaceDir })).toHaveLength(0);
    expect(await fs.readFile(dreamsPath, "utf-8")).not.toContain(
      "openclaw:dreaming:backfill-entry",
    );
    const reapplied = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      apply: true,
      nowMs: Date.parse("2026-03-02T12:00:00.000Z"),
      timezone: "UTC",
    });
    const afterReapply = await readShortTermRecallEntries({ workspaceDir });
    expect(reapplied.candidateCount).toBe(2);
    expect(hashStagedContent(afterReapply)).toBe(firstContentHash);
  });

  it("resets agent ingestion state when legacy staged entries have no rewind journal", async () => {
    const workspaceDir = await createIsolatedWorkspace("legacy-rollback-");
    await seedCanonicalTranscript("legacy", [
      {
        role: "user",
        content: "The preferred terminal is Ghostty",
        timestamp: "2026-04-01T10:00:00.000Z",
        owner: true,
      },
    ]);
    const applyParams = {
      agentId: "main",
      workspaceDir,
      apply: true,
      nowMs: Date.parse("2026-04-02T12:00:00.000Z"),
      timezone: "UTC",
    } as const;

    await runSessionBackfill(applyParams);
    const firstContentHash = hashStagedContent(await readShortTermRecallEntries({ workspaceDir }));
    await clearMemoryCoreWorkspaceNamespace({
      namespace: SESSION_BACKFILL_REWIND_NAMESPACE,
      workspaceDir,
    });

    const rollback = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      rollback: true,
    });
    const preview = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      timezone: "UTC",
    });
    const reapplied = await runSessionBackfill(applyParams);
    const afterReapply = await readShortTermRecallEntries({ workspaceDir });

    expect(rollback.rollback).toEqual({
      removedDiaryEntries: 1,
      removedStagedEntries: 1,
    });
    expect(preview.candidateCount).toBe(1);
    expect(reapplied.candidateCount).toBe(1);
    expect(hashStagedContent(afterReapply)).toBe(firstContentHash);

    const stateAfterReapply = await dreamingTestState.readSessionIngestionState(workspaceDir);
    const scope = Object.keys(stateAfterReapply.seenMessages)[0];
    if (!scope) {
      throw new Error("Expected re-applied session ingestion scope");
    }
    await writeSessionIngestionState(workspaceDir, {
      ...stateAfterReapply,
      seenMessages: {
        ...stateAfterReapply.seenMessages,
        [scope]: [...(stateAfterReapply.seenMessages[scope] ?? []), "later-live"],
      },
    });
    await runSessionBackfill({ agentId: "main", workspaceDir, rollback: true });
    expect(
      (await dreamingTestState.readSessionIngestionState(workspaceDir)).seenMessages[scope],
    ).toEqual(["later-live"]);
  });

  it("resets mixed legacy state when later journal rows do not prove complete coverage", async () => {
    const workspaceDir = await createIsolatedWorkspace("mixed-legacy-rollback-");
    const applyParams = {
      agentId: "main",
      workspaceDir,
      apply: true,
      nowMs: Date.parse("2026-05-03T12:00:00.000Z"),
      timezone: "UTC",
    } as const;
    await seedCanonicalTranscript("legacy-mixed", [
      {
        role: "user",
        content: "The preferred shell is zsh",
        timestamp: "2026-05-01T10:00:00.000Z",
        owner: true,
      },
    ]);
    await runSessionBackfill(applyParams);
    await clearMemoryCoreWorkspaceNamespace({
      namespace: SESSION_BACKFILL_REWIND_NAMESPACE,
      workspaceDir,
    });
    await seedCanonicalTranscript("journaled-mixed", [
      {
        role: "user",
        content: "The preferred pager is less",
        timestamp: "2026-05-02T10:00:00.000Z",
        owner: true,
      },
    ]);
    await runSessionBackfill(applyParams);
    const firstContentHash = hashStagedContent(await readShortTermRecallEntries({ workspaceDir }));

    await runSessionBackfill({ agentId: "main", workspaceDir, rollback: true });
    const preview = await runSessionBackfill({ agentId: "main", workspaceDir, timezone: "UTC" });
    const reapplied = await runSessionBackfill(applyParams);

    expect(preview.candidateCount).toBe(2);
    expect(reapplied.candidateCount).toBe(2);
    expect(hashStagedContent(await readShortTermRecallEntries({ workspaceDir }))).toBe(
      firstContentHash,
    );
  });

  it("keeps other agents' archived scopes when resetting an agent named archive", async () => {
    const workspaceDir = await createIsolatedWorkspace("archive-agent-reset-");
    const fileState = {
      mtimeMs: 1,
      size: 1,
      contentHash: "hash",
      lineCount: 1,
      lastContentLine: 1,
    };
    await writeSessionIngestionState(workspaceDir, {
      version: 3,
      files: {
        "archive:sessions/archive/own": fileState,
        "main:sessions/main/other": fileState,
      },
      seenMessages: {
        "archive:sessions/archive/own": ["own-live"],
        "archive:archive:/tmp/own.jsonl": ["own-archive"],
        "archive:main:/tmp/other.jsonl": ["other-archive"],
        "main:sessions/main/other": ["other-live"],
      },
    });

    await resetSessionBackfillIngestionState({ workspaceDir, agentId: "archive" });

    expect(await dreamingTestState.readSessionIngestionState(workspaceDir)).toEqual({
      version: 3,
      files: { "main:sessions/main/other": fileState },
      seenMessages: {
        "archive:main:/tmp/other.jsonl": ["other-archive"],
        "main:sessions/main/other": ["other-live"],
      },
    });
  });

  it("does not share a clean rewind baseline across agents", async () => {
    const workspaceDir = await createIsolatedWorkspace("agent-baseline-");
    await markSessionBackfillRewindBaseline({ workspaceDir, agentId: "main" });

    expect(await rewindSessionBackfillIngestionState({ workspaceDir, agentId: "other" })).toEqual({
      completeCoverage: false,
      rewoundCandidates: 0,
    });
    expect(await rewindSessionBackfillIngestionState({ workspaceDir, agentId: "main" })).toEqual({
      completeCoverage: true,
      rewoundCandidates: 0,
    });
  });
});
