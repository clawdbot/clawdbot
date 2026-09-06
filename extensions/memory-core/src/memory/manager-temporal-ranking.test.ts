import fs from "node:fs/promises";
import path from "node:path";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { deleteSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { describe, expect, it } from "vitest";
import { createMemorySearchTool } from "../tools.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const DAY_MS = 24 * 60 * 60 * 1_000;

describe("memory source temporal ranking", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it.each([
    {
      name: "keyword-only",
      provider: "none",
      lexicalOnly: false,
      archived: false,
      ftsUnavailable: false,
      zeroScoreLike: false,
    },
    {
      name: "lexical recall",
      provider: "openai",
      lexicalOnly: true,
      archived: false,
      ftsUnavailable: false,
      zeroScoreLike: false,
    },
    {
      name: "hybrid",
      provider: "openai",
      lexicalOnly: false,
      archived: false,
      ftsUnavailable: false,
      zeroScoreLike: false,
    },
    {
      name: "retained archives",
      provider: "none",
      lexicalOnly: false,
      archived: true,
      ftsUnavailable: false,
      zeroScoreLike: false,
    },
    {
      name: "FTS unavailable",
      provider: "openai",
      lexicalOnly: false,
      archived: false,
      ftsUnavailable: true,
      zeroScoreLike: false,
    },
    {
      name: "LIKE-only hybrid",
      provider: "openai",
      lexicalOnly: false,
      archived: false,
      ftsUnavailable: false,
      zeroScoreLike: true,
    },
  ])(
    "decays SQLite session hits by recorded source activity through $name",
    async ({ provider, lexicalOnly, archived, ftsUnavailable, zeroScoreLike }) => {
      fixture.provider.forceNoProvider = provider === "none";
      const cfg = fixture.createConfig({
        provider,
        sources: ["sessions"],
        sessionMemory: true,
        minScore: 0,
        vectorEnabled: false,
        ftsTokenizer: zeroScoreLike ? "trigram" : "unicode61",
      });
      const now = Date.now();
      const oldSession = {
        sessionId: "a-old",
        updatedAt: now - 15 * DAY_MS,
        fileName: "a-old.jsonl",
      };
      const freshSession = { sessionId: "z-fresh", updatedAt: now, fileName: "z-fresh.jsonl" };
      const sessions = [oldSession, freshSession];
      const storePath = path.join(resolveSessionTranscriptsDirForAgent("main"), "sessions.json");
      for (const session of sessions) {
        const sessionKey = `agent:main:memory:${session.sessionId}`;
        await fixture.seedSessionTranscript({
          sessionId: session.sessionId,
          sessionKey,
          messages: [
            {
              role: "user",
              content: zeroScoreLike
                ? "记忆 彩色 潮池 偏好。"
                : "Alpha cobalt orchid tidepool preference.",
              timestamp: now - 60 * DAY_MS,
            },
          ],
        });
        await upsertSessionEntry({
          agentId: "main",
          sessionKey,
          storePath,
          entry: { sessionId: session.sessionId, updatedAt: session.updatedAt },
        });
        if (archived) {
          await deleteSessionEntry({
            agentId: "main",
            sessionKey,
            storePath,
            archiveTranscript: true,
          });
          const files = await fs.readdir(path.dirname(storePath));
          const archiveName = files.find((name) =>
            name.startsWith(`${session.sessionId}.jsonl.deleted.`),
          );
          if (!archiveName) {
            throw new Error("Expected retained session archive");
          }
          const archivePath = path.join(path.dirname(storePath), archiveName);
          const activity = new Date(session.updatedAt);
          await fs.utimes(archivePath, activity, activity);
          session.fileName = archiveName;
          session.updatedAt = (await fs.stat(archivePath)).mtimeMs;
        }
      }
      let manager = await fixture.getFreshManager(cfg);
      await manager.sync({ reason: "test", force: true });
      const sourceRows = openOpenClawAgentDatabase({ agentId: "main" })
        .db.prepare(
          "SELECT path, mtime FROM memory_index_sources WHERE source = 'sessions' ORDER BY path",
        )
        .all();
      expect(sourceRows).toEqual(
        sessions.map((session) => ({
          path: `sessions/main/${session.fileName}`,
          mtime: session.updatedAt,
        })),
      );
      await expect(fs.stat(path.join(fixture.paths.workspace, "sessions"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (ftsUnavailable) {
        await manager.close();
        openOpenClawAgentDatabase({ agentId: "main" }).db.exec(`
          DROP TABLE memory_index_chunks_fts;
          CREATE VIEW memory_index_chunks_fts AS
            SELECT text, id, path, source, model, start_line, end_line FROM memory_index_chunks;
        `);
        manager = await fixture.getFreshManager(cfg, "cli");
        expect(manager.status().fts).toMatchObject({ enabled: true, available: false });
      }

      const searchOptions = {
        maxResults: 2,
        minScore: 0,
        lexicalOnly,
      };
      const query = zeroScoreLike ? "记忆" : "alpha cobalt orchid tidepool preference";
      const search = () => manager.search(query, { ...searchOptions, sources: ["sessions"] });
      const expectSourceRecency = (results: MemorySearchResult[]) => {
        const old = results.find((entry) => entry.path === `sessions/main/${oldSession.fileName}`);
        const fresh = results.find(
          (entry) => entry.path === `sessions/main/${freshSession.fileName}`,
        );
        expect(old).toBeDefined();
        expect(fresh).toBeDefined();
        if (!old || !fresh) {
          throw new Error("Expected both indexed session sources");
        }
        if (zeroScoreLike) {
          expect(results).toEqual([
            expect.objectContaining({ score: 0, vectorScore: 0, textScore: 0 }),
            expect.objectContaining({ score: 0, vectorScore: 0, textScore: 0 }),
          ]);
        } else {
          expect(old.score / fresh.score).toBeCloseTo(Math.SQRT1_2, 5);
        }
        expect(results[0]?.path).toBe(fresh.path);
        expect(results.every((entry) => entry.provenance?.observedAt === now - 60 * DAY_MS)).toBe(
          true,
        );
      };
      expectSourceRecency(await search());
      expect(fixture.provider.embedQueryCalls).toBe(provider === "none" || lexicalOnly ? 0 : 1);
      expect(
        (await manager.search(query, { ...searchOptions, maxResults: 1, sources: ["sessions"] }))[0]
          ?.path,
      ).toBe(`sessions/main/${freshSession.fileName}`);

      if (!lexicalOnly && !archived) {
        const tool = createMemorySearchTool({
          config: cfg,
          agentId: "main",
          agentSessionKey: "agent:main:memory:z-fresh",
        });
        if (!tool) {
          throw new Error("Expected memory_search tool");
        }
        const result = await tool.execute("source-recency", {
          query,
          corpus: "sessions",
          maxResults: 2,
          minScore: 0,
        });
        expectSourceRecency((result.details as { results: MemorySearchResult[] }).results);
      }

      // A decoy is deliberately outside the canonical source; it must not become its timestamp owner.
      const decoyPath = path.join(fixture.paths.workspace, "sessions", "main", oldSession.fileName);
      await fs.mkdir(path.dirname(decoyPath), { recursive: true });
      await fs.writeFile(decoyPath, "not the indexed transcript");
      expectSourceRecency(await search());
    },
  );
});
