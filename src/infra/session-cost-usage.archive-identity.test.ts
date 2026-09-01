import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  encodeSessionArchiveContent,
  readSessionArchiveContentSync,
} from "../config/sessions/archive-compression.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { AssistantMessage } from "../llm/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  readUsageCostRollups,
  refreshCostUsageCacheForAgent,
  resolveUsageCostPricingFingerprint,
} from "./session-cost-usage-aggregation.js";
import { readSessionCostUsageRollupRows } from "./session-cost-usage-cache.sqlite.js";
import {
  listUsageCountedTranscriptStats,
  resolveUsageCostTranscriptFile,
} from "./session-cost-usage-collection.js";
import {
  discoverAllSessions,
  loadCostUsageSummary,
  loadCostUsageSummaryFromCache,
  loadSessionCostSummariesFromCache,
  loadSessionCostSummary,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
} from "./session-cost-usage.js";

const archiveTime = Date.UTC(2026, 7, 26, 12);
const archiveStamp = "2026-08-26T12-00-00.000Z";
const generation = "0123456789abcdef0123456789abcdef";
const config = { plugins: { enabled: false } };
const encodings = ["plain", "zstd"] as const;
type Encoding = (typeof encodings)[number];

function assistant(tokens: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: `answer with ${tokens} tokens` }],
    api: "openai-responses",
    provider: "fixture",
    model: "usage-fixture",
    stopReason: "stop",
    timestamp: archiveTime,
    usage: {
      input: tokens - 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: {
        input: (tokens - 1) / 1000,
        output: 0.001,
        cacheRead: 0,
        cacheWrite: 0,
        total: tokens / 1000,
      },
    },
  };
}

function transcript(tokens = 17): SessionManager {
  const manager = SessionManager.inMemory();
  manager.appendMessage({
    role: "user",
    content: "retained archive prompt",
    timestamp: archiveTime,
  });
  manager.appendMessage(assistant(tokens));
  return manager;
}

