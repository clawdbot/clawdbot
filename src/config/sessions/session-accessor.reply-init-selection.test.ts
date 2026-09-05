import path from "node:path";
import { expect, it, vi } from "vitest";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  applySessionEntryLifecycleMutation,
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import type { SessionEntry } from "./types.js";

it("retains only declared reply rows and their stored model parent at each snapshot", async () => {
  await withOpenClawTestState({ label: "reply-row-selection" }, async (state) => {
    const sessionKey = "agent:main:reply";
    const parentKey = "agent:main:matrix:group:!Parent:example.org";
    const storedParentKey = "agent:main:stored-parent";
    const unrelatedKey = "agent:main:matrix:group:!parent:example.org";
    const relatedSessionKeys = [
      "agent:main:main",
      parentKey,
      "agent:main:model-parent",
      "agent:main:command-target",
      "agent:main:missing",
    ];
    const storePath = path.join(state.sessionsDir("main"), "sessions.json");
    const scope = { agentId: "main", sessionKey, storePath, relatedSessionKeys };
    const now = Date.now();
    const current = { sessionId: "reply", updatedAt: now, parentSessionKey: storedParentKey };
    const unrelated = {
      sessionId: "unrelated",
      updatedAt: now,
      skillsSnapshot: { prompt: "unrelated prompt ".repeat(4096), skills: [] },
    };
    for (const [key, entry] of [
      [sessionKey, current],
      [storedParentKey, { sessionId: "stored-parent", updatedAt: now }],
      [unrelatedKey, unrelated],
      ...relatedSessionKeys
        .slice(0, -1)
        .map((relatedKey, index) => [
          relatedKey,
          { sessionId: `related-${index}`, updatedAt: now, label: "before snapshot" },
        ]),
    ] as Array<[string, SessionEntry]>) {
      await upsertSessionEntryCore({ ...scope, sessionKey: key }, entry);
    }

    const persistedCurrent = loadSessionEntry(scope)!;
    const persistedUnrelated = loadSessionEntry({ ...scope, sessionKey: unrelatedKey });
    const snapshot = loadReplySessionInitializationSnapshot(scope);
    expect(snapshot.currentEntry).toEqual(persistedCurrent);
    expect(snapshot.readEntry(storedParentKey)?.sessionId).toBe("stored-parent");
    expect(snapshot.readEntry(unrelatedKey)).toBeUndefined();
    expect(snapshot.readEntry("agent:main:missing")).toBeUndefined();

    const parentScope = { ...scope, sessionKey: parentKey };
    const parent = snapshot.readEntry(parentKey)!;
    await upsertSessionEntryCore(parentScope, { ...parent, label: "before commit" });
    expect(snapshot.readEntry(parentKey)?.label).toBe("before snapshot");

    const committed = await commitReplySessionInitialization({
      ...scope,
      activeSessionKey: sessionKey,
      archivePreviousTranscript: false,
      expectedRevision: snapshot.revision,
      sessionEntry: persistedCurrent,
      prepareSessionEntry: async ({ readEntry, sessionEntry }) => {
        expect(readEntry(parentKey)?.label).toBe("before commit");
        await upsertSessionEntryCore(parentScope, { ...parent, label: "after commit snapshot" });
        expect(readEntry(parentKey)?.label).toBe("before commit");
        return sessionEntry;
      },
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("reply initialization unexpectedly conflicted");
    }
    expect(Object.keys(committed.sessionStoreView).toSorted()).toEqual(
      [sessionKey, storedParentKey, ...relatedSessionKeys.slice(0, -1)].toSorted(),
    );
    expect(committed.sessionStoreView[parentKey]?.label).toBe("before commit");
    expect(loadSessionEntry(parentScope)?.label).toBe("after commit snapshot");
    expect(loadSessionEntry({ ...scope, sessionKey: unrelatedKey })).toEqual(persistedUnrelated);
  });
});

it.each(["upsert", "removal"] as const)(
  "projects a lifecycle %s without acquiring unrelated prompt payloads",
  async (operation) => {
    await withOpenClawTestState({ label: `lifecycle-selected-${operation}` }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:selected",
        storePath: path.join(state.sessionsDir("main"), "sessions.json"),
      };
      const current = { sessionId: "selected", updatedAt: Date.now(), label: "original" };
      const unrelatedScope = { ...scope, sessionKey: "agent:main:unrelated" };
      const prompt = "unrelated lifecycle prompt ".repeat(4096);
      await upsertSessionEntryCore(scope, current);
      await upsertSessionEntryCore(unrelatedScope, {
        sessionId: "unrelated",
        updatedAt: Date.now(),
        skillsSnapshot: { prompt, skills: [] },
      });
      // The connection's one-time canonical check is separate from per-mutation projection.
      const persistedCurrent = loadSessionEntry(scope)!;
      const iterate = sqliteQueries.iterateSqliteQuerySync;
      let acquiredPromptRows = 0;
      const reads = vi.spyOn(sqliteQueries, "iterateSqliteQuerySync").mockImplementation(function* <
        Row,
      >(...args: Parameters<typeof sqliteQueries.iterateSqliteQuerySync<Row>>) {
        for (const row of iterate<Row>(...args)) {
          if (
            row !== null &&
            typeof row === "object" &&
            "entry_json" in row &&
            typeof row.entry_json === "string" &&
            row.entry_json.includes(prompt)
          ) {
            acquiredPromptRows += 1;
          }
          yield row;
        }
      });
      try {
        await applySessionEntryLifecycleMutation({
          ...scope,
          skipMaintenance: true,
          ...(operation === "removal"
            ? { removals: [{ sessionKey: scope.sessionKey, expectedEntry: persistedCurrent }] }
            : {
                upserts: [
                  {
                    sessionKey: scope.sessionKey,
                    buildEntry: ({ currentEntry }) => {
                      expect(currentEntry).toEqual(persistedCurrent);
                      return { ...currentEntry!, label: "updated" };
                    },
                  },
                ],
              }),
        });
      } finally {
        reads.mockRestore();
      }
      expect(acquiredPromptRows).toBe(0);
      expect(loadSessionEntry(unrelatedScope)?.skillsSnapshot?.prompt).toBe(prompt);
      expect(loadSessionEntry(scope)?.label).toBe(operation === "removal" ? undefined : "updated");
    });
  },
);
