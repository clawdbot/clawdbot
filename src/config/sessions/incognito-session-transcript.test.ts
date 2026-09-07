import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  closeOpenClawAgentDatabasesForTest,
  inspectOpenClawAgentDatabaseOwner,
  listOpenClawRegisteredAgentDatabases,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { resolveSessionStorePathCore } from "./paths.js";
import {
  createSessionEntryWithTranscript,
  listSessionEntriesCore,
  loadSessionEntry,
  loadTranscriptEvents,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
  resolveSessionEntryCandidateTarget,
  resolveSessionTranscriptRuntimeTarget,
} from "./session-accessor.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";

const sessionKey = "agent:main:dashboard:incognito-round-trip";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("session creation scope", () => {
  let ambient: OpenClawTestState;
  let explicit: OpenClawTestState;
  const agentId = "secondary";
  const key = "agent:secondary:dashboard:incognito-fresh-session";

  beforeEach(async () => {
    ambient = await createOpenClawTestState({ prefix: "session-creation-env-ambient-" });
    explicit = await createOpenClawTestState({
      prefix: "session-creation-env-explicit-",
      applyEnv: false,
    });
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await explicit.cleanup();
    await ambient.cleanup();
  });

  it.each(["ambient", "omitted", "sentinel", "durable"] as const)(
    "creates and reloads a secondary transcript without disk state (%s store scope)",
    async (variant) => {
      const state = variant === "ambient" ? ambient : explicit;
      const env = variant === "ambient" ? undefined : explicit.env;
      const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
      const scope = {
        agentId,
        env,
        sessionKey: ` ${key} `,
        ...(variant === "sentinel"
          ? { storePath: sentinel }
          : variant === "durable"
            ? { storePath: state.statePath("ignored.sqlite") }
            : {}),
      };
      const entry = { incognito: true as const, sessionId: "created-incognito", updatedAt: 1 };
      expect(process.env.OPENCLAW_STATE_DIR).toBe(ambient.stateDir);
      expect(explicit.stateDir).not.toBe(ambient.stateDir);

      const created = await createSessionEntryWithTranscript(
        scope,
        ({ existingEntry, targetEntry, isLabelInUse }) => {
          expect(existingEntry).toBeUndefined();
          expect(targetEntry).toBeUndefined();
          expect(isLabelInUse("unused")).toBe(false);
          return { ok: true, entry };
        },
        { cwd: state.workspaceDir },
      );
      expect(created).toEqual({ ok: true, entry, sessionFile: key });
      // Inspect before reading: a bad creation can open the sentinel under the wrong agent.
      expect
        .soft(inspectOpenClawAgentDatabaseOwner(sentinel))
        .toEqual({ status: "owned", agentId });
      expect.soft(fs.readdirSync(explicit.stateDir, { recursive: true })).toEqual([]);
      expect.soft(fs.readdirSync(ambient.stateDir, { recursive: true })).toEqual([]);

      const transcriptScope = { ...scope, sessionKey: key, sessionId: entry.sessionId };
      await expect(resolveSessionTranscriptRuntimeTarget(transcriptScope)).resolves.toEqual({
        agentId,
        sessionId: entry.sessionId,
        sessionKey: key,
        storePath: sentinel,
      });
      await expect(loadTranscriptEvents(transcriptScope)).resolves.toEqual([
        expect.objectContaining({ type: "session", id: entry.sessionId, cwd: state.workspaceDir }),
      ]);
      expect(
        resolveSessionEntryCandidateTarget({
          agentId,
          env,
          cfg: {},
          candidateKeys: [key],
        }),
      ).toMatchObject({ agentId, sessionKey: key, persisted: true, entry });

      const updated = { ...entry, label: "recreated", updatedAt: 2 };
      await expect(
        createSessionEntryWithTranscript(scope, ({ existingEntry, targetEntry, isLabelInUse }) => {
          expect(existingEntry).toMatchObject(entry);
          expect(targetEntry).toMatchObject(entry);
          expect(isLabelInUse("recreated")).toBe(false);
          return { ok: true, entry: updated };
        }),
      ).resolves.toMatchObject({ ok: true, sessionFile: key });
      expect(loadSessionEntry(scope)).toMatchObject(updated);

      closeOpenClawAgentDatabasesForTest();
      expect(loadSessionEntry(scope)).toBeUndefined();
      await expect(loadTranscriptEvents(transcriptScope)).resolves.toEqual([]);
      expect(fs.readdirSync(explicit.stateDir, { recursive: true })).toEqual([]);
      expect(fs.readdirSync(ambient.stateDir, { recursive: true })).toEqual([]);
    },
  );

  it.each(["default", "exact", "custom"] as const)(
    "preserves durable storage and physical ownership (%s store)",
    async (variant) => {
      const storePath =
        variant === "default"
          ? undefined
          : explicit.statePath(variant === "exact" ? "shared.sqlite" : "custom/sessions.json");
      const databasePath =
        variant === "default"
          ? explicit.statePath("agents/secondary/agent/openclaw-agent.sqlite")
          : variant === "exact"
            ? explicit.statePath("shared.sqlite")
            : explicit.statePath("custom/openclaw-agent.secondary.sqlite");
      const physicalOwner = variant === "exact" ? "main" : agentId;
      const scope = {
        agentId,
        env: explicit.env,
        sessionKey: "agent:secondary:dashboard:durable-created",
        storePath,
      };
      const entry = { sessionId: "durable-created", updatedAt: 1 };
      await expect(
        createSessionEntryWithTranscript(scope, () => ({ ok: true, entry })),
      ).resolves.toMatchObject({ ok: true, sessionFile: scope.sessionKey });

      expect(inspectOpenClawAgentDatabaseOwner(databasePath)).toEqual({
        status: "owned",
        agentId: physicalOwner,
      });
      expect(listOpenClawRegisteredAgentDatabases({ env: explicit.env })).toEqual([
        expect.objectContaining({ agentId: physicalOwner, path: databasePath }),
      ]);
      expect(fs.existsSync(databasePath)).toBe(true);
      closeOpenClawAgentDatabasesForTest();
      expect(loadSessionEntry(scope)).toMatchObject(entry);
      await expect(loadTranscriptEvents({ ...scope, sessionId: entry.sessionId })).resolves.toEqual(
        [expect.objectContaining({ type: "session", id: entry.sessionId })],
      );
      expect(fs.readdirSync(ambient.stateDir, { recursive: true })).toEqual([]);
    },
  );

  it.each(["header", "entry"] as const)(
    "does not commit the protected %s mutation after authority is revoked",
    async (rejectedPhase) => {
      const scope = { agentId, env: explicit.env, sessionKey: key };
      const original = { incognito: true as const, sessionId: "original", updatedAt: 1 };
      await expect(
        createSessionEntryWithTranscript(scope, () => ({ ok: true, entry: original })),
      ).resolves.toMatchObject({ ok: true });
      const next = { ...original, sessionId: "rejected", updatedAt: 2 };
      const nextScope = { ...scope, sessionId: next.sessionId };
      const revoked = new Error("creation authority revoked");

      await expect(
        createSessionEntryWithTranscript(scope, () => ({ ok: true, entry: next }), {
          commitGuard: () => {
            const headerCommitted = loadTranscriptEventsSync(nextScope).length > 0;
            if (rejectedPhase === "header" || headerCommitted) {
              throw revoked;
            }
          },
        }),
      ).rejects.toBe(revoked);
      expect(loadSessionEntry(scope)).toMatchObject(original);
      // Header and lifecycle commits are separate; a later refusal protects the entry mutation.
      expect(loadTranscriptEventsSync(nextScope)).toEqual(
        rejectedPhase === "header"
          ? []
          : [expect.objectContaining({ type: "session", id: next.sessionId })],
      );
      expect(fs.readdirSync(explicit.stateDir, { recursive: true })).toEqual([]);
      expect(fs.readdirSync(ambient.stateDir, { recursive: true })).toEqual([]);
    },
  );
});

