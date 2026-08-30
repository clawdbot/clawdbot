// Session utility performance tests protect resolver cache scaling for large
// session lists with repeated provider/model tuples.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, test, expect, vi } from "vitest";
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
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import * as usageFormat from "../utils/usage-format.js";
import * as titleReader from "./session-transcript-title-reader.js";
import { resolveEstimatedSessionCostUsd } from "./session-utils-core.js";
import { resolveGatewaySessionThinkingProjectionInternal } from "./session-utils-model.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import { listSessionsFromStoreAsync } from "./session-utils.js";

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
describe("session list resolver cache", () => {
  test("collapses request-local resolver work to O(unique provider/model tuples)", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "google-vertex/gemini-3-flash-preview" },
          thinkingDefault: "off",
        },
      },
    } as OpenClawConfig;
    const tuples: Array<{ modelProvider: string; model: string }> = [
      { modelProvider: "google-vertex", model: "gemini-3-flash-preview" },
      { modelProvider: "openai", model: "gpt-5" },
      { modelProvider: "anthropic", model: "claude-opus-4-7" },
      { modelProvider: "openrouter", model: "z-ai/glm-5" },
      { modelProvider: "google", model: "gemini-2.5-pro" },
    ];
    const now = Date.now();
    const rowCount = 30;
    const rowContext = buildSessionListRowMetadataContext({ now });
    const thinkingSpy = vi
      .spyOn(thinking, "resolveThinkingProfile")
      .mockReturnValue({ levels: [{ id: "off", label: "Off", rank: 0 }], defaultLevel: "off" });
    const costSpy = vi.spyOn(usageFormat, "resolveModelCostConfig").mockReturnValue({
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
    });
    try {
      for (let index = 0; index < rowCount; index += 1) {
        const tuple = expectDefined(
          tuples[index % tuples.length],
          "tuples[index % tuples.length] test invariant",
        );
        const sessionKey = `agent:default:webchat:dm:${index}`;
        const entry: SessionEntry = {
          sessionId: `cache-proof-${index}`,
          updatedAt: now - index,
          modelProvider: tuple.modelProvider,
          model: tuple.model,
          inputTokens: 100,
          outputTokens: 50,
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: sessionKey,
            mode: "oneshot",
            state: "idle",
            lastActivityAt: now,
          },
        };
        expect(
          resolveGatewaySessionThinkingProjectionInternal({
            cfg,
            agentId: "default",
            provider: tuple.modelProvider,
            model: tuple.model,
            sessionKey,
            entry,
            rowContext,
          }).thinkingOptions,
        ).toEqual(["Off"]);
        expect(
          resolveEstimatedSessionCostUsd({
            cfg,
            provider: tuple.modelProvider,
            model: tuple.model,
            entry,
            rowContext,
          }),
        ).toBeDefined();
      }

      // Both caches key on the five unique tuples, not all 30 rows.
      expect(thinkingSpy).toHaveBeenCalledTimes(tuples.length);
      expect(costSpy).toHaveBeenCalledTimes(tuples.length);
    } finally {
      thinkingSpy.mockRestore();
      costSpy.mockRestore();
    }
  });

  test("batches ACP metadata reads once per list without changing row results", async () => {
    await withStateDirEnv("openclaw-perf-acp-", async ({ stateDir }) => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      const cfg = {
        agents: { defaults: { model: { primary: "openai/gpt-5" }, thinkingDefault: "off" } },
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
        // Composite and legacy identities share the production 500-key chunks.
        // Cross two boundaries without materializing tens of thousands of rows.
        const aboveBatchChunkSize = Array.from({ length: 501 }, (_, index) => ({
          sessionKey: `agent:default:webchat:dm:missing-${index}`,
          entry: {
            sessionId: `missing-session-${index}`,
            updatedAt: index,
          } satisfies SessionEntry,
        }));
        const chunkedBatch = readAcpSessionMetaBatch({ entries: aboveBatchChunkSize });
        expect(chunkedBatch.size).toBe(aboveBatchChunkSize.length);
        expect(chunkedBatch.get(aboveBatchChunkSize[0]!.entry)).toBeUndefined();
        expect(chunkedBatch.get(aboveBatchChunkSize.at(-1)!.entry)).toBeUndefined();
        expect(acpSelects).toBe(3);

        acpSelects = 0;
        const result = await listSessionsFromStoreAsync({
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

  test.each([
    { name: "ordinary", count: 30, owned: 0, limit: 30, rows: 30, enriched: 30, sharedTail: 29 },
    {
      name: "retained owner-first",
      count: 480,
      owned: 240,
      limit: 240,
      rows: 300,
      enriched: 160,
      sharedTail: 99,
    },
  ])("batches $name transcript hydration without starving shared rows", async (scenario) => {
    await withStateDirEnv("openclaw-perf-title-batch-", async () => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      const cfg = {
        agents: { defaults: { model: { primary: "openai/gpt-5" }, thinkingDefault: "off" } },
      } as OpenClawConfig;
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(cfg);
      const storePath = "/tmp/sessions.json";
      const store: Record<string, SessionEntry> = {};
      const ownerId = scenario.owned ? ensureProfileForEmail("owner@example.com").id : undefined;
      for (let index = 0; index < scenario.count; index += 1) {
        const sessionId = `title-batch-${index}`;
        const sessionKey = `agent:main:${sessionId}`;
        const entry: SessionEntry = {
          sessionId,
          updatedAt: 1_000 - index,
          ...(ownerId && index >= scenario.count - scenario.owned
            ? {
                createdVia: "operator",
                createdActor: { type: "human", source: "profile", id: ownerId },
              }
            : {}),
        };
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
          ownerFirstActorId: ownerId,
          opts: { includeDerivedTitles: true, includeLastMessage: true, limit: scenario.limit },
        });

        expect(result.sessions).toHaveLength(scenario.rows);
        expect(titleBatchSpy).toHaveBeenCalledOnce();
        expect(titleBatchSpy.mock.calls[0]?.[0]).toHaveLength(scenario.enriched);
        const sessionsByKey = new Map(result.sessions.map((session) => [session.key, session]));
        expect(sessionsByKey.get("agent:main:title-batch-0")).toMatchObject({
          derivedTitle: "title 0",
          lastMessagePreview: "last 0",
        });
        expect(sessionsByKey.get(`agent:main:title-batch-${scenario.sharedTail}`)).toMatchObject({
          derivedTitle: `title ${scenario.sharedTail}`,
          lastMessagePreview: `last ${scenario.sharedTail}`,
        });

        titleBatchSpy.mockClear();
        await listSessionsFromStoreAsync({
          cfg,
          storePath,
          store,
          ownerFirstActorId: ownerId,
          opts: { includeDerivedTitles: false, includeLastMessage: false, limit: scenario.limit },
        });
        expect(titleBatchSpy).toHaveBeenCalledOnce();
        expect(titleBatchSpy).toHaveBeenCalledWith([]);
      } finally {
        titleBatchSpy.mockRestore();
      }
    });
  });
});