function serialize(manager: SessionManager): string {
  return (
    [manager.getHeader(), ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n"
  );
}

async function writeArchive(params: {
  state: OpenClawTestState;
  manager: SessionManager;
  encoding: Encoding;
  reason?: "reset" | "deleted";
  agentId?: string;
  mtime?: number;
  generated?: boolean;
}): Promise<string> {
  const content = serialize(params.manager);
  const encoded =
    params.encoding === "zstd"
      ? encodeSessionArchiveContent(content)
      : { bytes: Buffer.from(content), suffix: "" };
  expect(encoded.suffix).toBe(params.encoding === "zstd" ? ".zst" : "");
  const directory = params.state.sessionsDir(params.agentId);
  await fs.mkdir(directory, { recursive: true });
  const fileName = `${params.manager.getSessionId()}.jsonl.${params.reason ?? "reset"}.${archiveStamp}${params.generated ? `.${generation}` : ""}${encoded.suffix}`;
  const filePath = path.join(directory, fileName);
  await fs.writeFile(filePath, encoded.bytes);
  const mtime = new Date(params.mtime ?? archiveTime);
  await fs.utimes(filePath, mtime, mtime);
  expect(readSessionArchiveContentSync(filePath)).toBe(content);
  return filePath;
}

async function cachedTotal(agentId: string) {
  return await loadCostUsageSummaryFromCache({
    agentId,
    config,
    startMs: 0,
    endMs: Date.now() + 86_400_000,
    requestRefresh: false,
  });
}

describe("usage archive identity", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "usage-archive-identity" });
    await state.writeConfig(config);
  });

  afterEach(async () => {
    await state.cleanup();
  });

  for (const encoding of encodings) {
    for (const reason of ["reset", "deleted"] as const) {
      it.each(["main", "worker"])(
        `discovers and reads ${encoding} ${reason} archives for %s`,
        async (agentId) => {
          const manager = transcript();
          const sessionId = manager.getSessionId();
          const sessionFile = await writeArchive({
            state,
            manager,
            encoding,
            reason,
            agentId,
            generated: true,
          });
          const sourceStats = await fs.stat(sessionFile);
          const sessions = await discoverAllSessions({ agentId });
          expect(sessions).toEqual([
            {
              sessionId,
              sessionFile,
              mtime: sourceStats.mtimeMs,
              firstUserMessage: "retained archive prompt",
            },
          ]);

          const listed = await listUsageCountedTranscriptStats(agentId);
          const resolved = expectDefined(
            await resolveUsageCostTranscriptFile(sessionFile),
            "resolved archive",
          );
          expect(listed).toHaveLength(1);
          expect(resolved).toEqual(listed[0]);
          expect(resolved).toMatchObject({
            size: Buffer.byteLength(serialize(manager)),
            mtimeMs: sourceStats.mtimeMs,
          });
          expect(await fs.readFile(resolved.filePath, "utf8")).toBe(serialize(manager));
          expect(resolved.filePath === sessionFile).toBe(encoding === "plain");

          const cacheLookup = { agentId, config, sessions: [{ sessionId, sessionFile }] };
          expect(readSessionCostUsageRollupRows(agentId)).toEqual([]);
          expect(await loadSessionCostSummariesFromCache(cacheLookup)).toMatchObject({
            summaries: [null],
            cacheStatus: { status: "refreshing", cachedFiles: 0, pendingFiles: 1 },
          });
          await expect.poll(() => readSessionCostUsageRollupRows(agentId)).toHaveLength(1);
          expect(
            await loadSessionCostSummariesFromCache({ ...cacheLookup, requestRefresh: false }),
          ).toMatchObject({
            summaries: [{ sessionId, sessionFile, totalTokens: 17 }],
            cacheStatus: { status: "fresh", cachedFiles: 1, pendingFiles: 0 },
          });

          const lookup = {
            agentId,
            sessionId: expectDefined(sessions[0], "discovered archive").sessionId,
            config,
          };
          const summary = await loadSessionCostSummary(lookup);
          expect(summary).toMatchObject({ sessionFile, totalTokens: 17 });
          expect(await loadSessionLogs(lookup)).toEqual([
            expect.objectContaining({ role: "user", content: "retained archive prompt" }),
            expect.objectContaining({ role: "assistant", tokens: 17 }),
          ]);
          expect(await loadSessionUsageTimeSeries(lookup)).toMatchObject({
            sessionId,
            points: [expect.objectContaining({ totalTokens: 17, cumulativeTokens: 17 })],
          });
          const firstRows = readSessionCostUsageRollupRows(agentId);
          expect(firstRows.map((row) => row.key)).toEqual([resolved.filePath]);
          expect(await loadSessionCostSummary(lookup)).toEqual(summary);
          expect(readSessionCostUsageRollupRows(agentId)).toEqual(firstRows);
          expect(await cachedTotal(agentId)).toMatchObject({
            totals: { totalTokens: 17 },
            cacheStatus: { status: "fresh" },
          });
        },
      );
    }

    it(`excludes a ${encoding} archive copy of SQLite only in its owning agent`, async () => {
      const manager = transcript(100);
      const sessionId = manager.getSessionId();
      const sessionKey = "agent:main:main";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      await upsertSessionEntryCore(
        { sessionKey, storePath },
        { sessionId, updatedAt: archiveTime },
      );
      await persistSessionTranscriptTurn(
        { agentId: "main", sessionId, sessionKey, storePath },
        { messages: [{ message: assistant(17) }], touchSessionEntry: false },
      );
      await writeArchive({ state, manager, encoding });
      const workerArchive = await writeArchive({ state, manager, encoding, agentId: "worker" });

      const sessions = await discoverAllSessions({ agentId: "main" });
      expect.soft(sessions).toHaveLength(1);
      expect.soft(sessions[0]).toMatchObject({
        sessionId,
        sessionFile: expect.stringContaining(`sqlite:main:${sessionId}:`),
      });
      expect(
        await loadCostUsageSummary({
          agentId: "main",
          config,
          startMs: 0,
          endMs: Date.now() + 86_400_000,
        }),
      ).toMatchObject({ totals: { totalTokens: 17 } });
      expect(await discoverAllSessions({ agentId: "worker" })).toEqual([
        expect.objectContaining({ sessionId, sessionFile: workerArchive }),
      ]);
      expect(
        await loadCostUsageSummary({
          agentId: "worker",
          config,
          startMs: 0,
          endMs: Date.now() + 86_400_000,
        }),
      ).toMatchObject({ totals: { totalTokens: 100 } });
    });

    it(`keeps newest-archive and primary precedence with ${encoding} archives`, async () => {
      const manager = transcript();
      const sessionId = manager.getSessionId();
      await writeArchive({ state, manager, encoding, reason: "reset" });
      const newestArchive = await writeArchive({
        state,
        manager,
        encoding,
        reason: "deleted",
        mtime: archiveTime + 1000,
      });
      expect(await discoverAllSessions({ agentId: "main" })).toEqual([
        expect.objectContaining({ sessionId, sessionFile: newestArchive }),
      ]);
      const primary = path.join(state.sessionsDir(), `${sessionId}.jsonl`);
      await fs.writeFile(primary, serialize(manager));
      await fs.utimes(primary, new Date(archiveTime - 1000), new Date(archiveTime - 1000));
      expect(await discoverAllSessions({ agentId: "main" })).toEqual([
        expect.objectContaining({ sessionId, sessionFile: primary }),
      ]);
    });
  }

  it("replaces compressed read bytes without changing the durable session identity", async () => {
    const manager = transcript();
    const sessionId = manager.getSessionId();
    const sessionFile = await writeArchive({ state, manager, encoding: "zstd" });
    const lookup = { agentId: "main", sessionId, sessionFile, config };
    expect(await loadSessionCostSummary(lookup)).toMatchObject({ totalTokens: 17 });
    const original = expectDefined(
      await resolveUsageCostTranscriptFile(sessionFile),
      "original archive",
    );
    const originalRows = readSessionCostUsageRollupRows("main");
    expect(originalRows.map((row) => row.key)).toEqual([original.filePath]);

    manager.appendMessage(assistant(29));
    expect(
      await writeArchive({ state, manager, encoding: "zstd", mtime: archiveTime + 2000 }),
    ).toBe(sessionFile);
    const replacement = expectDefined(
      await resolveUsageCostTranscriptFile(sessionFile),
      "replacement archive",
    );
    expect(replacement.filePath).not.toBe(original.filePath);
    expect(await discoverAllSessions({ agentId: "main" })).toEqual([
      expect.objectContaining({ sessionId, sessionFile, mtime: archiveTime + 2000 }),
    ]);
    expect(await refreshCostUsageCacheForAgent({ agentId: "main", config })).toBe("refreshed");
    expect(await loadSessionCostSummary(lookup)).toMatchObject({ sessionFile, totalTokens: 46 });
    expect(await cachedTotal("main")).toMatchObject({
      totals: { totalTokens: 46 },
      cacheStatus: { status: "fresh" },
    });
    const rows = readSessionCostUsageRollupRows("main");
    expect(rows.map((row) => row.key)).toEqual([replacement.filePath]);
    const fingerprint = resolveUsageCostPricingFingerprint(config, state.agentDir());
    const rollups = readUsageCostRollups("main", fingerprint);
    expect(rollups.get(replacement.filePath)?.entry.checkpoint).toMatchObject({
      kind: "jsonl",
      parsedOffset: Buffer.byteLength(serialize(manager)),
      observedSize: Buffer.byteLength(serialize(manager)),
      observedMtimeMs: archiveTime + 2000,
    });
    expect(await loadSessionUsageTimeSeries(lookup)).toMatchObject({
      points: [
        expect.objectContaining({ totalTokens: 17 }),
        expect.objectContaining({ totalTokens: 29, cumulativeTokens: 46 }),
      ],
    });
    expect(await loadSessionLogs(lookup)).toHaveLength(3);
    expect(await loadSessionCostSummary(lookup)).toMatchObject({ totalTokens: 46 });
    expect(readSessionCostUsageRollupRows("main")).toEqual(rows);
  });

  it("preserves rollups when a compressed source becomes unreadable", async () => {
    const manager = transcript();
    const sessionFile = await writeArchive({ state, manager, encoding: "zstd" });
    await loadSessionCostSummary({ agentId: "main", sessionFile, config });
    const rows = readSessionCostUsageRollupRows("main");
    expect(rows).toHaveLength(1);
    await fs.writeFile(sessionFile, "not a zstd frame");

    await expect(resolveUsageCostTranscriptFile(sessionFile)).resolves.toBeUndefined();
    await expect(discoverAllSessions({ agentId: "main" })).rejects.toThrow();
    await expect(refreshCostUsageCacheForAgent({ agentId: "main", config })).rejects.toThrow();
    expect(readSessionCostUsageRollupRows("main")).toEqual(rows);
  });
});
