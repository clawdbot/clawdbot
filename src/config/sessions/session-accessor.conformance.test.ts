import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readPersistedAuthProfileStateRaw,
  writePersistedAuthProfileStateRaw,
} from "../../agents/auth-profiles/sqlite.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { appendSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.sqlite.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  cleanupSessionLifecycleArtifactsCore,
  listSessionEntriesCore,
  loadExactSessionEntry,
  loadSessionEntry,
  loadTranscriptEvents,
  onSessionIdentityMutation,
  patchSessionEntryCore,
  publishTranscriptUpdate,
  readSessionUpdatedAtCore,
  replaceSessionEntry,
  resolveSessionTranscriptRuntimeTarget,
  updateSessionEntry,
  upsertSessionEntryCore,
  type ExactSessionEntry,
  type SessionAccessScope,
  type SessionEntrySummary,
  type SessionTranscriptAccessScope,
  type SessionTranscriptReadScope,
  type SessionTranscriptWriteScope,
  type TranscriptEvent,
  type TranscriptMessageAppendOptions,
  type TranscriptMessageAppendResult,
  type TranscriptUpdatePayload,
} from "./session-accessor.js";
import {
  branchCompactionCheckpointSession,
  restoreCompactionCheckpointSession,
} from "./session-accessor.sqlite-checkpoint.js";
import { listSessionEntryRows, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { forkSessionEntryFromParentTarget } from "./session-accessor.sqlite-parent-session.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { setCanonicalSqliteSessionMainKey } from "./session-canonical-key.js";
import type { InternalSessionEntry, SessionCompactionCheckpoint, SessionEntry } from "./types.js";

// Keep accessor conformance independent of any real openclaw.json on the machine.
vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

import { getRuntimeConfig } from "../config.js";

type AccessorAdapter = {
  name: string;
  publishesTranscriptUpdates: boolean;
  usesSqliteStore: boolean;
  entryScope(paths: TestPaths): SessionAccessScope;
  transcriptReadScope(paths: TestPaths, id?: string): SessionTranscriptReadScope;
  transcriptScope(paths: TestPaths, id?: string): SessionTranscriptAccessScope;
  loadExactSessionEntry(scope: SessionAccessScope): ExactSessionEntry | undefined;
  loadSessionEntry(scope: SessionAccessScope): SessionEntry | undefined;
  listSessionEntriesCore(
    scope: Partial<Omit<SessionAccessScope, "sessionKey">>,
  ): SessionEntrySummary[];
  readSessionUpdatedAtCore(scope: SessionAccessScope): number | undefined;
  upsertSessionEntry(
    scope: SessionAccessScope,
    patch: Partial<SessionEntry>,
  ): Promise<SessionEntry | null>;
  replaceSessionEntry(scope: SessionAccessScope, entry: SessionEntry): Promise<SessionEntry | null>;
  patchSessionEntryCore(
    scope: SessionAccessScope,
    update: (
      entry: SessionEntry,
      context: { existingEntry?: SessionEntry },
    ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
    options?: { fallbackEntry?: SessionEntry; preserveActivity?: boolean; replaceEntry?: boolean },
  ): Promise<SessionEntry | null>;
  updateSessionEntry(
    scope: SessionAccessScope,
    update: (entry: SessionEntry) => Partial<SessionEntry> | null,
  ): Promise<SessionEntry | null>;
  cleanupSessionLifecycleArtifactsCore(params: {
    storePath: string;
    sessionKeySegmentPrefix: string;
    transcriptContentMarker: string;
    orphanTranscriptMinAgeMs: number;
    nowMs?: number;
  }): Promise<{ removedEntries: number; archivedTranscriptArtifacts: number }>;
  loadTranscriptEvents(scope: SessionTranscriptReadScope): Promise<TranscriptEvent[]>;
  appendTranscriptEvent(scope: SessionTranscriptAccessScope, event: TranscriptEvent): Promise<void>;
  appendTranscriptMessage<TMessage>(
    scope: SessionTranscriptWriteScope,
    options: TranscriptMessageAppendOptions<TMessage>,
  ): Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
  publishTranscriptUpdate(
    scope: SessionTranscriptWriteScope,
    update?: TranscriptUpdatePayload,
  ): Promise<void>;
};

type TestPaths = {
  sqlitePath: string;
  stateDir: string;
  storePath: string;
  tempDir: string;
  transcriptPath: string;
};

const publicAccessorAdapter: AccessorAdapter = {
  name: "public-accessor",
  publishesTranscriptUpdates: true,
  usesSqliteStore: true,
  entryScope: (paths) => ({
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
    sessionKey: "agent:main:main",
    storePath: paths.sqlitePath,
  }),
  transcriptScope: (paths, id = "session-1") => ({
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
    sessionId: id,
    sessionKey: "agent:main:main",
    storePath: paths.sqlitePath,
  }),
  transcriptReadScope: (paths, id = "session-1") => ({
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
    sessionId: id,
    storePath: paths.sqlitePath,
  }),
  loadSessionEntry,
  loadExactSessionEntry,
  listSessionEntriesCore,
  readSessionUpdatedAtCore,
  upsertSessionEntry: upsertSessionEntryCore,
  replaceSessionEntry,
  patchSessionEntryCore,
  updateSessionEntry,
  cleanupSessionLifecycleArtifactsCore,
  loadTranscriptEvents,
  appendTranscriptEvent,
  appendTranscriptMessage,
  publishTranscriptUpdate,
};

const sqliteAdapter: AccessorAdapter = {
  name: "sqlite",
  publishesTranscriptUpdates: true,
  usesSqliteStore: true,
  entryScope: (paths) => ({
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
    sessionKey: "agent:main:main",
    storePath: paths.sqlitePath,
  }),
  transcriptScope: (paths, id = "session-1") => ({
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
    sessionId: id,
    sessionKey: "agent:main:main",
    storePath: paths.sqlitePath,
  }),
  transcriptReadScope: (paths, id = "session-1") => ({
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
    sessionId: id,
    storePath: paths.sqlitePath,
  }),
  loadSessionEntry,
  loadExactSessionEntry,
  listSessionEntriesCore: listSessionEntryRows,
  readSessionUpdatedAtCore,
  upsertSessionEntry: upsertSessionEntryCore,
  replaceSessionEntry,
  patchSessionEntryCore,
  updateSessionEntry: patchSessionEntryCore,
  cleanupSessionLifecycleArtifactsCore,
  loadTranscriptEvents,
  appendTranscriptEvent,
  appendTranscriptMessage,
  publishTranscriptUpdate,
};

beforeEach(() => {
  vi.mocked(getRuntimeConfig).mockReturnValue({});
});

afterEach(() => {
  vi.mocked(getRuntimeConfig).mockReset();
});

describe.each([publicAccessorAdapter, sqliteAdapter])(
  "session accessor conformance: $name",
  (adapter) => {
    let paths: TestPaths;

    beforeEach(() => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-accessor-conf-"));
      paths = {
        sqlitePath: path.join(tempDir, "openclaw-agent.sqlite"),
        stateDir: path.join(tempDir, "state"),
        storePath: path.join(tempDir, "sessions.json"),
        tempDir,
        transcriptPath: path.join(tempDir, "session.jsonl"),
      };
    });

    afterEach(() => {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(paths.tempDir, { recursive: true, force: true });
    });

    it("conforms for entry load/list/timestamp/upsert/update/replace/patch", async () => {
      const scope = adapter.entryScope(paths);

      await adapter.upsertSessionEntry(scope, {
        model: "gpt-5.5",
        sessionId: "session-1",
        updatedAt: 10,
      });

      expect(adapter.loadSessionEntry(scope)).toMatchObject({
        model: "gpt-5.5",
        sessionId: "session-1",
        updatedAt: expect.any(Number),
      });
      expect(adapter.readSessionUpdatedAtCore(scope)).toEqual(expect.any(Number));
      expect(adapter.listSessionEntriesCore(scope)).toEqual([
        {
          sessionKey: "agent:main:main",
          entry: expect.objectContaining({
            model: "gpt-5.5",
            sessionId: "session-1",
          }),
        },
      ]);

      await expect(
        adapter.updateSessionEntry(scope, () => ({ model: "sonnet-4.6", updatedAt: 20 })),
      ).resolves.toMatchObject({
        model: "sonnet-4.6",
        sessionId: "session-1",
      });

      await adapter.replaceSessionEntry(scope, {
        providerOverride: "openai",
        sessionId: "session-1",
        updatedAt: 30,
      });

      expect(adapter.loadSessionEntry(scope)).toMatchObject({
        providerOverride: "openai",
        sessionId: "session-1",
      });
      expect(adapter.loadSessionEntry(scope)?.model).toBeUndefined();

      let existingContext: SessionEntry | undefined;
      await adapter.patchSessionEntryCore(
        scope,
        (entry, context) => {
          existingContext = context.existingEntry;
          return {
            ...entry,
            model: "gpt-5.5",
          };
        },
        { replaceEntry: true },
      );

      expect(existingContext).toMatchObject({ providerOverride: "openai" });
      expect(adapter.loadSessionEntry(scope)).toMatchObject({
        model: "gpt-5.5",
        sessionId: "session-1",
      });

      const beforePreservePatch = adapter.loadSessionEntry(scope);
      await adapter.patchSessionEntryCore(
        scope,
        () => ({
          providerOverride: "anthropic",
          updatedAt: 40,
        }),
        { preserveActivity: true },
      );

      expect(adapter.loadSessionEntry(scope)).toMatchObject({
        model: "gpt-5.5",
        providerOverride: "anthropic",
        sessionId: "session-1",
        updatedAt: beforePreservePatch?.updatedAt,
      });
    });

    it("conforms for exact persisted-key lookup without canonical alias fallback", async () => {
      const scope = adapter.entryScope(paths);
      const mixedCaseScope = { ...scope, sessionKey: "AGENT:MAIN:MAIN" };

      await adapter.upsertSessionEntry(scope, {
        model: "gpt-5.5",
        sessionId: "exact-session",
        updatedAt: 10,
      });

      expect(adapter.loadSessionEntry(mixedCaseScope)).toMatchObject({
        model: "gpt-5.5",
        sessionId: "exact-session",
      });
      expect(adapter.loadExactSessionEntry(mixedCaseScope)).toBeUndefined();
      expect(adapter.loadExactSessionEntry(scope)).toEqual({
        sessionKey: "agent:main:main",
        entry: expect.objectContaining({
          model: "gpt-5.5",
          sessionId: "exact-session",
        }),
      });
    });

    it("conforms for lifecycle entry and transcript cleanup", async () => {
      const nowMs = Date.now();
      const oldTimestamp = nowMs - 600_000;
      const usesSqliteStore = adapter.usesSqliteStore;
      const cleanupStorePath = usesSqliteStore
        ? path.join(paths.stateDir, "agents", "main", "sessions", "sessions.json")
        : paths.storePath;
      const scopedEntry = (sessionKey: string): SessionAccessScope => ({
        ...adapter.entryScope(paths),
        sessionKey,
        storePath: cleanupStorePath,
      });
      const scopedTranscript = (
        sessionKey: string,
        sessionId: string,
      ): SessionTranscriptAccessScope => ({
        ...adapter.transcriptScope(paths, sessionId),
        sessionKey,
        storePath: cleanupStorePath,
      });
      const writeTranscript = async (params: {
        sessionKey: string;
        sessionId: string;
        old?: boolean;
      }) => {
        const timestamp = params.old ? oldTimestamp : nowMs;
        const event = {
          id: `${params.sessionId}-event`,
          marker: "lifecycle-marker-run",
          timestamp: new Date(timestamp).toISOString(),
          type: "metadata",
        };
        if (usesSqliteStore) {
          await adapter.appendTranscriptEvent(
            scopedTranscript(params.sessionKey, params.sessionId),
            event,
          );
          return;
        }
        const transcriptPath = path.join(
          path.dirname(cleanupStorePath),
          `${params.sessionId}.jsonl`,
        );
        fs.writeFileSync(transcriptPath, `${JSON.stringify(event)}\n`, "utf-8");
        if (params.old) {
          const oldDate = new Date(oldTimestamp);
          fs.utimesSync(transcriptPath, oldDate, oldDate);
        }
      };

      await adapter.replaceSessionEntry(scopedEntry("agent:main:lifecycle-cleanup-missing"), {
        sessionId: "missing-lifecycle",
        updatedAt: oldTimestamp,
      });
      await adapter.replaceSessionEntry(scopedEntry("agent:main:lifecycle-cleanup-removed"), {
        sessionId: "removed-lifecycle",
        updatedAt: oldTimestamp,
      });
      await adapter.replaceSessionEntry(scopedEntry("agent:main:lifecycle-cleanup-fresh"), {
        sessionId: "fresh-lifecycle",
        updatedAt: nowMs,
      });
      await adapter.replaceSessionEntry(
        scopedEntry("agent:main:telegram:group:lifecycle-cleanup-room"),
        {
          sessionId: "kept-by-segment",
          updatedAt: oldTimestamp,
        },
      );
      await adapter.replaceSessionEntry(scopedEntry("agent:main:regular"), {
        sessionId: "referenced",
        updatedAt: oldTimestamp,
      });
      await writeTranscript({
        sessionKey: "agent:main:lifecycle-cleanup-removed",
        sessionId: "removed-lifecycle",
        old: true,
      });
      await writeTranscript({
        sessionKey: "agent:main:lifecycle-cleanup-fresh",
        sessionId: "fresh-lifecycle",
      });
      await writeTranscript({
        sessionKey: "agent:main:regular",
        sessionId: "referenced",
        old: true,
      });
      await writeTranscript({
        sessionKey: "agent:main:orphan",
        sessionId: "orphan-lifecycle",
        old: true,
      });

      for (const sessionKey of [
        "agent:main:lifecycle-cleanup-missing",
        "agent:main:lifecycle-cleanup-removed",
        "agent:main:telegram:group:lifecycle-cleanup-room",
        "agent:main:regular",
      ]) {
        expect(adapter.readSessionUpdatedAtCore(scopedEntry(sessionKey))).toBe(oldTimestamp);
      }
      expect(
        adapter.readSessionUpdatedAtCore(scopedEntry("agent:main:lifecycle-cleanup-fresh")),
      ).toBe(nowMs);

      await expect(
        adapter.cleanupSessionLifecycleArtifactsCore({
          storePath: cleanupStorePath,
          sessionKeySegmentPrefix: "lifecycle-cleanup-",
          transcriptContentMarker: "lifecycle-marker-",
          orphanTranscriptMinAgeMs: 300_000,
          nowMs,
        }),
      ).resolves.toEqual({
        // Only the removed entry's transcript is archived: the orphan's node
        // still targets it, and node-referenced history is retained.
        removedEntries: 2,
        archivedTranscriptArtifacts: 1,
      });

      expect(
        adapter.loadSessionEntry(scopedEntry("agent:main:lifecycle-cleanup-missing")),
      ).toBeUndefined();
      expect(
        adapter.loadSessionEntry(scopedEntry("agent:main:lifecycle-cleanup-removed")),
      ).toBeUndefined();
      expect(
        adapter.loadSessionEntry(scopedEntry("agent:main:lifecycle-cleanup-fresh")),
      ).toMatchObject({
        sessionId: "fresh-lifecycle",
      });
      expect(
        adapter.loadSessionEntry(scopedEntry("agent:main:telegram:group:lifecycle-cleanup-room")),
      ).toMatchObject({ sessionId: "kept-by-segment" });
      expect(adapter.loadSessionEntry(scopedEntry("agent:main:regular"))).toMatchObject({
        sessionId: "referenced",
      });
      if (usesSqliteStore) {
        expect(fs.existsSync(cleanupStorePath)).toBe(false);
        const database = openOpenClawAgentDatabase({
          agentId: "main",
          env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
          path: path.join(paths.stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
        });
        const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
        const removedRoute = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("session_nodes")
            .select("current_session_id")
            .where("session_key", "=", "agent:main:lifecycle-cleanup-removed"),
        );
        expect(removedRoute).toBeUndefined();
        const freshRoute = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("session_nodes")
            .select("current_session_id")
            .where("session_key", "=", "agent:main:lifecycle-cleanup-fresh"),
        );
        expect(freshRoute).toEqual({ current_session_id: "fresh-lifecycle" });
        await expect(
          adapter.loadTranscriptEvents(scopedTranscript("agent:main:regular", "referenced")),
        ).resolves.not.toEqual([]);
        await expect(
          adapter.loadTranscriptEvents(
            scopedTranscript("agent:main:lifecycle-cleanup-removed", "removed-lifecycle"),
          ),
        ).resolves.toEqual([]);
        const files = fs.readdirSync(path.dirname(cleanupStorePath));
        const removedArchive = files.find((file) =>
          file.startsWith("removed-lifecycle.jsonl.deleted."),
        );
        const orphanArchive = files.find((file) =>
          file.startsWith("orphan-lifecycle.jsonl.deleted."),
        );
        expect(removedArchive).toBeDefined();
        // Route-referenced orphan history is retained in SQLite, not archived.
        expect(orphanArchive).toBeUndefined();
        await expect(
          adapter.loadTranscriptEvents(scopedTranscript("agent:main:orphan", "orphan-lifecycle")),
        ).resolves.not.toEqual([]);
        expect(
          readSessionArchiveContentSync(
            path.join(path.dirname(cleanupStorePath), removedArchive ?? ""),
          )
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual([
          expect.objectContaining({
            id: "removed-lifecycle-event",
            marker: "lifecycle-marker-run",
          }),
        ]);
      } else {
        const files = fs.readdirSync(path.dirname(cleanupStorePath));
        expect(
          files.filter((file) => file.startsWith("removed-lifecycle.jsonl.deleted.")),
        ).toHaveLength(1);
        expect(
          files.filter((file) => file.startsWith("orphan-lifecycle.jsonl.deleted.")),
        ).toHaveLength(1);
        expect(files).toContain("fresh-lifecycle.jsonl");
        expect(files).toContain("referenced.jsonl");
      }
    });

    it("conforms for raw transcript event load and append", async () => {
      const scope = adapter.transcriptScope(paths);
      const readScope = adapter.transcriptReadScope(paths);
      const event = {
        id: "event-1",
        parentId: null,
        payload: { content: "hello" },
        type: "metadata",
      };

      await adapter.appendTranscriptEvent(scope, { type: "session", sessionId: "session-1" });
      await adapter.appendTranscriptEvent(scope, event);

      await expect(adapter.loadTranscriptEvents(readScope)).resolves.toEqual([
        { type: "session", sessionId: "session-1" },
        event,
      ]);
    });

    it("loads raw SQLite transcript events synchronously through a read scope", async () => {
      const scope = sqliteAdapter.transcriptScope(paths);
      const readScope = sqliteAdapter.transcriptReadScope(paths);
      const event = {
        id: "event-1",
        parentId: null,
        payload: { content: "hello" },
        type: "metadata",
      };

      await sqliteAdapter.appendTranscriptEvent(scope, event);

      expect(loadTranscriptEventsSync(readScope)).toEqual([event]);
    });

    it("maps canonical sessions.json store paths to the agent SQLite database", async () => {
      const legacyStorePath = path.join(
        paths.stateDir,
        "agents",
        "voice",
        "sessions",
        "sessions.json",
      );
      const sqlitePath = path.join(
        paths.stateDir,
        "agents",
        "voice",
        "agent",
        "openclaw-agent.sqlite",
      );
      const scope = {
        env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
        sessionKey: "agent:voice:voice:123",
        storePath: legacyStorePath,
      };

      await upsertSessionEntryCore(scope, {
        model: "gpt-5.5",
        sessionId: "session-1",
        updatedAt: 10,
      });

      expect(loadSessionEntry({ ...scope, agentId: "voice", storePath: sqlitePath })).toMatchObject(
        {
          model: "gpt-5.5",
          sessionId: "session-1",
        },
      );
      expect(fs.existsSync(sqlitePath)).toBe(true);
      expect(fs.existsSync(legacyStorePath)).toBe(false);
      expect(
        listSessionEntryRows({
          env: scope.env,
          storePath: sqlitePath,
        }),
      ).toEqual([
        expect.objectContaining({
          entry: expect.objectContaining({ sessionId: "session-1" }),
          sessionKey: "agent:voice:voice:123",
        }),
      ]);
      expect(() => loadSessionEntry({ ...scope, agentId: "main", storePath: sqlitePath })).toThrow(
        "belongs to agent voice; requested agent main",
      );
    });

    it("keeps custom JSON store paths beside their SQLite database", async () => {
      const customStorePath = path.join(paths.tempDir, "custom-sessions.json");
      const sqlitePath = path.join(paths.tempDir, "custom-sessions.voice.sqlite");
      const scope = {
        env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
        sessionKey: "agent:voice:main",
        storePath: customStorePath,
      };

      await upsertSessionEntryCore(scope, {
        model: "gpt-5.5",
        sessionId: "session-1",
        updatedAt: 10,
      });

      expect(loadSessionEntry({ ...scope, agentId: "voice", storePath: sqlitePath })).toMatchObject(
        {
          model: "gpt-5.5",
          sessionId: "session-1",
        },
      );
      expect(fs.existsSync(sqlitePath)).toBe(true);
      expect(fs.existsSync(customStorePath)).toBe(false);
    });

    it("uses the requested agent for custom sessions.json SQLite targets", async () => {
      const customStorePath = path.join(paths.tempDir, "custom-store", "sessions.json");
      const customSqlitePath = path.join(
        path.dirname(customStorePath),
        "openclaw-agent.support.sqlite",
      );
      const scope = {
        agentId: "support",
        env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
        sessionKey: "agent:support:main",
        storePath: customStorePath,
      };

      await upsertSessionEntryCore(scope, {
        model: "gpt-5.5",
        sessionId: "support-session",
        updatedAt: 10,
      });
      const runtimeTarget = await resolveSessionTranscriptRuntimeTarget({
        ...scope,
        sessionId: "support-session",
      });

      expect(loadSessionEntry({ ...scope, storePath: customSqlitePath })).toMatchObject({
        model: "gpt-5.5",
        sessionId: "support-session",
      });
      expect(fs.existsSync(customSqlitePath)).toBe(true);
      expect(runtimeTarget).toMatchObject({
        agentId: "support",
        sessionId: "support-session",
        sessionKey: scope.sessionKey,
        storePath: customStorePath,
      });
    });

    it("parses only the selected SQLite entry across keyed loads", async () => {
      const scope = sqliteAdapter.entryScope(paths);
      for (let index = 0; index < 20; index += 1) {
        await upsertSessionEntryCore(
          {
            ...scope,
            sessionKey: `agent:main:unrelated-${index}`,
          },
          {
            model: `model-${index}`,
            sessionId: `unrelated-session-${index}`,
            updatedAt: index + 1,
          },
        );
      }
      await upsertSessionEntryCore(scope, {
        model: "target",
        sessionId: "target-session",
        updatedAt: 100,
      });
      const parseSpy = vi.spyOn(JSON, "parse");
      const targetEntryParseCount = () =>
        parseSpy.mock.calls.filter(
          ([json]) =>
            typeof json === "string" &&
            json.includes('"sessionId":"target-session"') &&
            json.includes('"model":"target"'),
        ).length;

      try {
        expect(loadSessionEntry(scope)).toMatchObject({
          model: "target",
          sessionId: "target-session",
        });
        expect(targetEntryParseCount()).toBe(1);
        expect(
          parseSpy.mock.calls.some(
            ([json]) =>
              typeof json === "string" && json.includes('"sessionId":"unrelated-session-'),
          ),
        ).toBe(false);
        expect(loadSessionEntry(scope)).toMatchObject({
          model: "target",
          sessionId: "target-session",
        });
        expect(targetEntryParseCount()).toBe(2);
      } finally {
        parseSpy.mockRestore();
      }
    });

    it("prunes stale SQLite entries below the entry cap without parsing on every write", async () => {
      const scope = sqliteAdapter.entryScope(paths);
      const staleScope = {
        ...scope,
        sessionKey: "agent:main:stale-under-cap",
      };
      await replaceSessionEntry(staleScope, {
        model: "stale",
        sessionId: "stale-under-cap",
        updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
      });

      await upsertSessionEntryCore(scope, {
        model: "fresh",
        sessionId: "fresh-session",
        updatedAt: Date.now(),
      });

      expect(loadSessionEntry(staleScope)).toBeUndefined();
      expect(loadSessionEntry(scope)).toMatchObject({
        model: "fresh",
        sessionId: "fresh-session",
      });
    });

    it("serializes concurrent SQLite entry patches", async () => {
      const scope = sqliteAdapter.entryScope(paths);

      await upsertSessionEntryCore(scope, {
        model: "base",
        sessionId: "patch-session",
        updatedAt: 10,
      });

      let firstPatch!: Promise<SessionEntry | null>;
      let releasePatch!: () => void;
      const patchStarted = new Promise<void>((resolve) => {
        const blockedPatch = new Promise<void>((release) => {
          releasePatch = release;
        });
        firstPatch = patchSessionEntryCore(scope, async () => {
          resolve();
          await blockedPatch;
          return { model: "first" };
        });
      });
      await patchStarted;
      const secondPatch = patchSessionEntryCore(scope, () => ({
        providerOverride: "openai",
      }));
      releasePatch();
      await Promise.all([firstPatch, secondPatch]);

      expect(loadSessionEntry(scope)).toMatchObject({
        model: "first",
        providerOverride: "openai",
      });
    });

    it("does not hold a write transaction while awaiting a SQLite entry updater", async () => {
      if (adapter !== sqliteAdapter) {
        return;
      }
      const scope = sqliteAdapter.entryScope(paths);
      await replaceSessionEntry(scope, {
        model: "base",
        sessionId: "transaction-gap",
        updatedAt: 10,
      });

      let releaseUpdater!: () => void;
      let markUpdaterStarted!: () => void;
      const updaterStarted = new Promise<void>((resolve) => {
        markUpdaterStarted = resolve;
      });
      const updaterGate = new Promise<void>((resolve) => {
        releaseUpdater = resolve;
      });
      const pendingPatch = patchSessionEntryCore(scope, async () => {
        markUpdaterStarted();
        await updaterGate;
        return { model: "patched" };
      });

      await updaterStarted;
      let unrelatedWriteError: unknown;
      try {
        appendSqliteTrajectoryRuntimeEvents(
          { sessionId: "transaction-gap", storePath: paths.sqlitePath },
          [
            {
              traceSchema: "openclaw-trajectory",
              schemaVersion: 1,
              traceId: "transaction-gap",
              source: "runtime",
              type: "test.concurrent-write",
              ts: "2026-07-09T00:00:00.000Z",
              seq: 1,
              sessionId: "transaction-gap",
            },
          ],
        );
      } catch (error) {
        unrelatedWriteError = error;
      } finally {
        releaseUpdater();
      }

      await expect(pendingPatch).resolves.toMatchObject({ model: "patched" });
      expect(unrelatedWriteError).toBeUndefined();
    });

    it("allows auth and trajectory writers while a session updater is preparing", async () => {
      if (adapter !== sqliteAdapter) {
        return;
      }
      const agentDir = path.join(paths.tempDir, "agents", "main", "agent");
      const conventionalStorePath = path.join(
        paths.tempDir,
        "agents",
        "main",
        "sessions",
        "sessions.json",
      );
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:shared-writers",
        storePath: conventionalStorePath,
      };
      await replaceSessionEntry(scope, {
        model: "base",
        sessionId: "shared-writers",
        updatedAt: 10,
      });

      let releaseUpdater!: () => void;
      let markUpdaterStarted!: () => void;
      const updaterStarted = new Promise<void>((resolve) => {
        markUpdaterStarted = resolve;
      });
      const updaterGate = new Promise<void>((resolve) => {
        releaseUpdater = resolve;
      });
      const pendingPatch = patchSessionEntryCore(scope, async () => {
        markUpdaterStarted();
        await updaterGate;
        return { model: "patched" };
      });

      await updaterStarted;
      writePersistedAuthProfileStateRaw({ selectedProfile: "test" }, agentDir);
      appendSqliteTrajectoryRuntimeEvents(
        { sessionId: "shared-writers", storePath: conventionalStorePath },
        [
          {
            traceSchema: "openclaw-trajectory",
            schemaVersion: 1,
            traceId: "shared-writers",
            source: "runtime",
            type: "test.shared-writers",
            ts: "2026-07-09T00:00:00.000Z",
            seq: 1,
            sessionId: "shared-writers",
          },
        ],
      );
      releaseUpdater();

      await expect(pendingPatch).resolves.toMatchObject({ model: "patched" });
      expect(readPersistedAuthProfileStateRaw(agentDir)).toEqual({ selectedProfile: "test" });
    });

    it("rejects a prepared SQLite entry patch when its source row changes", async () => {
      if (adapter !== sqliteAdapter) {
        return;
      }
      const scope = sqliteAdapter.entryScope(paths);
      await replaceSessionEntry(scope, {
        model: "base",
        sessionId: "stale-prepare",
        updatedAt: 10,
      });

      let releaseUpdater!: () => void;
      let markUpdaterStarted!: () => void;
      const updaterStarted = new Promise<void>((resolve) => {
        markUpdaterStarted = resolve;
      });
      const updaterGate = new Promise<void>((resolve) => {
        releaseUpdater = resolve;
      });
      const pendingPatch = patchSessionEntryCore(scope, async () => {
        markUpdaterStarted();
        await updaterGate;
        return { model: "stale-patch" };
      });

      await updaterStarted;
      let replacementError: unknown;
      try {
        replaceSessionEntrySync(scope, {
          model: "newer",
          sessionId: "stale-prepare",
          updatedAt: 20,
        });
      } catch (error) {
        replacementError = error;
      } finally {
        releaseUpdater();
      }
      const mutationError = await pendingPatch.then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(replacementError).toBeUndefined();
      expect(mutationError).toMatchObject({ name: "SqliteSessionMutationConflictError" });
      expect(loadSessionEntry(scope)).toMatchObject({ model: "newer", updatedAt: 20 });
    });

    it("dedupes SQLite transcript identities inside the writer path", async () => {
      const scope = sqliteAdapter.transcriptScope(paths, "session-dedupe");
      const event = {
        id: "event-dedupe",
        source: "conformance",
        type: "metadata",
      };

      await appendTranscriptEvent(scope, event);
      await appendTranscriptEvent(scope, {
        ...event,
        message: { role: "assistant", content: "duplicate" },
      });
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          appendTranscriptMessage(scope, {
            idempotencyLookup: "scan",
            message: {
              role: "assistant",
              content: "keyed",
              idempotencyKey: "keyed-once",
            },
          }),
        ),
      );

      expect(new Set(results.map((result) => result?.messageId)).size).toBe(1);
      expect(results.filter((result) => result?.appended)).toHaveLength(1);
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        event,
        expect.objectContaining({
          message: expect.objectContaining({ idempotencyKey: "keyed-once" }),
          parentId: null,
          type: "message",
        }),
      ]);
    });

    it("rejects raw message transcript event writes", async () => {
      const scope = adapter.transcriptScope(paths, "session-raw-message");
      await expect(
        adapter.appendTranscriptEvent(scope, {
          id: "raw-message",
          message: { role: "assistant", content: "raw" },
          parentId: null,
          type: "message",
        }),
      ).rejects.toThrow(/use append(?:Sqlite)?TranscriptMessage instead/);
    });

    it("rejects conflicting SQLite transcript messages after default idempotency dedupe", async () => {
      const scope = sqliteAdapter.transcriptScope(paths, "session-unchecked-dedupe");
      const message = {
        role: "assistant",
        content: "unchecked",
        idempotencyKey: "unchecked-once",
      };

      const appended = await appendTranscriptMessage(scope, { message });
      const replayed = await appendTranscriptMessage(scope, { message });
      await expect(
        appendTranscriptMessage(scope, {
          message: {
            ...message,
            content: "unchecked replay",
          },
        }),
      ).rejects.toThrow(/conflicts with the admitted message/u);

      const events = await loadTranscriptEvents(scope);
      const keyedEvents = events.filter((event): event is { message: typeof message } => {
        return (
          Boolean(event) &&
          typeof event === "object" &&
          !Array.isArray(event) &&
          (event as { message?: { idempotencyKey?: string } }).message?.idempotencyKey ===
            "unchecked-once"
        );
      });
      expect(appended).toMatchObject({ appended: true });
      expect(replayed).toMatchObject({
        appended: false,
        message: expect.objectContaining({ content: "unchecked" }),
        messageId: appended?.messageId,
      });
      expect(keyedEvents).toHaveLength(1);
    });

    it("treats replayed SQLite transcript message ids as existing appends", async () => {
      const scope = sqliteAdapter.transcriptScope(paths, "session-event-id-dedupe");
      const eventId = "message-retry-event-id";

      const appended = await appendTranscriptMessage(scope, {
        eventId,
        message: {
          role: "assistant",
          content: "first attempt",
        },
      });
      const replayed = await appendTranscriptMessage(scope, {
        eventId,
        message: {
          role: "assistant",
          content: "first attempt",
        },
      });
      await expect(
        appendTranscriptMessage(scope, {
          eventId,
          message: {
            role: "assistant",
            content: "retry attempt",
          },
        }),
      ).rejects.toThrow(/conflicts with the admitted message/u);

      expect(appended).toMatchObject({
        appended: true,
        messageId: eventId,
      });
      expect(replayed).toMatchObject({
        appended: false,
        message: expect.objectContaining({ content: "first attempt" }),
        messageId: eventId,
      });
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        expect.objectContaining({ type: "session" }),
        expect.objectContaining({
          id: eventId,
          message: expect.objectContaining({ content: "first attempt" }),
          type: "message",
        }),
      ]);
    });

    it("conforms for transcript message append, idempotency, and update publication", async () => {
      const scope = adapter.transcriptScope(paths, "session-2");
      const updates: unknown[] = [];
      const unsubscribe = onSessionTranscriptUpdate((update) => {
        updates.push(update);
      });

      const appended = await adapter.appendTranscriptMessage(scope, {
        cwd: paths.tempDir,
        idempotencyLookup: "scan",
        message: {
          role: "assistant",
          content: "hello",
          idempotencyKey: "assistant-once",
        },
      });
      const replayed = await adapter.appendTranscriptMessage(scope, {
        cwd: paths.tempDir,
        idempotencyLookup: "scan",
        message: {
          role: "assistant",
          content: "hello",
          idempotencyKey: "assistant-once",
        },
      });
      await adapter.publishTranscriptUpdate(scope, {
        agentId: "main",
        message: appended?.message,
        messageId: appended?.messageId,
        sessionKey: scope.sessionKey,
      });
      unsubscribe();

      expect(appended).toMatchObject({
        anchor: {
          entryId: expect.any(String),
          agentId: "main",
          activeMessagePosition: expect.any(Number),
          effectiveParentId: null,
          generation: expect.any(String),
          idempotencyKey: "assistant-once",
          rawSeq: expect.any(Number),
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
          storePath: expect.stringContaining("openclaw-agent.sqlite"),
        },
        appended: true,
        message: expect.objectContaining({ content: "hello" }),
        messageId: expect.any(String),
      });
      expect(replayed).toMatchObject({
        anchor: appended?.anchor,
        appended: false,
        message: expect.objectContaining({
          content: "hello",
          idempotencyKey: "assistant-once",
        }),
        messageId: appended?.messageId,
      });
      expect(replayed?.anchor).toBeDefined();
      expect(replayed?.anchor).toEqual(appended?.anchor);
      await expect(
        adapter.appendTranscriptMessage(scope, {
          cwd: paths.tempDir,
          idempotencyLookup: "scan",
          message: {
            role: "assistant",
            content: "conflicting replay",
            idempotencyKey: "assistant-once",
          },
        }),
      ).rejects.toThrow(/conflicts with the admitted message/u);
      await expect(adapter.loadTranscriptEvents(scope)).resolves.toEqual([
        expect.objectContaining({ type: "session" }),
        expect.objectContaining({
          id: appended?.messageId,
          message: expect.objectContaining({ content: "hello" }),
          type: "message",
        }),
      ]);
      if (adapter.publishesTranscriptUpdates) {
        expect(updates).toEqual([
          expect.objectContaining({
            agentId: "main",
            message: appended?.message,
            messageId: appended?.messageId,
            sessionKey: scope.sessionKey,
          }),
        ]);
      } else {
        expect(updates).toEqual([]);
      }
    });
  },
);