describe("incognito transcript access", () => {
  it("round-trips two turns through the normal marker-backed SessionManager", async () => {
    const cwd = fs.realpathSync(
      fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "incognito-turns-")),
    );
    try {
      const created = await createSessionEntryWithTranscript(
        { agentId: "main", sessionKey },
        () => ({
          ok: true as const,
          entry: {
            incognito: true as const,
            sessionId: "incognito-session",
            updatedAt: 1,
          },
        }),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const durableStorePath = path.join(cwd, "sessions.json");
      expect(
        loadSessionEntry({
          agentId: "main",
          sessionKey,
          storePath: durableStorePath,
        })?.incognito,
      ).toBe(true);
      expect(fs.existsSync(durableStorePath)).toBe(false);

      const target = {
        agentId: "main",
        sessionId: created.entry.sessionId,
        sessionKey,
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      const firstTurn = SessionManager.open(target, cwd);
      firstTurn.appendMessage({ role: "user", content: "first question", timestamp: 1 });
      firstTurn.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-test",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      });

      const secondTurn = SessionManager.open(target, cwd);
      secondTurn.appendMessage({ role: "user", content: "second question", timestamp: 3 });
      const messages = secondTurn.buildSessionContext().messages;

      expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
      expect(messages[0]).toMatchObject({ content: "first question" });
      expect(messages[2]).toMatchObject({ content: "second question" });
    } finally {
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("prunes incognito transcripts in process without publishing a disk archive", async () => {
    const stateDir = fs.realpathSync(
      fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "incognito-maintenance-")),
    );
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
    const archiveDirectory = path.join(path.dirname(path.dirname(storePath)), "sessions");
    const staleScope = {
      agentId: "main",
      env,
      sessionKey: "agent:main:dashboard:incognito-stale",
      storePath,
    };
    const activeScope = {
      agentId: "main",
      env,
      sessionKey: "agent:main:dashboard:incognito-active",
      storePath,
    };
    const now = Date.now();
    const staleUpdatedAt = now - 366 * 24 * 60 * 60 * 1000;

    try {
      await patchSessionEntryCore(
        staleScope,
        () => ({ sessionId: "incognito-stale-session", updatedAt: staleUpdatedAt }),
        {
          fallbackEntry: { sessionId: "incognito-stale-session", updatedAt: staleUpdatedAt },
          replaceEntry: true,
          skipMaintenance: true,
        },
      );
      await replaceTranscriptEvents({ ...staleScope, sessionId: "incognito-stale-session" }, [
        {
          id: "incognito-stale-event",
          timestamp: new Date(now).toISOString(),
          type: "metadata",
        },
      ]);
      await patchSessionEntryCore(
        activeScope,
        () => ({ sessionId: "incognito-active-session", updatedAt: now + 1 }),
        {
          fallbackEntry: { sessionId: "incognito-active-session", updatedAt: now + 1 },
          replaceEntry: true,
          skipMaintenance: true,
        },
      );

      await patchSessionEntryCore(activeScope, () => ({ model: "gpt-test" }), {
        maintenanceConfig: {
          archiveDashboardAfterMs: null,
          highWaterBytes: null,
          maxDiskBytes: null,
          maxEntries: 1,
          mode: "enforce",
          modelRunPruneAfterMs: 24 * 60 * 60 * 1000,
          pruneAfterMs: 365 * 24 * 60 * 60 * 1000,
          resetArchiveRetentionMs: null,
        },
      });

      await vi.waitFor(() => {
        expect(
          listSessionEntriesCore({ agentId: "main", env, storePath }).map(
            (summary) => summary.sessionKey,
          ),
        ).toEqual([activeScope.sessionKey]);
      });
      await expect(
        loadTranscriptEvents({
          ...staleScope,
          sessionId: "incognito-stale-session",
        }),
      ).resolves.toEqual([]);
      expect(fs.existsSync(storePath)).toBe(false);
      expect(fs.existsSync(archiveDirectory)).toBe(false);
    } finally {
      closeOpenClawAgentDatabasesForTest();
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });
});
