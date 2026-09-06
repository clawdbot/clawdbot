import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type {
  AgentHarness,
  AgentHarnessSessionDeletionParams,
} from "../../agents/harness/types.js";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
  revokePluginRecord,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import {
  beginSessionWorkAdmission,
  isCompetingSessionWorkAdmissionActive,
  isSessionWorkAdmissionActive,
} from "../../sessions/session-lifecycle-admission.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import * as personalPublicationLifecycle from "../../state/github-personal-publication-lifecycle.js";
import {
  closeOpenClawAgentDatabasesForTest,
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  applySessionEntryLifecycleMutation,
  applySessionEntryReplacements,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  replaceSessionEntry,
  replaceTranscriptEventsSync,
} from "./session-accessor.js";
import * as sessionArchive from "./session-accessor.sqlite-archive.js";
import {
  runSqliteSessionDeletionTransaction,
  withSqliteSessionDeletions,
} from "./session-accessor.sqlite-deletion.js";
import { deleteSessionEntryRows } from "./session-accessor.sqlite-entry-store.js";
import { applySessionStoreProjection } from "./session-accessor.sqlite-projection.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session deletion and native owner state", () => {
  let storePath: string;
  const sessionKey = "agent:main:cron:cleanup:run:session";
  const baseKey = "agent:main:cron:cleanup";
  const sessionId = "cleanup-session";
  let bindings: Map<string, string>;

  beforeEach(() => {
    const tempDir = tempDirs.make("openclaw-session-deletion-");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    bindings = new Map();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  function nativeOwner(
    options: {
      activate?: boolean;
      prepare?: (params: AgentHarnessSessionDeletionParams) => Promise<void>;
      finalize?: () => Promise<void>;
      afterCommit?: (key: string) => void;
      afterRollback?: (key: string) => void;
    } = {},
  ) {
    const registry = createEmptyPluginRegistry();
    const harness: AgentHarness = {
      id: "native-test",
      label: "Native test owner",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("not used");
      },
      withSessionDeletion: async (params, run) => {
        await options.prepare?.(params);
        params.assertCurrent();
        const before = bindings.get(params.sessionKey);
        let committed = false;
        const result = await run({
          commit: () => {
            params.assertCurrent();
            if (bindings.get(params.sessionKey) !== before) {
              throw new Error("native binding owner changed");
            }
            bindings.delete(params.sessionKey);
            committed = true;
            options.afterCommit?.(params.sessionKey);
          },
          rollback: () => {
            params.assertCurrent();
            if (before !== undefined && !bindings.has(params.sessionKey)) {
              bindings.set(params.sessionKey, before);
            }
            committed = false;
            options.afterRollback?.(params.sessionKey);
          },
        });
        if (committed) {
          await options.finalize?.();
          params.assertCurrent();
        }
        return result;
      },
    };
    const record = createPluginRecord({ id: "native-owner" });
    registry.plugins.push(record);
    registry.agentHarnesses.push({ harness, pluginId: record.id, source: "runtime" });
    if (options.activate !== false) {
      markPluginRegistryActive(registry);
    }
    return {
      record,
      registry,
      run: <T>(operation: () => Promise<T>) => withPluginRuntimeRegistryScope(registry, operation),
    };
  }

  async function seed(key = sessionKey, harnessId: string | null = "native-test") {
    await replaceSessionEntry(
      { sessionKey: key, storePath },
      {
        sessionId,
        lifecycleRevision: "generation-1",
        updatedAt: Date.now(),
        ...(harnessId ? { agentHarnessId: harnessId } : {}),
      },
    );
    bindings.set(key, `thread:${key}`);
  }

  const remove = (key = sessionKey) =>
    deleteSessionEntryLifecycle({
      agentId: "main",
      storePath,
      target: { canonicalKey: key, storeKeys: [key] },
      archiveTranscript: false,
      deleteTranscriptWithoutArchive: true,
    });
  const read = (key = sessionKey) =>
    loadSessionEntry({ sessionKey: key, storePath, readConsistency: "latest" });

  it.each(["no windows", "a shared window", "a placeholder successor"] as const)(
    "does not materialize surviving prompts when deleting a node with %s",
    async (scenario) => {
      const reclaimedKey = "agent:main:reclaimed-node";
      const survivorKeys = ["agent:main:survivor-a", "agent:main:survivor-b"] as const;
      const entry = { sessionId: "reclaimed-session", updatedAt: Date.now() };
      const retainedEvent = { type: "session", id: entry.sessionId, content: "retained history" };
      await replaceSessionEntry({ sessionKey: reclaimedKey, storePath }, entry);
      for (const survivorKey of survivorKeys.toReversed()) {
        await replaceSessionEntry(
          { sessionKey: survivorKey, storePath },
          {
            sessionId: `${survivorKey}-session`,
            previousSessionId: entry.sessionId,
            updatedAt: entry.updatedAt,
            skillsSnapshot: { prompt: "saved skill prompt".repeat(4096), skills: [] },
            systemPromptReport: {
              source: "run",
              generatedAt: entry.updatedAt,
              systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
              injectedWorkspaceFiles: [],
              skills: { promptChars: 0, entries: [{ name: "saved-report-skill", blockChars: 0 }] },
              tools: { listChars: 0, schemaChars: 0, entries: [] },
            },
          },
        );
      }
      const scope = {
        agentId: "main",
        path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
      };
      const database = openOpenClawAgentDatabase(scope);
      if (scenario === "no windows") {
        database.db.prepare("DELETE FROM session_windows WHERE session_key = ?").run(reclaimedKey);
      } else {
        replaceTranscriptEventsSync(
          { sessionKey: reclaimedKey, sessionId: entry.sessionId, storePath },
          [retainedEvent],
        );
        if (scenario === "a placeholder successor") {
          database.db
            .prepare(
              "UPDATE session_nodes SET current_session_id = ?, entry_json = '{}', entry_valid = -1 WHERE session_key = ?",
            )
            .run(entry.sessionId, survivorKeys[0]);
        }
      }
      const readSurvivors = () =>
        database.db
          .prepare(
            "SELECT session_key, current_session_id, entry_json, entry_valid FROM session_nodes WHERE session_key != ? ORDER BY session_key",
          )
          .all(reclaimedKey);
      const survivorsBefore = readSurvivors();
      const queries = vi.spyOn(sqliteQueries, "executeSqliteQuerySync");
      try {
        await withSqliteSessionDeletions(scope, [{ sessionKey: reclaimedKey, entry }], async () => {
          runSqliteSessionDeletionTransaction((current) => {
            deleteSessionEntryRows(current, reclaimedKey, {
              deleteOwnedWindows: scenario === "a shared window",
            });
          }, scope);
        });
        const rows = queries.mock.results.flatMap((result) =>
          result.type === "return" ? result.value.rows : [],
        );
        if (scenario === "no windows") {
          for (const survivorKey of survivorKeys) {
            expect(rows).not.toContainEqual(
              expect.objectContaining({ session_key: survivorKey, entry_json: expect.any(String) }),
            );
          }
        }
        for (const payload of ["saved skill prompt", "saved-report-skill"]) {
          expect(
            rows.filter(
              (row) =>
                typeof row === "object" &&
                row !== null &&
                "entry_json" in row &&
                typeof row.entry_json === "string" &&
                row.entry_json.includes(payload),
            ).length,
          ).toBe(0);
        }
      } finally {
        queries.mockRestore();
      }
      expect(loadSessionEntry({ sessionKey: reclaimedKey, storePath })).toBeUndefined();
      expect(readSurvivors()).toEqual(survivorsBefore);
      if (scenario !== "no windows") {
        expect(
          database.db
            .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
            .get(entry.sessionId),
        ).toEqual({ session_key: survivorKeys[0] });
        await expect(
          loadTranscriptEvents({
            sessionKey: survivorKeys[0],
            sessionId: entry.sessionId,
            storePath,
          }),
        ).resolves.toEqual([retainedEvent]);
      }
    },
  );

  it("patches a case-distinct Matrix room without preparing its admitted sibling for deletion", async () => {
    const mixedKey = "agent:main:matrix:channel:!RoomAbC:example.org";
    const lowerKey = "agent:main:matrix:channel:!roomabc:example.org";
    for (const [key, id, room] of [
      [mixedKey, "mixed-session", "!RoomAbC:example.org"],
      [lowerKey, "lower-session", "!roomabc:example.org"],
    ] as const) {
      await replaceSessionEntry(
        { sessionKey: key, storePath },
        {
          sessionId: id,
          lifecycleRevision: `generation:${id}`,
          updatedAt: Date.now(),
          agentHarnessId: "native-test",
          delivery: normalizeSessionDeliveryState({ context: { channel: "matrix", to: room } }),
        },
      );
      bindings.set(key, `thread:${key}`);
    }
    const siblingBefore = read(lowerKey);
    const bindingsBefore = new Map(bindings);
    const prepare = vi.fn(async () => {});
    const owner = nativeOwner({ prepare });
    const identities = [lowerKey, "lower-session"];
    const onInterrupt = vi.fn();
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities,
      assertAllowed: () => {},
      onInterrupt,
    });
    try {
      const patched = await owner.run(() =>
        patchSessionEntryCore(
          { sessionKey: mixedKey, storePath },
          () => ({ label: "updated room" }),
          { skipMaintenance: true },
        ),
      );

      expect(patched).toMatchObject({ sessionId: "mixed-session", label: "updated room" });
      expect(read(mixedKey)).toEqual(patched);
      expect(read(lowerKey)).toEqual(siblingBefore);
      expect(bindings).toEqual(bindingsBefore);
      expect(prepare).not.toHaveBeenCalled();
      expect(onInterrupt).not.toHaveBeenCalled();
      expect(isSessionWorkAdmissionActive(storePath, identities)).toBe(true);
      expect(isCompetingSessionWorkAdmissionActive(storePath, identities)).toBe(true);
      await admission.run(async () => {
        expect(isCompetingSessionWorkAdmissionActive(storePath, identities)).toBe(false);
      });
    } finally {
      admission.release();
    }
  });

  it.each(["recorded", "missing"] as const)(
    "honors identity guards before deleting %s harness ownership",
    async (metadata) => {
      await seed(sessionKey, metadata === "recorded" ? "native-test" : null);
      await seed(baseKey);
      const owner = nativeOwner();

      await expect(
        owner.run(() =>
          deleteSessionEntryLifecycle({
            archiveTranscript: false,
            storePath,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
            expectedSessionId: null,
          }),
        ),
      ).resolves.toEqual({
        archivedTranscripts: [],
        deleted: false,
        expectedEntryMismatch: true,
      });
      expect(read()).toMatchObject({ sessionId });
      expect(bindings.has(sessionKey)).toBe(true);

      await expect(owner.run(() => remove())).resolves.toMatchObject({ deleted: true });

      expect(read()).toBeUndefined();
      expect(bindings.has(sessionKey)).toBe(false);
      expect(read(baseKey)?.sessionId).toBe(sessionId);
      expect(bindings.has(baseKey)).toBe(true);
      await owner.run(() => remove(baseKey));
      expect(bindings.size).toBe(0);
    },
  );

  it("rejects an unavailable native owner before deleting session or transcript state", async () => {
    await seed();
    replaceTranscriptEventsSync({ sessionKey, sessionId, storePath }, [
      { type: "session", id: sessionId },
    ]);
    const owner = nativeOwner({
      prepare: async () => {
        throw new Error("native session is supervised");
      },
    });

    await expect(owner.run(() => remove())).rejects.toThrow("native session is supervised");

    expect(read()?.sessionId).toBe(sessionId);
    expect(await loadTranscriptEvents({ sessionKey, sessionId, storePath })).toHaveLength(1);
    expect(bindings.has(sessionKey)).toBe(true);
  });

  it("restores companion state when the session transaction fails after its binding removal", async () => {
    await seed();
    const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
    const database = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
    database.db.exec(
      "CREATE TEMP TRIGGER reject_session_delete BEFORE DELETE ON session_nodes BEGIN SELECT RAISE(ABORT, 'injected session delete failure'); END",
    );
    const owner = nativeOwner();

    await expect(owner.run(() => remove())).rejects.toThrow("injected session delete failure");

    expect(read()?.sessionId).toBe(sessionId);
    expect(bindings.get(sessionKey)).toBe(`thread:${sessionKey}`);
  });

  it("does not restore a binding after the session committed but publication failed", async () => {
    await seed();
    const owner = nativeOwner();

    await expect(
      owner.run(() =>
        applySessionEntryLifecycleMutation({
          storePath,
          removals: [{ sessionKey }],
          skipMaintenance: true,
          beforeCommitInTransaction: () => {
            const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
            const database = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
            deferOpenClawAgentPostCommitPublication(database, () => {
              throw new Error("injected publication failure");
            });
          },
        }),
      ),
    ).rejects.toThrow("injected publication failure");

    expect(read()).toBeUndefined();
    expect(bindings.has(sessionKey)).toBe(false);
  });

  it("publishes committed deletion when personal publication receipt cleanup fails", async () => {
    await seed();
    const owner = nativeOwner();
    const cleanupError = new Error("injected receipt cleanup failure");
    vi.spyOn(
      personalPublicationLifecycle,
      "deletePersonalGitHubSessionReceipts",
    ).mockImplementationOnce(() => {
      throw cleanupError;
    });
    const identityListener = vi.fn();
    const unsubscribe = onSessionIdentityMutation(identityListener);

    try {
      await expect(owner.run(() => remove())).rejects.toBe(cleanupError);

      expect(read()).toBeUndefined();
      expect(bindings.has(sessionKey)).toBe(false);
      expect(identityListener.mock.calls).toEqual([
        [{ kind: "delete", previous: { sessionId, sessionKeys: [sessionKey] } }],
      ]);
    } finally {
      unsubscribe();
    }
  });

  it.each([false, true])(
    "compensates partial commits even when another rollback fails (%s)",
    async (rollbackFails) => {
      await seed();
      await seed(baseKey);
      const commitError = new Error("companion commit failed after mutation");
      const rollbackError = new Error("companion rollback reported failure");
      let commits = 0;
      let rollbacks = 0;
      const owner = nativeOwner({
        afterCommit: () => {
          if (++commits === 2) {
            throw commitError;
          }
        },
        afterRollback: () => {
          if (++rollbacks === 1 && rollbackFails) {
            throw rollbackError;
          }
        },
      });
      const deletion = owner.run(() =>
        applySessionStoreProjection({
          storePath,
          skipMaintenance: true,
          update: (store) => {
            delete store[baseKey];
            delete store[sessionKey];
            return { persist: true, result: undefined };
          },
        }),
      );
      if (rollbackFails) {
        await expect(deletion).rejects.toMatchObject({
          cause: commitError,
          errors: [commitError, rollbackError],
        });
      } else {
        await expect(deletion).rejects.toBe(commitError);
      }
      expect(read()?.sessionId).toBe(sessionId);
      expect(read(baseKey)?.sessionId).toBe(sessionId);
      expect(bindings.get(sessionKey)).toBe(`thread:${sessionKey}`);
      expect(bindings.get(baseKey)).toBe(`thread:${baseKey}`);
    },
  );

  it.each(["prepare", "finalize"] as const)(
    "lets unrelated session writers progress during native %s",
    async (phase) => {
      await seed();
      await seed(baseKey);
      const entered = createDeferred();
      const release = createDeferred();
      const wait = async () => {
        entered.resolve();
        await release.promise;
      };
      const owner = nativeOwner(phase === "prepare" ? { prepare: wait } : { finalize: wait });
      const deletion = owner.run(() => remove());
      try {
        await withTestTimeout(entered.promise, 5_000, "native deletion did not start");
        await withTestTimeout(
          owner.run(() =>
            patchSessionEntryCore({ sessionKey: baseKey, storePath }, () => ({
              label: "writer progressed",
            })),
          ),
          5_000,
          "native cleanup blocked another session writer",
        );
        expect(read(baseKey)?.label).toBe("writer progressed");
      } finally {
        release.resolve();
        await deletion;
      }
    },
  );

  it.each(["scoped", "published during preparation"] as const)(
    "uses the exact prepared owner while %s",
    async (publication) => {
      await seed();
      let retainedGuard: (() => void) | undefined;
      const owner = nativeOwner({
        activate: false,
        prepare: async ({ assertCurrent }) => {
          retainedGuard = assertCurrent;
          if (publication === "published during preparation") {
            markPluginRegistryActive(owner.registry);
          }
        },
      });
      await owner.run(() => remove());
      expect(read()).toBeUndefined();
      expect(bindings.has(sessionKey)).toBe(false);
      expect(() => retainedGuard?.()).toThrow("harness owner changed");
    },
  );

  it.each(["retired", "reactivated", "record revoked", "registration replaced"] as const)(
    "rejects a prepared owner after its registry is %s",
    async (change) => {
      await seed();
      const entered = createDeferred();
      const release = createDeferred();
      const owner = nativeOwner({
        activate: false,
        prepare: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      const deletion = owner.run(() => remove());
      const rejected = expect(deletion).rejects.toThrow("harness owner changed");
      await entered.promise;
      if (change === "retired") {
        markPluginRegistryRetired(owner.registry);
      } else if (change === "reactivated") {
        markPluginRegistryRetired(owner.registry);
        markPluginRegistryActive(owner.registry);
      } else if (change === "record revoked") {
        revokePluginRecord(owner.registry, owner.record);
      } else {
        owner.registry.agentHarnesses = owner.registry.agentHarnesses.map((registration) =>
          Object.assign({}, registration),
        );
      }
      release.resolve();
      await rejected;
      expect(read()?.sessionId).toBe(sessionId);
      expect(bindings.has(sessionKey)).toBe(true);
    },
  );

  it("rejects a captured prepared owner invoked under a different registry scope", async () => {
    await seed();
    const other = createEmptyPluginRegistry();
    const owner = nativeOwner({
      activate: false,
      prepare: async ({ assertCurrent }) => {
        withPluginRuntimeRegistryScope(other, assertCurrent);
      },
    });
    await expect(owner.run(() => remove())).rejects.toThrow("harness owner changed");
    expect(read()?.sessionId).toBe(sessionId);
    expect(bindings.has(sessionKey)).toBe(true);
  });

  it("preserves history when its native owner retires during archive materialization", async () => {
    const historicalId = "historical-cleanup-session";
    const historicalEvent = { type: "session", id: historicalId, content: "retained history" };
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: historicalId, updatedAt: Date.now() },
    );
    expect(
      replaceTranscriptEventsSync({ sessionKey, sessionId: historicalId, storePath }, [
        historicalEvent,
      ]),
    ).toBe(true);
    await seed();
    const materialize = sessionArchive.materializeSessionStateDeletePlans;
    const owner = nativeOwner();
    vi.spyOn(sessionArchive, "materializeSessionStateDeletePlans").mockImplementationOnce(
      async (...args) => {
        const result = await materialize(...args);
        // Retire at the pre-commit boundary, independent of archive Worker latency.
        markPluginRegistryRetired(owner.registry);
        return result;
      },
    );
    const deletion = owner.run(() =>
      deleteSessionEntryLifecycle({
        agentId: "main",
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        archiveTranscript: true,
      }),
    );
    await expect(deletion).rejects.toThrow("harness owner changed");
    expect(read()?.sessionId).toBe(sessionId);
    expect(bindings.has(sessionKey)).toBe(true);
    expect(await loadTranscriptEvents({ sessionKey, sessionId: historicalId, storePath })).toEqual([
      historicalEvent,
    ]);
  });

  it.each(["entry replacement", "whole-store projection", "maintenance"] as const)(
    "preserves successor bindings and removes deleted keys through %s",
    async (surface) => {
      await seed();
      const owner = nativeOwner();
      await owner.run(async () => {
        if (surface === "entry replacement") {
          await applySessionEntryReplacements({
            storePath,
            sessionKeys: [sessionKey],
            skipMaintenance: true,
            update: (entries) => ({
              result: undefined,
              replacements: entries.map(({ entry, sessionKey: key }) => ({
                sessionKey: key,
                entry: { ...entry, sessionId: "replacement-session" },
              })),
            }),
          });
          return;
        }
        if (surface === "whole-store projection") {
          await applySessionStoreProjection({
            storePath,
            skipMaintenance: true,
            update: (store) => {
              delete store[sessionKey];
              return { persist: true, result: undefined };
            },
          });
          return;
        }
        await applySessionEntryLifecycleMutation({
          storePath,
          maintenanceOverride: {
            mode: "enforce",
            maxEntries: 0,
            pruneAfterMs: Number.MAX_SAFE_INTEGER,
            preserveRecentMs: 0,
          },
        });
      });
      expect(bindings.has(sessionKey)).toBe(surface === "entry replacement");
      expect(read()?.sessionId).toBe(
        surface === "entry replacement" ? "replacement-session" : undefined,
      );
    },
  );
});