describe("sqlite session normalization", () => {
  let paths: TestPaths;

  beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-sqlite-norm-"));
    paths = {
      sqlitePath: path.join(tempDir, "openclaw-agent.sqlite"),
      stateDir: path.join(tempDir, "state"),
      storePath: path.join(tempDir, "sessions.json"),
      tempDir,
      transcriptPath: path.join(tempDir, "session.jsonl"),
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(paths.tempDir, { recursive: true, force: true });
  });

  it("maintains normalized session node and window rows", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    await upsertSessionEntryCore(
      {
        agentId: "main",
        env,
        sessionKey: "agent:main:group:example",
        storePath: paths.sqlitePath,
      },
      {
        agentHarnessId: "codex",
        chatType: "group",
        delivery: normalizeSessionDeliveryState({
          context: {
            accountId: "acct-1",
            channel: "discord",
            threadId: "thread-1",
            to: "group-1",
          },
        }),
        displayName: "Example group",
        endedAt: 90,
        model: "gpt-5.5",
        modelProvider: "openai",
        parentSessionKey: "agent:main:parent",
        sessionId: "normalized-session",
        sessionStartedAt: 50,
        spawnedBy: "agent:main:spawner",
        startedAt: 60,
        status: "done",
        updatedAt: 100,
      },
    );

    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env,
      path: paths.sqlitePath,
    });
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    const session = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_windows")
        .select([
          "account_id",
          "agent_harness_id",
          "channel",
          "chat_type",
          "created_at",
          "display_name",
          "ended_at",
          "model",
          "model_provider",
          "parent_session_key",
          "session_key",
          "session_scope",
          "spawned_by",
          "started_at",
          "status",
          "updated_at",
        ])
        .where("session_id", "=", "normalized-session"),
    );
    expect(session).toEqual({
      account_id: "acct-1",
      agent_harness_id: "codex",
      channel: "discord",
      chat_type: "group",
      created_at: 50,
      display_name: "Example group",
      ended_at: 90,
      model: "gpt-5.5",
      model_provider: "openai",
      parent_session_key: "agent:main:parent",
      session_key: "agent:main:group:example",
      session_scope: "group",
      spawned_by: "agent:main:spawner",
      started_at: 60,
      status: "done",
      updated_at: expect.any(Number),
    });

    const route = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select(["current_session_id", "updated_at"])
        .where("session_key", "=", "agent:main:group:example"),
    );
    expect(route).toEqual({
      current_session_id: "normalized-session",
      updated_at: expect.any(Number),
    });
  });

  it("marks identity-only row updates pending validation", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    const sessionKey = "agent:main:identity-update";
    await replaceSessionEntry(
      { agentId: "main", env, sessionKey, storePath: paths.sqlitePath },
      { sessionId: "identity-session", updatedAt: 10 },
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: paths.sqlitePath });
    database.db
      .prepare("UPDATE session_nodes SET updated_at = 11 WHERE session_key = ?")
      .run(sessionKey);

    expect(
      database.db
        .prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?")
        .get(sessionKey),
    ).toEqual({ entry_valid: 0 });
  });

  it("exposes same-key rollover lineage when a killed session is replaced", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    const sessionKey = "agent:main:telegram:group:-1003774691294:topic:29020";
    const oldSessionId = "f1321535-878b-47cd-b35e-2f5f4bae2bb5";
    const newSessionId = "c0daccb0-0555-47d8-8747-9b53addf1fe2";
    const scope = {
      agentId: "main",
      env,
      sessionKey,
      storePath: paths.sqlitePath,
    };

    await upsertSessionEntryCore(scope, {
      delivery: normalizeSessionDeliveryState({ context: { channel: "telegram" } }),
      chatType: "group",
      createdVia: "channel",
      createdActor: { type: "human", id: "telegram-sender" },
      createdAt: 1_782_973_390_000,
      displayName: "telegram:g-bucephalus-+-topics",
      forkSource: { sessionKey: "agent:main:main", sessionId: "root-session" },
      sessionId: oldSessionId,
      status: "killed",
      updatedAt: 1_782_973_392_492,
    });
    await appendTranscriptEvent(
      { ...scope, sessionId: oldSessionId },
      {
        id: "old-frontier",
        payload: { label: "old transcript frontier" },
        type: "metadata",
      },
    );

    await upsertSessionEntryCore(scope, {
      delivery: normalizeSessionDeliveryState({ context: { channel: "telegram" } }),
      chatType: "group",
      displayName: "telegram:g-bucephalus-+-topics",
      sessionId: newSessionId,
      status: "running",
      updatedAt: 1_782_997_881_018,
    });
    await appendTranscriptEvent(
      { ...scope, sessionId: newSessionId },
      {
        id: "new-turn",
        payload: { label: "new active turn" },
        type: "metadata",
      },
    );

    await expect(loadTranscriptEvents({ ...scope, sessionId: oldSessionId })).resolves.toEqual([
      expect.objectContaining({ id: "old-frontier", type: "metadata" }),
    ]);
    await expect(loadTranscriptEvents({ ...scope, sessionId: newSessionId })).resolves.toEqual([
      expect.objectContaining({ id: "new-turn", type: "metadata" }),
    ]);
    expect(loadSessionEntry(scope)).toEqual(
      expect.objectContaining({
        sessionId: newSessionId,
        createdVia: "channel",
        createdActor: { type: "human", id: "telegram-sender" },
        createdAt: 1_782_973_390_000,
        forkSource: { sessionKey: "agent:main:main", sessionId: "root-session" },
        previousSessionId: oldSessionId,
        usageFamilyKey: sessionKey,
        usageFamilySessionIds: [oldSessionId, newSessionId],
      }),
    );
  });

  it("keeps exact SQLite replacement entries free of inferred rollover lineage", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    const scope = {
      agentId: "main",
      env,
      sessionKey: "agent:main:restore-exact",
      storePath: paths.sqlitePath,
    };

    await upsertSessionEntryCore(scope, {
      sessionId: "temporary-session",
      updatedAt: 10,
    });
    await replaceSessionEntry(scope, {
      sessionId: "restored-session",
      updatedAt: 20,
    });

    expect(loadSessionEntry(scope)).toEqual({
      sessionId: "restored-session",
      updatedAt: 20,
      delivery: { kind: "none" },
    });
  });

  it("skips parent fork when transcript rows exceed the token budget and entry totals are stale", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    const parentKey = "agent:main:parent";
    const childKey = "agent:main:subagent:child";
    await upsertSessionEntryCore(
      {
        agentId: "main",
        env,
        sessionKey: parentKey,
        storePath: paths.sqlitePath,
      },
      {
        sessionId: "parent-session",
        totalTokens: 1,
        totalTokensFresh: false,
        updatedAt: 10,
      },
    );
    await replaceTranscriptEvents(
      {
        agentId: "main",
        env,
        sessionId: "parent-session",
        sessionKey: parentKey,
        storePath: paths.sqlitePath,
      },
      [
        { type: "session", id: "parent-session", cwd: paths.tempDir },
        {
          type: "message",
          id: "oversized-parent",
          parentId: null,
          message: { role: "user", content: "x".repeat(420_000) },
        },
      ],
    );

    const result = await forkSessionEntryFromParentTarget({
      fallbackEntry: { sessionId: "", updatedAt: 1 },
      parentTarget: { canonicalKey: parentKey, storeKeys: [parentKey] },
      sessionTarget: { canonicalKey: childKey, storeKeys: [childKey] },
      storePath: paths.sqlitePath,
      decisionSkipPatch: () => ({ forkedFromParent: true, updatedAt: 11 }),
    });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "decision-skip",
      decision: {
        status: "skip",
        reason: "parent-too-large",
      },
      sessionEntry: {
        forkedFromParent: true,
        sessionId: "",
        updatedAt: expect.any(Number),
      },
    });
    if (result.status !== "skipped" || result.reason !== "decision-skip") {
      throw new Error(`expected decision-skip, got ${result.status}`);
    }
    expect(result.decision?.parentTokens).toBeGreaterThan(100_000);
  });

  it("does not move current nodes back to stale transcript session ids", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    const scope = {
      agentId: "main",
      env,
      sessionKey: "agent:main:main",
      storePath: paths.sqlitePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: "current-session",
      updatedAt: 20,
    });
    await appendTranscriptEvent(
      {
        ...scope,
        sessionId: "stale-session",
      },
      {
        id: "stale-event",
        timestamp: new Date(10).toISOString(),
        type: "metadata",
      },
    );

    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env,
      path: paths.sqlitePath,
    });
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    const route = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select("current_session_id")
        .where("session_key", "=", "agent:main:main"),
    );
    expect(route).toEqual({ current_session_id: "current-session" });
  });

  it("applies SQLite session-entry maintenance inside entry write transactions", async () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "1d",
          maxEntries: 2,
        },
      },
    });
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    const scopeFor = (sessionKey: string) => ({
      agentId: "main",
      env,
      sessionKey,
      storePath: paths.sqlitePath,
    });
    const oldUpdatedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;

    await patchSessionEntryCore(
      scopeFor("agent:main:stale"),
      () => ({ sessionId: "stale-session", updatedAt: oldUpdatedAt }),
      {
        fallbackEntry: { sessionId: "stale-session", updatedAt: oldUpdatedAt },
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
    await patchSessionEntryCore(
      scopeFor("agent:main:older"),
      () => ({ sessionId: "older-session", updatedAt: oldUpdatedAt + 1 }),
      {
        fallbackEntry: { sessionId: "older-session", updatedAt: oldUpdatedAt + 1 },
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
    await patchSessionEntryCore(
      scopeFor("agent:main:active"),
      () => ({ sessionId: "active-session", updatedAt: Date.now() }),
      {
        fallbackEntry: { sessionId: "active-session", updatedAt: Date.now() },
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
    const staleTranscriptEvent = {
      id: "stale-event",
      timestamp: new Date(oldUpdatedAt).toISOString(),
      type: "metadata",
    };
    await appendTranscriptEvent(
      { ...scopeFor("agent:main:stale"), sessionId: "stale-session" },
      staleTranscriptEvent,
    );

    await patchSessionEntryCore(scopeFor("agent:main:active"), () => ({ model: "gpt-5.5" }), {
      skipMaintenance: true,
    });
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        env,
        sessionId: "stale-session",
        storePath: paths.sqlitePath,
      }),
    ).resolves.toEqual([staleTranscriptEvent]);
    expect(
      listSessionEntryRows({
        agentId: "main",
        env,
        storePath: paths.sqlitePath,
      }).map((summary) => summary.sessionKey),
    ).toEqual(["agent:main:active", "agent:main:older", "agent:main:stale"]);

    const notify = vi.fn();
    const unsubscribe = onSessionIdentityMutation(notify);
    await patchSessionEntryCore(scopeFor("agent:main:active"), () => ({
      providerOverride: "openai",
    }));
    unsubscribe();

    expect(new Set(notify.mock.calls.map(([mutation]) => mutation.previous.sessionId))).toEqual(
      new Set(["older-session", "stale-session"]),
    );
    expect(
      listSessionEntryRows({
        agentId: "main",
        env,
        storePath: paths.sqlitePath,
      }).map((summary) => summary.sessionKey),
    ).toEqual(["agent:main:active"]);
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        env,
        sessionId: "stale-session",
        storePath: paths.sqlitePath,
      }),
    ).resolves.toEqual([]);
    const archivedStale = fs
      .readdirSync(paths.tempDir)
      .filter((file) => file.startsWith("stale-session.jsonl.deleted."));
    expect(archivedStale).toHaveLength(1);
    expect(
      readSessionArchiveContentSync(path.join(paths.tempDir, archivedStale[0] ?? ""))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([staleTranscriptEvent]);

    await patchSessionEntryCore(
      scopeFor("agent:main:newer"),
      () => ({ sessionId: "newer-session", updatedAt: Date.now() + 1 }),
      {
        fallbackEntry: { sessionId: "newer-session", updatedAt: Date.now() + 1 },
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
    await patchSessionEntryCore(
      scopeFor("agent:main:newest"),
      () => ({ sessionId: "newest-session", updatedAt: Date.now() + 2 }),
      {
        fallbackEntry: { sessionId: "newest-session", updatedAt: Date.now() + 2 },
        replaceEntry: true,
      },
    );

    expect(
      listSessionEntryRows({
        agentId: "main",
        env,
        storePath: paths.sqlitePath,
      }).map((summary) => summary.sessionKey),
    ).toEqual(["agent:main:active", "agent:main:newer", "agent:main:newest"]);
  });

  it("keeps protected SQLite rows outside the write-triggered entry allowance", async () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "365d",
          maxEntries: 2,
        },
      },
    });
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    const now = Date.now();
    const scopeFor = (sessionKey: string) => ({
      agentId: "main",
      env,
      sessionKey,
      storePath: paths.sqlitePath,
    });
    const recentSessionId = "recent-dashboard-session-1";
    const recentTranscriptEvent = {
      id: "recent-dashboard-event",
      timestamp: new Date().toISOString(),
      type: "metadata",
    };

    for (const [sessionKey, sessionId, updatedAt] of [
      ["agent:main:archived-1", "archived-session-1", now - 4],
      ["agent:main:archived-2", "archived-session-2", now - 3],
    ] as const) {
      await patchSessionEntryCore(
        scopeFor(sessionKey),
        () => ({ archivedAt: updatedAt, sessionId, updatedAt }),
        {
          fallbackEntry: { archivedAt: updatedAt, sessionId, updatedAt },
          replaceEntry: true,
          skipMaintenance: true,
        },
      );
    }
    await patchSessionEntryCore(
      scopeFor("agent:main:recent-dashboard-1"),
      () => ({ sessionId: recentSessionId, updatedAt: now - 2 }),
      {
        fallbackEntry: { sessionId: recentSessionId, updatedAt: now - 2 },
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
    await appendTranscriptEvent(
      { ...scopeFor("agent:main:recent-dashboard-1"), sessionId: recentSessionId },
      recentTranscriptEvent,
    );
    await patchSessionEntryCore(
      scopeFor("agent:main:recent-dashboard-2"),
      () => ({ sessionId: "recent-dashboard-session-2", updatedAt: now - 1 }),
      {
        fallbackEntry: { sessionId: "recent-dashboard-session-2", updatedAt: now - 1 },
        replaceEntry: true,
        skipMaintenance: true,
      },
    );

    await patchSessionEntryCore(
      scopeFor("agent:main:maintenance-trigger"),
      () => ({ sessionId: "maintenance-trigger-session", updatedAt: now }),
      {
        fallbackEntry: { sessionId: "maintenance-trigger-session", updatedAt: now },
        replaceEntry: true,
      },
    );

    expect(
      listSessionEntryRows({
        agentId: "main",
        env,
        storePath: paths.sqlitePath,
      }).map((summary) => summary.sessionKey),
    ).toEqual([
      "agent:main:archived-1",
      "agent:main:archived-2",
      "agent:main:maintenance-trigger",
      "agent:main:recent-dashboard-1",
      "agent:main:recent-dashboard-2",
    ]);
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        env,
        sessionId: recentSessionId,
        storePath: paths.sqlitePath,
      }),
    ).resolves.toEqual([recentTranscriptEvent]);
  });

  it("preserves pinned SQLite entries and transcripts during write-triggered capping", async () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "365d",
          maxEntries: 2,
        },
      },
    });
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    const scopeFor = (sessionKey: string) => ({
      agentId: "main",
      env,
      sessionKey,
      storePath: paths.sqlitePath,
    });
    const pinnedKey = "agent:main:pinned-dashboard";
    const pinnedSessionId = "pinned-dashboard-session";
    const pinnedTranscriptEvent = {
      id: "pinned-event",
      timestamp: new Date().toISOString(),
      type: "metadata",
    };

    await patchSessionEntryCore(
      scopeFor(pinnedKey),
      () => ({ sessionId: pinnedSessionId, updatedAt: 1, pinnedAt: 2 }),
      {
        fallbackEntry: { sessionId: pinnedSessionId, updatedAt: 1, pinnedAt: 2 },
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
    await appendTranscriptEvent(
      { ...scopeFor(pinnedKey), sessionId: pinnedSessionId },
      pinnedTranscriptEvent,
    );
    await patchSessionEntryCore(
      scopeFor("agent:main:recent-dashboard"),
      () => ({ sessionId: "recent-dashboard-session", updatedAt: 3 }),
      {
        fallbackEntry: { sessionId: "recent-dashboard-session", updatedAt: 3 },
        replaceEntry: true,
        skipMaintenance: true,
      },
    );

    await patchSessionEntryCore(
      scopeFor("agent:main:maintenance-trigger"),
      () => ({ sessionId: "maintenance-trigger-session", updatedAt: 4 }),
      {
        fallbackEntry: { sessionId: "maintenance-trigger-session", updatedAt: 4 },
        replaceEntry: true,
      },
    );

    expect(loadSessionEntry(scopeFor(pinnedKey))).toMatchObject({
      pinnedAt: 2,
      sessionId: pinnedSessionId,
    });
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        env,
        sessionId: pinnedSessionId,
        storePath: paths.sqlitePath,
      }),
    ).resolves.toEqual([pinnedTranscriptEvent]);
  });

  it("preserves an admitted SQLite session when another session triggers maintenance", async () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      session: {
        maintenance: {
          mode: "enforce",
          pruneAfter: "365d",
          maxEntries: 1,
        },
      },
    });
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    const scopeFor = (sessionKey: string) => ({
      agentId: "main",
      env,
      sessionKey,
      storePath: paths.storePath,
    });
    const cronKey = "agent:main:cron:job-1";
    const cronEntry = {
      lifecycleRevision: "cron-revision-1",
      sessionId: "cron-session",
      updatedAt: Date.now(),
    };

    for (const [sessionKey, sessionId] of [
      ["agent:main:slack:channel:c1", "channel-session-1"],
      ["agent:main:slack:channel:c2", "channel-session-2"],
    ] as const) {
      await patchSessionEntryCore(
        scopeFor(sessionKey),
        () => ({ sessionId, updatedAt: Date.now() - 1 }),
        {
          fallbackEntry: { sessionId, updatedAt: Date.now() - 1 },
          replaceEntry: true,
          skipMaintenance: true,
        },
      );
    }

    await patchSessionEntryCore(scopeFor(cronKey), () => cronEntry, {
      fallbackEntry: cronEntry,
      replaceEntry: true,
      skipMaintenance: true,
    });
    const admission = await beginSessionWorkAdmission({
      scope: paths.storePath,
      identities: [cronKey, cronEntry.sessionId],
      assertAllowed: () => {},
    });
    try {
      const triggerKey = "agent:main:maintenance-trigger";
      await patchSessionEntryCore(
        scopeFor(triggerKey),
        () => ({ sessionId: "trigger-session", updatedAt: Date.now() + 1 }),
        {
          fallbackEntry: { sessionId: "trigger-session", updatedAt: Date.now() + 1 },
          replaceEntry: true,
        },
      );

      expect(loadSessionEntry(scopeFor(cronKey))).toMatchObject(cronEntry);
    } finally {
      admission.release();
    }
  });

  it("keeps live entries and transcripts under byte pressure at save time", async () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      session: {
        maintenance: {
          highWaterBytes: 350,
          maxDiskBytes: 1_200,
          maxEntries: 100,
          mode: "enforce",
          pruneAfter: "365d",
        },
      },
    });
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    const scopeFor = (sessionKey: string) => ({
      agentId: "main",
      env,
      sessionKey,
      storePath: paths.sqlitePath,
    });
    const oldUpdatedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const unsharedUpdatedAt = oldUpdatedAt - 1_000;

    await patchSessionEntryCore(
      scopeFor("agent:main:unshared-budget"),
      () => ({ sessionId: "unshared-budget-session", updatedAt: unsharedUpdatedAt }),
      {
        fallbackEntry: { sessionId: "unshared-budget-session", updatedAt: unsharedUpdatedAt },
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
    await appendTranscriptEvent(
      { ...scopeFor("agent:main:unshared-budget"), sessionId: "unshared-budget-session" },
      {
        id: "unshared-budget-event",
        payload: "😀".repeat(400),
        timestamp: new Date(unsharedUpdatedAt).toISOString(),
        type: "metadata",
      },
    );

    await patchSessionEntryCore(
      scopeFor("agent:main:old-budget"),
      () => ({ sessionId: "old-budget-session", updatedAt: oldUpdatedAt }),
      {
        fallbackEntry: { sessionId: "old-budget-session", updatedAt: oldUpdatedAt },
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
    await appendTranscriptEvent(
      { ...scopeFor("agent:main:old-budget"), sessionId: "old-budget-session" },
      {
        id: "old-budget-event",
        payload: "x".repeat(50),
        timestamp: new Date(oldUpdatedAt).toISOString(),
        type: "metadata",
      },
    );
    await patchSessionEntryCore(
      scopeFor("agent:main:active-budget"),
      () => ({
        sessionId: "active-budget-session",
        updatedAt: Date.now(),
        usageFamilySessionIds: ["old-budget-session", "active-budget-session"],
      }),
      {
        fallbackEntry: {
          sessionId: "active-budget-session",
          updatedAt: Date.now(),
          usageFamilySessionIds: ["old-budget-session", "active-budget-session"],
        },
        replaceEntry: true,
        skipMaintenance: true,
      },
    );

    await patchSessionEntryCore(scopeFor("agent:main:active-budget"), () => ({
      modelOverride: "gpt-5.5",
    }));

    // Live sessions are never save-time budget victims: byte pressure is
    // handled by the async physical-budget pass, which only reclaims
    // historical generations no entry, route, or admission references.
    expect(
      listSessionEntryRows({
        agentId: "main",
        env,
        storePath: paths.sqlitePath,
      })
        .map((summary) => summary.sessionKey)
        .toSorted(),
    ).toEqual(["agent:main:active-budget", "agent:main:old-budget", "agent:main:unshared-budget"]);
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        env,
        sessionId: "old-budget-session",
        storePath: paths.sqlitePath,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "old-budget-event",
      }),
    ]);
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        env,
        sessionId: "unshared-budget-session",
        storePath: paths.sqlitePath,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "unshared-budget-event",
      }),
    ]);
    expect(
      fs.readdirSync(paths.tempDir).filter((file) => file.includes(".jsonl.deleted.")),
    ).toEqual([]);
  });

  it("fails loud for delivery-confirmed lowercased SQLite session aliases", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    const canonicalKey = "agent:main:matrix:channel:!MixedCase:example.org";
    const legacyKey = canonicalKey.toLowerCase();
    const entry = {
      delivery: normalizeSessionDeliveryState({
        context: {
          accountId: "acct-1",
          channel: "matrix",
          to: "!MixedCase:example.org",
        },
      }),
      sessionId: "legacy-alias-session",
      updatedAt: 10,
    };
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: paths.sqlitePath });
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(legacyKey, entry.sessionId, JSON.stringify(entry), entry.updatedAt);

    expect(() =>
      loadSessionEntry({
        agentId: "main",
        env,
        sessionKey: canonicalKey,
        storePath: paths.sqlitePath,
      }),
    ).toThrow("openclaw doctor --fix");
    expect(() =>
      listSessionEntryRows({ agentId: "main", env, storePath: paths.sqlitePath }),
    ).toThrow("openclaw doctor --fix");
    await expect(
      appendTranscriptEvent(
        {
          agentId: "main",
          env,
          sessionId: "canonical-transcript-session",
          sessionKey: canonicalKey,
          storePath: paths.sqlitePath,
        },
        { id: "canonical-event", timestamp: new Date(20).toISOString(), type: "metadata" },
      ),
    ).rejects.toThrow("openclaw doctor --fix");
    expect(() =>
      replaceSessionEntrySync(
        { agentId: "main", env, sessionKey: canonicalKey, storePath: paths.sqlitePath },
        { sessionId: "replacement", updatedAt: 20 },
      ),
    ).toThrow("openclaw doctor --fix");
    expect(
      database.db
        .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
        .get(legacyKey),
    ).toEqual({ current_session_id: "legacy-alias-session" });
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ?, entry_valid = -1 WHERE session_key = ?")
      .run("{ malformed", legacyKey);
    await expect(
      appendTranscriptEvent(
        {
          agentId: "main",
          env,
          sessionId: "canonical-transcript-session-2",
          sessionKey: canonicalKey,
          storePath: paths.sqlitePath,
        },
        { id: "canonical-event-2", timestamp: new Date(21).toISOString(), type: "metadata" },
      ),
    ).rejects.toThrow("openclaw doctor --fix");
  });

  it("fails loud for invalid live rows instead of treating them as retained tombstones", () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    const sessionKey = "agent:main:invalid-live-row";
    const sessionId = "invalid-live-session";
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: paths.sqlitePath });
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at) VALUES (?, ?, ?, -1, ?)",
      )
      .run(sessionKey, sessionId, "{ malformed", 10);
    database.db
      .prepare(
        "INSERT INTO session_windows (session_id, session_key, session_scope, reason, created_at, updated_at) VALUES (?, ?, 'conversation', 'initial', 10, 10)",
      )
      .run(sessionId, sessionKey);

    expect(() =>
      listSessionEntryRows({ agentId: "main", env, storePath: paths.sqlitePath }),
    ).toThrow("openclaw doctor --fix");
  });

  it("revalidates an open database after its canonical main key changes", () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    const storePath = paths.sqlitePath;
    replaceSessionEntrySync(
      { agentId: "main", env, sessionKey: "agent:main:main", storePath },
      { sessionId: "main-session", updatedAt: 10 },
    );
    expect(listSessionEntryRows({ agentId: "main", env, storePath })).toHaveLength(1);

    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: paths.sqlitePath });
    setCanonicalSqliteSessionMainKey(database, "work");

    expect(() => listSessionEntryRows({ agentId: "main", env, storePath })).toThrow(
      "openclaw doctor --fix",
    );
  });

  it("fails loud when promoted lineage disagrees with canonical entry JSON", () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    const sessionKey = "agent:main:lineage-mismatch";
    const sessionId = "lineage-mismatch-session";
    const entry = {
      parentSessionKey: "agent:main:json-parent",
      sessionId,
      updatedAt: 10,
    };
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: paths.sqlitePath });
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, parent_session_key) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sessionKey, sessionId, JSON.stringify(entry), 10, "agent:main:column-parent");
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(sessionKey);

    expect(() =>
      listSessionEntryRows({ agentId: "main", env, storePath: paths.sqlitePath }),
    ).toThrow("openclaw doctor --fix");
  });

  it("normalizes missing entry updatedAt before writing root and entry rows", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    await replaceSessionEntry(
      {
        agentId: "main",
        env,
        sessionKey: "agent:main:minimal",
        storePath: paths.sqlitePath,
      },
      {
        sessionId: "minimal-session",
        sessionStartedAt: 123,
      } as SessionEntry,
    );

    const loaded = loadSessionEntry({
      agentId: "main",
      env,
      sessionKey: "agent:main:minimal",
      storePath: paths.sqlitePath,
    });
    expect(loaded).toMatchObject({
      sessionId: "minimal-session",
      sessionStartedAt: 123,
      updatedAt: 123,
    });

    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env,
      path: paths.sqlitePath,
    });
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_windows as sw")
        .innerJoin("session_nodes as sn", "sn.current_session_id", "sw.session_id")
        .select([
          "sw.created_at as window_created_at",
          "sw.updated_at as window_updated_at",
          "sn.entry_json",
          "sn.updated_at as node_updated_at",
        ])
        .where("sw.session_id", "=", "minimal-session"),
    );
    expect(row).toEqual({
      entry_json: JSON.stringify({
        sessionId: "minimal-session",
        sessionStartedAt: 123,
        delivery: { kind: "none" },
        updatedAt: 123,
      }),
      node_updated_at: 123,
      window_created_at: 123,
      window_updated_at: 123,
    });

    await upsertSessionEntryCore(
      {
        agentId: "main",
        env,
        sessionKey: "agent:main:minimal-upsert",
        storePath: paths.sqlitePath,
      },
      {
        sessionId: "minimal-upsert-session",
      },
    );
    const upsertRow = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select(["entry_json", "updated_at"])
        .where("session_key", "=", "agent:main:minimal-upsert"),
    );
    const upsertEntry = JSON.parse(upsertRow?.entry_json ?? "{}") as Partial<SessionEntry>;
    expect(upsertEntry).toMatchObject({
      sessionId: "minimal-upsert-session",
      updatedAt: expect.any(Number),
    });
    expect(upsertRow?.updated_at).toBe(upsertEntry.updatedAt);
  });

  it("branches a checkpoint by copying SQLite rows and creating the entry transactionally", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    const sourceScope = {
      agentId: "main",
      env,
      sessionId: "source-session",
      sessionKey: "agent:main:main",
      storePath: paths.sqlitePath,
    };
    const preCompactionScope = {
      ...sourceScope,
      sessionId: "pre-compaction-session",
    };
    const sourceEntryScope = {
      agentId: "main",
      env,
      sessionKey: "agent:main:main",
      storePath: paths.sqlitePath,
    };
    const branchKey = "agent:main:checkpoint-branch";
    const checkpoint: SessionCompactionCheckpoint = {
      checkpointId: "checkpoint-branch",
      sessionKey: sourceEntryScope.sessionKey,
      sessionId: "source-session",
      createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
      reason: "manual",
      tokensBefore: 42,
      tokensAfter: 84,
      tokensVersion: 1,
      preCompaction: {
        sessionId: "pre-compaction-session",
        leafId: "pre-msg",
      },
      postCompaction: {
        sessionId: "source-session",
        entryId: "msg-2",
      },
    };

    await replaceTranscriptEvents(preCompactionScope, [
      { type: "session", id: "pre-compaction-session", cwd: paths.tempDir },
      { type: "message", id: "pre-msg", parentId: null, message: { content: "pre" } },
    ]);
    await replaceTranscriptEvents(sourceScope, [
      { type: "session", id: "source-session", cwd: paths.tempDir },
      { type: "message", id: "post-msg-1", parentId: null, message: { content: "post-one" } },
      {
        type: "message",
        id: "post-msg-2",
        parentId: "post-msg-1",
        message: { content: "post-two" },
      },
    ]);
    const sourceEntry: InternalSessionEntry = {
      label: "Source",
      lifecycleRunId: "source-run",
      sessionId: "source-session",
      updatedAt: 10,
      compactionCheckpoints: [checkpoint],
    };
    await upsertSessionEntryCore(sourceEntryScope, sourceEntry);

    const notify = vi.fn();
    const unsubscribe = onSessionIdentityMutation(notify);
    const result = await branchCompactionCheckpointSession({
      agentId: "main",
      env,
      expectedState: sourceEntry,
      storePath: paths.sqlitePath,
      sourceKey: sourceEntryScope.sessionKey,
      nextKey: branchKey,
      checkpointId: checkpoint.checkpointId,
    });
    unsubscribe();
    if (result.status !== "created") {
      throw new Error(`expected branch creation, got ${result.status}`);
    }

    const branchScope = {
      ...sourceScope,
      sessionId: result.entry.sessionId,
      sessionKey: branchKey,
    };
    expect(loadSessionEntry({ ...sourceEntryScope, sessionKey: branchKey })).toEqual(result.entry);
    expect(notify).toHaveBeenCalledWith({
      kind: "create",
      previous: { sessionKeys: [] },
      current: { sessionId: result.entry.sessionId, sessionKeys: [branchKey] },
    });
    expect(result.entry).toEqual(
      expect.objectContaining({
        label: "Source (checkpoint)",
        parentSessionKey: sourceEntryScope.sessionKey,
        totalTokens: 42,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      }),
    );
    expect((result.entry as InternalSessionEntry).lifecycleRunId).toBeUndefined();
    await expect(loadTranscriptEvents(branchScope)).resolves.toEqual([
      expect.objectContaining({ type: "session", id: result.entry.sessionId }),
      expect.objectContaining({ id: "pre-msg", type: "message" }),
    ]);
    expect(fs.existsSync(path.join(paths.tempDir, `${result.entry.sessionId}.jsonl`))).toBe(false);
  });

  it("falls back to post-compaction SQLite rows when no pre-compaction rows exist", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    const sourceScope = {
      agentId: "main",
      env,
      sessionId: "source-session",
      sessionKey: "agent:main:main",
      storePath: paths.sqlitePath,
    };
    const sourceEntryScope = {
      agentId: "main",
      env,
      sessionKey: "agent:main:main",
      storePath: paths.sqlitePath,
    };
    const checkpoint: SessionCompactionCheckpoint = {
      checkpointId: "checkpoint-post-fallback",
      sessionKey: sourceEntryScope.sessionKey,
      sessionId: "source-session",
      createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
      reason: "manual",
      tokensBefore: 100,
      tokensAfter: 25,
      tokensVersion: 1,
      preCompaction: {
        sessionId: "missing-pre-session",
        leafId: "missing-pre-msg",
      },
      postCompaction: {
        sessionId: "source-session",
        entryId: "post-msg",
      },
    };

    await replaceTranscriptEvents(sourceScope, [
      { type: "session", id: "source-session", cwd: paths.tempDir },
      { type: "message", id: "post-msg", parentId: null, message: { content: "post" } },
      { type: "message", id: "skipped-msg", parentId: "post-msg", message: { content: "skip" } },
    ]);
    await upsertSessionEntryCore(sourceEntryScope, {
      sessionId: "source-session",
      updatedAt: 10,
      compactionCheckpoints: [checkpoint],
    });

    const result = await branchCompactionCheckpointSession({
      agentId: "main",
      env,
      expectedState: { sessionId: "source-session", lifecycleRevision: undefined },
      storePath: paths.sqlitePath,
      sourceKey: sourceEntryScope.sessionKey,
      nextKey: "agent:main:checkpoint-post-fallback",
      checkpointId: checkpoint.checkpointId,
    });
    if (result.status !== "created") {
      throw new Error(`expected fallback branch creation, got ${result.status}`);
    }

    await expect(
      loadTranscriptEvents({
        ...sourceScope,
        sessionId: result.entry.sessionId,
        sessionKey: "agent:main:checkpoint-post-fallback",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ type: "session", id: result.entry.sessionId }),
      expect.objectContaining({ id: "post-msg", type: "message" }),
    ]);
    expect(result.entry.totalTokens).toBe(25);
    expect(result.entry.totalTokensVersion).toBe(1);
  });

  it("restores a checkpoint by copying SQLite rows and replacing the entry transactionally", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    const sourceScope = {
      agentId: "main",
      env,
      sessionId: "source-session",
      sessionKey: "agent:main:main",
      storePath: paths.sqlitePath,
    };
    const preCompactionScope = {
      ...sourceScope,
      sessionId: "pre-compaction-session",
    };
    const sourceEntryScope = {
      agentId: "main",
      env,
      sessionKey: "agent:main:main",
      storePath: paths.sqlitePath,
    };
    const checkpoint: SessionCompactionCheckpoint = {
      checkpointId: "checkpoint-restore",
      sessionKey: sourceEntryScope.sessionKey,
      sessionId: "current-session",
      createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
      reason: "manual",
      tokensBefore: 12,
      tokensAfter: 24,
      tokensVersion: 1,
      preCompaction: {
        sessionId: "pre-compaction-session",
        leafId: "pre-msg",
      },
      postCompaction: {
        sessionId: "source-session",
        entryId: "msg-1",
      },
    };

    await replaceTranscriptEvents(preCompactionScope, [
      { type: "session", id: "pre-compaction-session", cwd: paths.tempDir },
      { type: "message", id: "pre-msg", parentId: null, message: { content: "restore" } },
    ]);
    await replaceTranscriptEvents(sourceScope, [
      { type: "session", id: "source-session", cwd: paths.tempDir },
      { type: "message", id: "post-msg-1", parentId: null, message: { content: "skip" } },
      { type: "message", id: "post-msg-2", parentId: "post-msg-1", message: { content: "skip" } },
    ]);
    await upsertSessionEntryCore(sourceEntryScope, {
      label: "Current",
      sessionId: "current-session",
      updatedAt: 10,
      compactionCheckpoints: [checkpoint],
    });

    const result = await restoreCompactionCheckpointSession({
      agentId: "main",
      env,
      expectedState: { sessionId: "current-session", lifecycleRevision: undefined },
      storePath: paths.sqlitePath,
      sessionKey: sourceEntryScope.sessionKey,
      checkpointId: checkpoint.checkpointId,
    });
    if (result.status !== "created") {
      throw new Error(`expected restore creation, got ${result.status}`);
    }

    const restoredScope = {
      ...sourceScope,
      sessionId: result.entry.sessionId,
    };
    expect(loadSessionEntry(sourceEntryScope)).toEqual(result.entry);
    expect(result.entry).toEqual(
      expect.objectContaining({
        label: "Current",
        compactionCheckpoints: [checkpoint],
        totalTokens: 12,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      }),
    );
    await expect(loadTranscriptEvents(restoredScope)).resolves.toEqual([
      expect.objectContaining({ type: "session", id: result.entry.sessionId }),
      expect.objectContaining({ id: "pre-msg", type: "message" }),
    ]);
    expect(fs.existsSync(path.join(paths.tempDir, `${result.entry.sessionId}.jsonl`))).toBe(false);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
