// Session utility performance tests protect resolver cache scaling for large
// session lists with repeated provider/model tuples.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, describe, test, expect, vi } from "vitest";
import {
  readAcpSessionMetaBatch,
  readAcpSessionMetaForEntry,
  writeAcpSessionMetaForMigration,
} from "../acp/runtime/session-meta.js";
import * as thinking from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import * as usageFormat from "../utils/usage-format.js";
import * as titleReader from "./session-transcript-title-reader.js";
import { listSessionsFromStore, listSessionsFromStoreAsync } from "./session-utils.js";

/**
 * Regression smoke for the per-list rowContext resolver cache. The bug we are
 * guarding against is O(rows) scaling of deterministic resolvers whose results
 * only depend on `(provider, model[, agentId])`: with N sessions sharing K
 * unique model tuples, the cached path must perform at most O(K) underlying
 * resolver calls -- not O(N).
 *
 * We assert call counts directly instead of a wall-time bound because shared
 * CI runners cannot give a stable wall-time signal, and call-count regressions
 * are the actual scaling failure mode we care about.
 */
describe("listSessionsFromStore resolver cache", () => {
  beforeAll(async () => {
    await withStateDirEnv("openclaw-perf-warm-", async ({ stateDir }) => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      const cfg = {
        agents: { defaults: { model: { primary: "google-vertex/gemini-3-flash-preview" } } },
      } as OpenClawConfig;
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(cfg);
      listSessionsFromStore({
        cfg,
        storePath: path.join(stateDir, "sessions.json"),
        store: {
          google: {
            sessionId: "google",
            updatedAt: 1,
            modelProvider: "google-vertex",
            model: "gemini-3-flash-preview",
          },
          openai: {
            sessionId: "openai",
            updatedAt: 1,
            modelProvider: "openai",
            model: "gpt-5",
          },
          anthropic: {
            sessionId: "anthropic",
            updatedAt: 1,
            modelProvider: "anthropic",
            model: "claude-opus-4-7",
          },
          openrouter: {
            sessionId: "openrouter",
            updatedAt: 1,
            modelProvider: "openrouter",
            model: "z-ai/glm-5",
          },
        },
        opts: {},
      });
    });
  });

  test("collapses non-lightweight per-row resolver work to O(unique provider/model tuples)", async () => {
    await withStateDirEnv("openclaw-perf-", async ({ stateDir }) => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { model: { primary: "google-vertex/gemini-3-flash-preview" } },
        },
      } as OpenClawConfig;
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(cfg);

      const tuples: Array<{ modelProvider: string; model: string }> = [
        { modelProvider: "google-vertex", model: "gemini-3-flash-preview" },
        { modelProvider: "openai", model: "gpt-5" },
        { modelProvider: "anthropic", model: "claude-opus-4-7" },
        { modelProvider: "openrouter", model: "z-ai/glm-5" },
        { modelProvider: "google", model: "gemini-2.5-pro" },
      ];

      const store: Record<string, SessionEntry> = {};
      const now = Date.now();
      const rowCount = 30;
      for (let i = 0; i < rowCount; i++) {
        const tuple = expectDefined(
          tuples[i % tuples.length],
          "tuples[i % tuples.length] test invariant",
        );
        store[`agent:default:webchat:dm:${i}`] = {
          updatedAt: now - i,
          modelProvider: tuple.modelProvider,
          model: tuple.model,
          inputTokens: 100,
          outputTokens: 50,
        } as SessionEntry;
      }

      const thinkingSpy = vi.spyOn(thinking, "listThinkingLevelOptions");
      const costSpy = vi.spyOn(usageFormat, "resolveModelCostConfig");
      try {
        const result = listSessionsFromStore({
          cfg,
          storePath: path.join(stateDir, "sessions.json"),
          store,
          // sessions.list bounds responses to 100 rows by default; the perf
          // smoke explicitly opts into the full set so the non-lightweight
          // row builder exercises the display-identity, thinking-default, and
          // model-cost caches at scale.
          opts: { limit: rowCount },
        });
        expect(result.sessions.length).toBe(rowCount);

        // The cache keys on rowContext are (provider, model) or
        // (agentId, provider, model). With K=5 unique tuples we must see at
        // most a small constant number of resolver calls, not O(N=30). A
        // pre-cache regression would scale linearly and easily exceed the
        // threshold below.
        const cacheCallCeiling = tuples.length * 4;
        expect(thinkingSpy.mock.calls.length).toBeLessThanOrEqual(cacheCallCeiling);
        expect(costSpy.mock.calls.length).toBeLessThanOrEqual(cacheCallCeiling);
      } finally {
        thinkingSpy.mockRestore();
        costSpy.mockRestore();
      }
    });
  });

  test("batches ACP metadata reads once per list without changing row results", async () => {
    await withStateDirEnv("openclaw-perf-acp-", async ({ stateDir }) => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      const cfg = {
        agents: { defaults: { model: { primary: "openai/gpt-5" } } },
      } as OpenClawConfig;
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(cfg);

      const stateKey = "agent:default:webchat:dm:state";
      const missingKey = "agent:default:webchat:dm:missing";
      const markerKey = "agent:default:webchat:dm:marker";
      const stateEntry: SessionEntry = {
        sessionId: "state-session",
        updatedAt: 3,
        modelProvider: "openai",
        model: "gpt-5",
      };
      const missingEntry: SessionEntry = {
        sessionId: "missing-session",
        updatedAt: 2,
        modelProvider: "openai",
        model: "gpt-5",
      };
      const staleAliasEntry: SessionEntry = {
        sessionId: "stale-alias-session",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5",
      };
      const markerMeta = {
        backend: "marker",
        agent: "marker-agent",
        runtimeSessionName: markerKey,
        mode: "persistent" as const,
        state: "idle" as const,
        lastActivityAt: 1,
      };
      const markerEntry: SessionEntry = {
        sessionId: "marker-session",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5",
        acp: markerMeta,
      };
      const stateMeta = {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: stateKey,
        mode: "persistent" as const,
        state: "idle" as const,
        lastActivityAt: 2,
      };
      writeAcpSessionMetaForMigration({
        sessionKey: stateKey,
        sessionId: stateEntry.sessionId,
        meta: stateMeta,
      });

      const perRowState = readAcpSessionMetaForEntry({ sessionKey: stateKey, entry: stateEntry });
      const perRowMissing = readAcpSessionMetaForEntry({
        sessionKey: missingKey,
        entry: missingEntry,
      });
      expect(
        readAcpSessionMetaBatch({
          entries: [
            { sessionKey: stateKey, entry: stateEntry },
            { sessionKey: stateKey, entry: staleAliasEntry },
            { sessionKey: missingKey, entry: missingEntry },
            { sessionKey: markerKey, entry: markerEntry },
          ],
        }),
      ).toEqual(
        new Map<SessionEntry, ReturnType<typeof readAcpSessionMetaForEntry>>([
          [markerEntry, markerMeta],
          [stateEntry, perRowState],
          [staleAliasEntry, undefined],
          [missingEntry, perRowMissing],
        ]),
      );

      const aboveSqliteVariableLimit = Array.from({ length: 33_000 }, (_, index) => ({
        sessionKey: `agent:default:webchat:dm:missing-${index}`,
        entry: {
          sessionId: `missing-session-${index}`,
          updatedAt: index,
        } satisfies SessionEntry,
      }));
      const largeBatch = readAcpSessionMetaBatch({ entries: aboveSqliteVariableLimit });
      expect(largeBatch.size).toBe(aboveSqliteVariableLimit.length);
      expect(largeBatch.get(aboveSqliteVariableLimit[0]!.entry)).toBeUndefined();
      expect(largeBatch.get(aboveSqliteVariableLimit.at(-1)!.entry)).toBeUndefined();

      const database = openOpenClawStateDatabase();
      const originalPrepare = database.db.prepare.bind(database.db);
      let acpSelects = 0;
      const prepareSpy = vi.spyOn(database.db, "prepare").mockImplementation((sql: string) => {
        if (/^select\b.*\bacp_sessions\b/is.test(sql)) {
          acpSelects += 1;
        }
        return originalPrepare(sql);
      });
      try {
        const result = listSessionsFromStore({
          cfg,
          storePath: path.join(stateDir, "agents", "default", "sessions", "sessions.json"),
          store: {
            [stateKey]: stateEntry,
            [missingKey]: missingEntry,
            [markerKey]: markerEntry,
          },
          opts: { limit: 3 },
        });
        expect(result.sessions).toHaveLength(3);
        expect(acpSelects).toBe(1);
      } finally {
        prepareSpy.mockRestore();
      }
    });
  });

  test("batches transcript title hydration once instead of O(rows)", async () => {
    await withStateDirEnv("openclaw-perf-title-batch-", async () => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      const cfg = {
        agents: { defaults: { model: { primary: "openai/gpt-5" } } },
      } as OpenClawConfig;
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(cfg);
      const storePath = "/tmp/sessions.json";
      const store: Record<string, SessionEntry> = {};
      for (let index = 0; index < 30; index += 1) {
        const sessionId = `title-batch-${index}`;
        const sessionKey = `agent:main:${sessionId}`;
        const entry = { sessionId, updatedAt: 1_000 - index } satisfies SessionEntry;
        store[sessionKey] = entry;
      }

      const titleBatchSpy = vi
        .spyOn(titleReader, "readSessionTitleFieldsFromTranscriptBatch")
        .mockImplementation((scopes) =>
          scopes.map((scope) => ({
            firstUserMessage: `title ${scope.sessionId.slice("title-batch-".length)}`,
            lastMessagePreview: `last ${scope.sessionId.slice("title-batch-".length)}`,
          })),
        );
      try {
        const result = await listSessionsFromStoreAsync({
          cfg,
          storePath,
          store,
          opts: { includeDerivedTitles: true, includeLastMessage: true, limit: 30 },
        });

        expect(result.sessions).toHaveLength(30);
        expect(titleBatchSpy).toHaveBeenCalledOnce();
        expect(titleBatchSpy.mock.calls[0]?.[0]).toHaveLength(30);
        const sessionsByKey = new Map(result.sessions.map((session) => [session.key, session]));
        expect(sessionsByKey.get("agent:main:title-batch-0")).toMatchObject({
          derivedTitle: "title 0",
          lastMessagePreview: "last 0",
        });
        expect(sessionsByKey.get("agent:main:title-batch-29")).toMatchObject({
          derivedTitle: "title 29",
          lastMessagePreview: "last 29",
        });

        titleBatchSpy.mockClear();
        await listSessionsFromStoreAsync({
          cfg,
          storePath,
          store,
          opts: { includeDerivedTitles: false, includeLastMessage: false, limit: 30 },
        });
        expect(titleBatchSpy).toHaveBeenCalledOnce();
        expect(titleBatchSpy).toHaveBeenCalledWith([]);
      } finally {
        titleBatchSpy.mockRestore();
      }
    });
  });
});
