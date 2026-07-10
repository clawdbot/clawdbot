import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  applySessionEntryReplacements,
  appendTranscriptMessage,
  appendTranscriptEvent,
  applySessionEntryLifecycleMutation,
  applySessionPatchProjection,
  branchSessionFromCompactionCheckpoint,
  canonicalizeSessionEntryAliases,
  cleanupSessionLifecycleArtifacts,
  commitReplySessionInitialization,
  createSessionEntryWithTranscript,
  findTranscriptEvent,
  listSessionEntries,
  loadReplySessionInitializationSnapshot,
  loadSessionEntry,
  loadTranscriptEvents,
  markSessionAbortTarget,
  openSessionEntryReadView,
  patchSessionEntry,
  persistSessionResetLifecycle,
  persistSessionTranscriptTurn,
  purgeDeletedAgentSessionEntries,
  publishTranscriptUpdate,
  readSessionUpdatedAt,
  recordInboundSessionMeta,
  replaceSessionEntry,
  resolveSessionEntryCandidateTarget,
  resolveSessionEntryAccessTarget,
  restoreSessionFromCompactionCheckpoint,
  resolveSessionTranscriptReadTarget,
  resolveSessionTranscriptRuntimeReadTarget,
  resolveSessionTranscriptRuntimeTarget,
  trimSessionTranscriptForManualCompact,
  updateResolvedSessionEntry,
  updateSessionEntry,
  updateSessionLastRoute,
  upsertSessionEntry,
} from "./session-accessor.js";
import * as sessionStore from "./store.js";
import { loadSessionStore, saveSessionStore, updateSessionStoreEntry } from "./store.js";
import { withOwnedSessionTranscriptWrites } from "./transcript-write-context.js";
import type { SessionEntry } from "./types.js";

describe("session accessor file-backed seam", () => {
  let tempDir: string;
  let storePath: string;
  let transcriptPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-accessor-"));
    storePath = path.join(tempDir, "sessions.json");
    transcriptPath = path.join(tempDir, "session.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads, lists, and patches session entries without exposing the file store shape", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, {
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: 10,
    });

    expect(loadSessionEntry(scope)).toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: expect.any(Number),
    });
    expect(readSessionUpdatedAt(scope)).toEqual(expect.any(Number));
    expect(listSessionEntries({ storePath })).toEqual([
      {
        sessionKey: "agent:main:main",
        entry: expect.objectContaining({
          model: "gpt-5.5",
          sessionId: "session-1",
          updatedAt: expect.any(Number),
        }),
      },
    ]);

    await upsertSessionEntry(scope, { model: "sonnet-4.6", updatedAt: 20 });

    expect(loadSessionEntry(scope)).toMatchObject({
      model: "sonnet-4.6",
      sessionId: "session-1",
      updatedAt: expect.any(Number),
    });
  });

  it("loads parsed transcript events from explicit and store-derived targets", async () => {
    const header = { type: "session", id: "session-events", timestamp: 1 };
    const message = { type: "message", id: "m1", message: { role: "assistant" } };
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify(header)}\n${JSON.stringify(message)}\nnot-json\n`,
      "utf-8",
    );
    await upsertSessionEntry(
      { sessionKey: "agent:main:main", storePath },
      { sessionId: "session-events", sessionFile: transcriptPath, updatedAt: 10 },
    );

    const explicit = await loadTranscriptEvents({
      sessionFile: transcriptPath,
      sessionId: "session-events",
    });
    expect(explicit).toEqual([header, message]);

    const derived = await loadTranscriptEvents({
      sessionId: "session-events",
      sessionKey: "agent:main:main",
      storePath,
    });
    expect(derived).toEqual([header, message]);

    const missing = await loadTranscriptEvents({
      sessionFile: path.join(tempDir, "missing.jsonl"),
      sessionId: "session-events",
    });
    expect(missing).toEqual([]);
  });

  it("finds the newest matching transcript event without loading the whole file", async () => {
    const header = { type: "session", id: "session-find", timestamp: 1 };
    const older = { type: "message", id: "m1", message: { role: "assistant", tag: "old" } };
    const newer = { type: "message", id: "m2", message: { role: "assistant", tag: "new" } };
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify(header)}\n${JSON.stringify(older)}\n${JSON.stringify(newer)}\n`,
      "utf-8",
    );

    const seen: unknown[] = [];
    const found = await findTranscriptEvent(
      { sessionFile: transcriptPath, sessionId: "session-find" },
      (event) => {
        seen.push(event);
        return (event as { type?: string }).type === "message";
      },
    );
    // Newest-first with early exit: the older message is never visited.
    expect(found).toEqual({ event: newer });
    expect(seen).toEqual([newer]);

    const missing = await findTranscriptEvent(
      { sessionFile: path.join(tempDir, "missing.jsonl"), sessionId: "session-find" },
      () => true,
    );
    expect(missing).toBeUndefined();
  });

  it("opens a borrowed read view with raw exact-key probes and deferred enumeration", async () => {
    const mixedKey = "agent:main:matrix:channel:!RoomAbC:example.org";
    await upsertSessionEntry(
      { sessionKey: mixedKey, storePath },
      { sessionId: "mixed-session", updatedAt: 10 },
    );

    const view = openSessionEntryReadView({ storePath });

    expect(view.get(mixedKey)?.sessionId).toBe("mixed-session");
    // Raw probe contract: unlike loadSessionEntry, no folded-alias or
    // canonical-key resolution happens on get.
    expect(view.get(mixedKey.toLowerCase())).toBeUndefined();
    expect(view.entries()).toEqual([
      {
        sessionKey: mixedKey,
        entry: expect.objectContaining({ sessionId: "mixed-session" }),
      },
    ]);
  });

  it("keeps case-distinct Matrix sessions separate under nested agent ownership", async () => {
    const mixedKey = "agent:voice:agent:other:matrix:channel:!RoomAbC:example.org";
    const lowerKey = "agent:voice:agent:other:matrix:channel:!Roomabc:example.org";

    await upsertSessionEntry(
      { sessionKey: mixedKey, storePath },
      { sessionId: "mixed-session", updatedAt: 10 },
    );
    await upsertSessionEntry(
      { sessionKey: lowerKey, storePath },
      { sessionId: "lower-session", updatedAt: 20 },
    );

    expect(loadSessionEntry({ sessionKey: mixedKey, storePath })?.sessionId).toBe("mixed-session");
    expect(loadSessionEntry({ sessionKey: lowerKey, storePath })?.sessionId).toBe("lower-session");
    expect(listSessionEntries({ storePath }).map((entry) => entry.sessionKey)).toEqual([
      mixedKey,
      lowerKey,
    ]);
  });

  it("records inbound session meta as a createIfMissing upsert returning a detached entry", async () => {
    const sessionKey = "agent:main:webchat:dm:user-1";
    const ctx: MsgContext = {
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
      From: "webchat:user-1",
      To: "webchat:agent",
      SessionKey: sessionKey,
      OriginatingTo: "webchat:user-1",
    };

    const recorded = await recordInboundSessionMeta({ storePath, sessionKey, ctx });
    expect(recorded?.origin?.provider).toBe("webchat");

    // Detached result: caller mutations must never leak into cached store state.
    if (recorded) {
      recorded.origin = { provider: "mutated" };
    }
    expect(loadSessionEntry({ sessionKey, storePath })?.origin?.provider).toBe("webchat");
  });

  it("does not create sessions when inbound meta recording opts out of upsert", async () => {
    const sessionKey = "agent:main:webchat:dm:absent";
    const recorded = await recordInboundSessionMeta({
      storePath,
      sessionKey,
      ctx: { Provider: "webchat", From: "webchat:absent", OriginatingTo: "webchat:absent" },
      createIfMissing: false,
    });

    expect(recorded).toBeNull();
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  });

  it("preserves activity timestamps across inbound meta and last-route updates", async () => {
    const sessionKey = "agent:main:webchat:dm:user-2";
    const anchorUpdatedAt = Date.now() - 60_000;
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: "session-2", updatedAt: anchorUpdatedAt },
    );

    await recordInboundSessionMeta({
      storePath,
      sessionKey,
      ctx: {
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "direct",
        From: "webchat:user-2",
        To: "webchat:agent",
        SessionKey: sessionKey,
        OriginatingTo: "webchat:user-2",
      },
    });
    const afterMeta = loadSessionEntry({ sessionKey, storePath });
    expect(afterMeta?.origin?.provider).toBe("webchat");
    // Inbound metadata must not count as activity; idle reset relies on
    // updatedAt moving only for real session turns.
    expect(afterMeta?.updatedAt).toBe(anchorUpdatedAt);

    const routed = await updateSessionLastRoute({
      storePath,
      sessionKey,
      channel: "webchat",
      to: "webchat:user-2",
    });
    expect(routed?.lastChannel).toBe("webchat");
    const afterRoute = loadSessionEntry({ sessionKey, storePath });
    expect(afterRoute?.lastTo).toBe("webchat:user-2");
    expect(afterRoute?.route).toEqual({ channel: "webchat", target: { to: "webchat:user-2" } });
    expect(afterRoute?.updatedAt).toBe(anchorUpdatedAt);
  });

  it("returns null from last-route updates for missing sessions when createIfMissing is false", async () => {
    const sessionKey = "agent:main:webchat:dm:ghost";
    const routed = await updateSessionLastRoute({
      storePath,
      sessionKey,
      channel: "webchat",
      to: "webchat:ghost",
      createIfMissing: false,
    });

    expect(routed).toBeNull();
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  });

  it("marks abort targets while canonicalizing legacy session keys", async () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:telegram:group:-1001234567890:topic:99": {
          sessionId: "canonical-session",
          updatedAt: 10,
        },
        "Agent:Main:Telegram:Group:-1001234567890:Topic:99": {
          sessionId: "legacy-session",
          updatedAt: 20,
        },
      } satisfies Record<string, SessionEntry>),
      "utf8",
    );
    expect(loadSessionStore(storePath)).toHaveProperty(
      "Agent:Main:Telegram:Group:-1001234567890:Topic:99",
    );

    const result = await markSessionAbortTarget({
      scope: {
        sessionKey: "Agent:Main:Telegram:Group:-1001234567890:Topic:99",
        storePath,
      },
      now: () => 30,
      resolveAbortCutoff: ({ sessionKey }) => {
        expect(sessionKey).toBe("agent:main:telegram:group:-1001234567890:topic:99");
        return {
          messageSid: "55",
          timestamp: 1234567890000,
        };
      },
    });

    expect(result).toMatchObject({
      sessionId: "legacy-session",
      sessionKey: "agent:main:telegram:group:-1001234567890:topic:99",
      entry: {
        abortedLastRun: true,
        abortCutoffMessageSid: "55",
        abortCutoffTimestamp: 1234567890000,
        sessionId: "legacy-session",
        updatedAt: 30,
      },
    });
    expect(loadSessionStore(storePath)).toEqual({
      "agent:main:telegram:group:-1001234567890:topic:99": expect.objectContaining({
        abortedLastRun: true,
        abortCutoffMessageSid: "55",
        abortCutoffTimestamp: 1234567890000,
        sessionId: "legacy-session",
        updatedAt: 30,
      }),
    });
  });

  it("does not persist abort target changes when the entry is absent", async () => {
    const result = await markSessionAbortTarget({
      scope: {
        sessionKey: "agent:main:missing",
        storePath,
      },
      resolveAbortCutoff: () => ({ messageSid: "unused" }),
    });

    expect(result).toBeNull();
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it("canonicalizes alias rows and patches the canonical entry in one accessor write", async () => {
    const now = Date.now();
    fs.writeFileSync(transcriptPath, '{"type":"session","id":"sess-fresh"}\n', "utf-8");
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          "agent:main:main": {
            label: "canonical-stale",
            sessionFile: transcriptPath,
            sessionId: "sess-stale",
            updatedAt: now,
          },
          main: {
            label: "legacy-fresh",
            sessionFile: transcriptPath,
            sessionId: "sess-fresh",
            updatedAt: now + 1,
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
    );

    const result = await canonicalizeSessionEntryAliases({
      storePath,
      target: {
        canonicalKey: "agent:main:main",
        storeKeys: ["agent:main:main", "main"],
      },
      update: (entry) => {
        if (entry) {
          entry.sessionId = "mutated-callback-copy";
        }
        return {
          lastChannel: "telegram",
          updatedAt: now + 2,
        };
      },
    });

    expect(result).toEqual({
      canonicalKey: "agent:main:main",
      entry: expect.objectContaining({
        label: "legacy-fresh",
        lastChannel: "telegram",
        sessionId: "sess-fresh",
        updatedAt: now + 2,
      }),
    });
    const persisted = loadSessionStore(storePath, { skipCache: true });
    expect(persisted["agent:main:main"]).toMatchObject({
      label: "legacy-fresh",
      lastChannel: "telegram",
      sessionId: "sess-fresh",
      updatedAt: now + 2,
    });
    expect(persisted.main).toBeUndefined();
  });

  it("resolves status-style ordered candidate keys without exposing the store", async () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:current": {
          label: "literal-current",
          sessionId: "session-current",
          updatedAt: 30,
        },
        "agent:main:main": {
          label: "main",
          sessionId: "session-main",
          updatedAt: 10,
        },
      } satisfies Record<string, SessionEntry>),
      "utf8",
    );

    const resolved = resolveSessionEntryCandidateTarget({
      agentId: "main",
      candidateKeys: ["agent:main:main", "agent:main:current"],
      cfg: { session: { store: storePath } },
    });

    expect(resolved).toEqual({
      agentId: "main",
      candidateKey: "agent:main:main",
      entry: expect.objectContaining({
        label: "main",
        sessionId: "session-main",
      }),
      persisted: true,
      sessionKey: "agent:main:main",
    });
  });

  it("returns an implicit candidate fallback without persisting it", () => {
    const resolved = resolveSessionEntryCandidateTarget({
      agentId: "main",
      candidateKeys: ["agent:main:missing"],
      cfg: { session: { store: storePath } },
      fallback: {
        sessionKey: "agent:main:current",
        entry: {
          sessionId: "",
          updatedAt: 40,
        },
      },
    });

    expect(resolved).toEqual({
      agentId: "main",
      candidateKey: "agent:main:current",
      entry: {
        sessionId: "",
        updatedAt: 40,
      },
      persisted: false,
      sessionKey: "agent:main:current",
    });
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it("purges deleted-agent entries from the current locked store", async () => {
    const cfg = {
      session: { store: storePath },
      agents: {
        list: [
          { id: "main", workspace: path.join(tempDir, "main") },
          { id: "ops", workspace: path.join(tempDir, "ops") },
        ],
      },
    } satisfies OpenClawConfig;
    const now = Date.now();
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        main: { sessionId: "main-legacy", updatedAt: now },
        "agent:ops:main": { sessionId: "ops-session", updatedAt: now },
      }),
      "utf8",
    );

    const result = await purgeDeletedAgentSessionEntries({
      cfg,
      agentId: "ops",
      storeAgentId: "main",
      storePath,
    });

    expect(result.removedSessionKeys).toEqual(["agent:ops:main"]);
    expect(loadSessionStore(storePath)).toEqual({
      main: expect.objectContaining({ sessionId: "main-legacy" }),
    });
  });

  it("creates durable session ids for metadata-only inserts", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };

    const inserted = await upsertSessionEntry(scope, { model: "gpt-5.5" });

    expect(inserted?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(inserted?.sessionId).not.toBe(scope.sessionKey);
    expect(loadSessionEntry(scope)?.sessionId).toBe(inserted?.sessionId);
  });

  it("creates entries with initialized transcripts and normalized sessionFile metadata", async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath,
    };

    const created = await createSessionEntryWithTranscript(scope, ({ sessionEntries }) => {
      expect(sessionEntries).toEqual({});
      return {
        ok: true,
        entry: {
          sessionId: "session-1",
          updatedAt: 10,
        },
      };
    });

    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error("expected session creation to succeed");
    }
    expect(path.basename(created.sessionFile)).toBe("session-1.jsonl");
    expect(created.entry.sessionFile).toBe(created.sessionFile);
  });

  it("rolls back the entry when transcript initialization fails", async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath,
    };
    fs.writeFileSync(path.join(tempDir, "blocked"), "not a directory", "utf8");

    const created = await createSessionEntryWithTranscript(scope, () => ({
      ok: true,
      entry: {
        sessionFile: "blocked/session-1.jsonl",
        sessionId: "session-1",
        updatedAt: 10,
      },
    }));

    expect(created).toMatchObject({
      ok: false,
      phase: "transcript",
    });
    expect(loadSessionEntry(scope)).toBeUndefined();
    expect(loadSessionStore(storePath, { skipCache: true })[scope.sessionKey]).toBeUndefined();
  });

  it("commits reply session initialization with a guarded snapshot", async () => {
    const sessionKey = "agent:main:main";
    const previousTranscript = path.join(tempDir, "previous.jsonl");
    fs.writeFileSync(
      previousTranscript,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "previous-session",
        timestamp: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionFile: previousTranscript,
        sessionId: "previous-session",
        updatedAt: 10,
      },
    );

    const snapshot = loadReplySessionInitializationSnapshot({ sessionKey, storePath });
    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      previousEntry: snapshot.currentEntry,
      sessionEntry: {
        sessionId: "next-session",
        updatedAt: 20,
      },
      sessionKey,
      storePath,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    expect(path.basename(committed.sessionEntry.sessionFile ?? "")).toBe("next-session.jsonl");
    expect(committed.sessionStoreView[sessionKey]).toMatchObject({
      sessionId: "next-session",
      sessionFile: committed.sessionEntry.sessionFile,
    });
    expect(committed.previousSessionTranscript.transcriptArchived).toBe(true);
    expect(fs.existsSync(previousTranscript)).toBe(false);
  });

  it("does not reuse the previous transcript file when initialization rotates session ids", async () => {
    const sessionKey = "agent:main:main";
    const previousTranscript = path.join(tempDir, "previous-rotation.jsonl");
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionFile: previousTranscript,
        sessionId: "previous-rotation",
        updatedAt: 10,
      },
    );

    const snapshot = loadReplySessionInitializationSnapshot({ sessionKey, storePath });
    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      previousEntry: snapshot.currentEntry,
      sessionEntry: {
        ...snapshot.currentEntry,
        sessionFile: snapshot.currentEntry?.sessionFile,
        sessionId: "next-rotation",
        updatedAt: 20,
      },
      sessionKey,
      storePath,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    expect(path.basename(committed.sessionEntry.sessionFile ?? "")).toBe("next-rotation.jsonl");
  });

  it("rejects stale reply session initialization snapshots without writing", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "first-session",
        updatedAt: 10,
      },
    );
    const snapshot = loadReplySessionInitializationSnapshot({ sessionKey, storePath });
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "second-session",
        updatedAt: 20,
      },
    );

    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      sessionEntry: {
        sessionId: "stale-session",
        updatedAt: 30,
      },
      sessionKey,
      storePath,
    });

    expect(committed).toMatchObject({
      ok: false,
      reason: "stale-snapshot",
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "second-session",
    });
  });

  it("commits reply session initialization despite active-turn metadata changes", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "existing-session",
        updatedAt: 10,
      },
    );
    const snapshot = loadReplySessionInitializationSnapshot({ sessionKey, storePath });
    await sessionStore.updateSessionStore(storePath, (store) => {
      const current = store[sessionKey];
      if (!current) {
        throw new Error("expected existing session entry");
      }
      store[sessionKey] = {
        ...current,
        compactionCount: 1,
        totalTokensFresh: false,
        updatedAt: current.updatedAt + 1,
      };
    });

    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      sessionEntry: {
        sessionId: "existing-session",
        updatedAt: 30,
      },
      sessionKey,
      snapshotEntry: snapshot.currentEntry,
      storePath,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    expect(committed.sessionEntry).toMatchObject({
      compactionCount: 1,
      sessionId: "existing-session",
      totalTokensFresh: false,
      updatedAt: 30,
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      compactionCount: 1,
      sessionId: "existing-session",
      totalTokensFresh: false,
      updatedAt: 30,
    });
  });

  it("commits reply session initialization despite non-identity metadata changes", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "existing-session",
        updatedAt: 10,
        lastHeartbeatSentAt: 100,
        lastHeartbeatText: "heartbeat-1",
      },
    );

    const snapshot = loadReplySessionInitializationSnapshot({ sessionKey, storePath });

    // Background activity (heartbeat runner, delivery retry, etc.) can touch
    // metadata fields without rotating the session. The initialization guard
    // should only care about session identity, so this must not conflict.
    await sessionStore.updateSessionStore(storePath, (store) => {
      const current = store[sessionKey];
      if (!current) {
        throw new Error("expected existing session entry");
      }
      store[sessionKey] = {
        ...current,
        lastHeartbeatSentAt: 200,
        lastHeartbeatText: "heartbeat-2",
      };
    });

    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      // The real caller builds the prepared entry from the snapshot, so it
      // inherits the pre-drift heartbeat values. The commit must still notice
      // the concurrent metadata change and preserve the newer values.
      sessionEntry: {
        sessionId: "existing-session",
        updatedAt: 30,
        lastHeartbeatSentAt: 100,
        lastHeartbeatText: "heartbeat-1",
      },
      sessionKey,
      snapshotEntry: snapshot.currentEntry,
      storePath,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    expect(committed.sessionEntry.sessionId).toBe("existing-session");
    // The accepted commit must not roll back the metadata drift that happened
    // while the initialization was in flight.
    expect(committed.sessionEntry.lastHeartbeatSentAt).toBe(200);
    expect(committed.sessionEntry.lastHeartbeatText).toBe("heartbeat-2");
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "existing-session",
      lastHeartbeatSentAt: 200,
      lastHeartbeatText: "heartbeat-2",
    });
  });

  it("preserves concurrent optional additions when prepared fields are undefined", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "existing-session",
        updatedAt: 10,
      },
    );

    const snapshot = loadReplySessionInitializationSnapshot({ sessionKey, storePath });

    await sessionStore.updateSessionStore(storePath, (store) => {
      const current = store[sessionKey];
      if (!current) {
        throw new Error("expected existing session entry");
      }
      store[sessionKey] = {
        ...current,
        modelOverride: "channel-model",
        modelOverrideSource: "user",
      };
    });

    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      sessionEntry: {
        sessionId: "existing-session",
        updatedAt: 30,
        modelOverride: undefined,
        modelOverrideSource: undefined,
      },
      sessionKey,
      snapshotEntry: snapshot.currentEntry,
      storePath,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    expect(committed.sessionEntry).toMatchObject({
      modelOverride: "channel-model",
      modelOverrideSource: "user",
      sessionId: "existing-session",
      updatedAt: 30,
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      modelOverride: "channel-model",
      modelOverrideSource: "user",
      sessionId: "existing-session",
      updatedAt: 30,
    });
  });

  it("does not restore pending final delivery metadata cleared after the snapshot", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "existing-session",
        updatedAt: 10,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "durable reply",
        pendingFinalDeliveryCreatedAt: 11,
        pendingFinalDeliveryLastAttemptAt: 12,
        pendingFinalDeliveryAttemptCount: 2,
        pendingFinalDeliveryLastError: "previous failure",
        pendingFinalDeliveryContext: { channel: "discord", to: "channel-1" },
        pendingFinalDeliveryIntentId: "intent-1",
      },
    );

    const snapshot = loadReplySessionInitializationSnapshot({ sessionKey, storePath });
    if (!snapshot.currentEntry) {
      throw new Error("expected reply session initialization snapshot");
    }

    await sessionStore.updateSessionStore(storePath, (store) => {
      const current = store[sessionKey];
      if (!current) {
        throw new Error("expected existing session entry");
      }
      store[sessionKey] = {
        ...current,
        pendingFinalDelivery: undefined,
        pendingFinalDeliveryText: undefined,
        pendingFinalDeliveryCreatedAt: undefined,
        pendingFinalDeliveryLastAttemptAt: undefined,
        pendingFinalDeliveryAttemptCount: undefined,
        pendingFinalDeliveryLastError: undefined,
        pendingFinalDeliveryContext: undefined,
        pendingFinalDeliveryIntentId: undefined,
      };
    });

    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      sessionEntry: {
        ...snapshot.currentEntry,
        updatedAt: 30,
      },
      sessionKey,
      snapshotEntry: snapshot.currentEntry,
      storePath,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    expect(committed.sessionEntry.pendingFinalDelivery).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryText).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryCreatedAt).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryLastAttemptAt).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryAttemptCount).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryLastError).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryContext).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryIntentId).toBeUndefined();

    const persisted = loadSessionEntry({ sessionKey, storePath });
    expect(persisted?.pendingFinalDelivery).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryText).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryCreatedAt).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryLastAttemptAt).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryAttemptCount).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryLastError).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryContext).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryIntentId).toBeUndefined();
  });

  it("does not merge old-session delivery metadata into a rotated session", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "old-session",
        updatedAt: 10,
      },
    );

    const snapshot = loadReplySessionInitializationSnapshot({ sessionKey, storePath });

    await sessionStore.updateSessionStore(storePath, (store) => {
      const current = store[sessionKey];
      if (!current) {
        throw new Error("expected existing session entry");
      }
      store[sessionKey] = {
        ...current,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "old reply",
        pendingFinalDeliveryCreatedAt: 21,
        pendingFinalDeliveryContext: { channel: "discord", to: "channel-1" },
        pendingFinalDeliveryIntentId: "intent-old",
      };
    });

    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      sessionEntry: {
        sessionId: "new-session",
        updatedAt: 30,
      },
      sessionKey,
      snapshotEntry: snapshot.currentEntry,
      storePath,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    expect(committed.sessionEntry.sessionId).toBe("new-session");
    expect(committed.sessionEntry.pendingFinalDelivery).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryText).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryCreatedAt).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryContext).toBeUndefined();
    expect(committed.sessionEntry.pendingFinalDeliveryIntentId).toBeUndefined();

    const persisted = loadSessionEntry({ sessionKey, storePath });
    expect(persisted?.sessionId).toBe("new-session");
    expect(persisted?.pendingFinalDelivery).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryText).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryCreatedAt).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryContext).toBeUndefined();
    expect(persisted?.pendingFinalDeliveryIntentId).toBeUndefined();
  });

  it("commits reply session initialization despite runtime-only skill snapshot cache", async () => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "first-session",
        skillsSnapshot: {
          prompt: `<available_skills>${"x".repeat(600)}</available_skills>`,
          skills: [{ name: "skill-0" }],
          version: 1,
        },
        updatedAt: 10,
      },
    );

    const snapshot = loadReplySessionInitializationSnapshot({ sessionKey, storePath });
    const cachedStore = loadSessionStore(storePath, { clone: false });
    const cachedEntry = cachedStore[sessionKey];
    if (!cachedEntry?.skillsSnapshot) {
      throw new Error("expected cached skills snapshot");
    }
    cachedEntry.skillsSnapshot = {
      ...cachedEntry.skillsSnapshot,
      resolvedSkills: [
        createCanonicalFixtureSkill({
          baseDir: "/skills/skill-0",
          description: "skill-0 description",
          filePath: "/skills/skill-0/SKILL.md",
          name: "skill-0",
          source: `# skill-0\n\n${"x".repeat(3000)}`,
        }),
      ],
    };

    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      previousEntry: snapshot.currentEntry,
      sessionEntry: {
        sessionId: "next-session",
        updatedAt: 20,
      },
      sessionKey,
      storePath,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error("expected reply session initialization to commit");
    }
    expect(committed.sessionEntry.sessionId).toBe("next-session");
  });

  it("can borrow cached entry objects for read-only hot paths", async () => {
    const scope = {
      clone: false,
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, {
      sessionId: "session-1",
      updatedAt: 10,
    });
    const cachedStore = loadSessionStore(storePath, { clone: false });

    expect(loadSessionEntry(scope)).toBe(cachedStore["agent:main:main"]);
    expect(listSessionEntries({ clone: false, storePath })[0]?.entry).toBe(
      cachedStore["agent:main:main"],
    );
  });

  it("maps latest entry reads to the file backend cache bypass", () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": {
          sessionId: "session-1",
          model: "gpt-5.4",
        },
      }),
      "utf8",
    );
    const loadSessionStoreSpy = vi.spyOn(sessionStore, "loadSessionStore");

    try {
      expect(
        loadSessionEntry({
          readConsistency: "latest",
          sessionKey: "agent:main:main",
          storePath,
        })?.model,
      ).toBe("gpt-5.4");
      expect(loadSessionStoreSpy).toHaveBeenLastCalledWith(
        storePath,
        expect.objectContaining({ skipCache: true }),
      );

      loadSessionEntry({
        clone: false,
        readConsistency: "latest",
        sessionKey: "agent:main:main",
        storePath,
      });
      expect(loadSessionStoreSpy).toHaveBeenLastCalledWith(
        storePath,
        expect.objectContaining({ clone: false, skipCache: true }),
      );
    } finally {
      loadSessionStoreSpy.mockRestore();
    }
  });

  it("resolves canonical entry reads without requiring exact key casing", async () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": {
          sessionId: "session-1",
          updatedAt: 10,
          model: "gpt-5.5",
        },
      }),
      "utf8",
    );

    const mixedCaseScope = {
      sessionKey: "AGENT:MAIN:MAIN",
      storePath,
    };

    expect(loadSessionEntry(mixedCaseScope)).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        model: "gpt-5.5",
      }),
    );
  });

  it("updates existing entries without creating missing sessions", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };

    await expect(updateSessionEntry(scope, () => ({ model: "gpt-5.5" }))).resolves.toBeNull();
    expect(listSessionEntries({ storePath })).toEqual([]);

    await upsertSessionEntry(scope, {
      sessionId: "session-1",
      updatedAt: 10,
    });
    const beforeNullUpdate = loadSessionEntry(scope);
    await expect(updateSessionEntry(scope, () => null)).resolves.toEqual(beforeNullUpdate);
    expect(loadSessionEntry(scope)).toMatchObject({
      sessionId: "session-1",
      updatedAt: beforeNullUpdate?.updatedAt,
    });
    await expect(
      updateSessionEntry(scope, () => ({ model: "gpt-5.5", updatedAt: 20 })),
    ).resolves.toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: expect.any(Number),
    });
  });

  it("replaces entries so deleted fields stay removed", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, {
      model: "gpt-5.5",
      providerOverride: "openai",
      sessionId: "session-1",
      updatedAt: 10,
    });

    await replaceSessionEntry(scope, {
      sessionId: "session-1",
      updatedAt: 20,
    });

    expect(loadSessionEntry(scope)).toMatchObject({
      sessionId: "session-1",
      updatedAt: expect.any(Number),
    });
    expect(loadSessionEntry(scope)?.model).toBeUndefined();
    expect(loadSessionEntry(scope)?.providerOverride).toBeUndefined();
  });

  it("patches entries atomically with a fallback entry", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };
    let missingContextEntry: SessionEntry | undefined;
    let existingContextEntry: SessionEntry | undefined;

    await patchSessionEntry(
      scope,
      (entry, context) => {
        missingContextEntry = context.existingEntry;
        return {
          ...entry,
          model: "gpt-5.5",
        };
      },
      {
        fallbackEntry: {
          sessionId: "session-1",
          updatedAt: 10,
        },
        replaceEntry: true,
      },
    );

    await patchSessionEntry(
      scope,
      (entry, context) => {
        existingContextEntry = context.existingEntry;
        return {
          ...entry,
          model: undefined,
          providerOverride: "openai",
        };
      },
      { replaceEntry: true },
    );

    expect(missingContextEntry).toBeUndefined();
    expect(existingContextEntry).toMatchObject({ model: "gpt-5.5" });
    expect(loadSessionEntry(scope)).toMatchObject({
      providerOverride: "openai",
      sessionId: "session-1",
    });
    expect(loadSessionEntry(scope)?.model).toBeUndefined();
  });

  it("can patch metadata without refreshing session activity", async () => {
    const scope = {
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, {
      sessionId: "session-1",
      updatedAt: 10,
    });
    const beforePatch = loadSessionEntry(scope);

    await patchSessionEntry(
      scope,
      () => ({
        model: "gpt-5.5",
        updatedAt: 20,
      }),
      { preserveActivity: true },
    );

    expect(loadSessionEntry(scope)).toMatchObject({
      model: "gpt-5.5",
      sessionId: "session-1",
      updatedAt: beforePatch?.updatedAt,
    });
  });

  it("applies projected session patches after migrating legacy candidate keys", async () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": {
          sessionId: "canonical-session",
          updatedAt: 10,
        },
        main: {
          sessionId: "legacy-session",
          updatedAt: 20,
        },
      }),
      "utf8",
    );

    const projected = await applySessionPatchProjection({
      storePath,
      resolveTarget: () => ({
        primaryKey: "agent:main:main",
        candidateKeys: ["agent:main:main", "main"],
      }),
      project: ({ entries, existingEntry, primaryKey }) => {
        expect(primaryKey).toBe("agent:main:main");
        expect(existingEntry?.sessionId).toBe("legacy-session");
        expect(entries.map((entry) => entry.sessionKey)).toEqual(["agent:main:main"]);
        return {
          ok: true as const,
          entry: {
            ...existingEntry,
            label: "Projected",
          } as SessionEntry,
        };
      },
    });

    expect(projected).toMatchObject({
      ok: true,
      entry: {
        label: "Projected",
        sessionId: "legacy-session",
      },
    });
    expect(loadSessionStore(storePath)).toEqual({
      "agent:main:main": expect.objectContaining({
        label: "Projected",
        sessionId: "legacy-session",
      }),
    });
  });

  it("persists legacy key pruning when projected session patches fail validation", async () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": {
          sessionId: "canonical-session",
          updatedAt: 10,
        },
        main: {
          sessionId: "legacy-session",
          updatedAt: 20,
        },
      }),
      "utf8",
    );

    const projected = await applySessionPatchProjection({
      storePath,
      resolveTarget: () => ({
        primaryKey: "agent:main:main",
        candidateKeys: ["agent:main:main", "main"],
      }),
      project: () => ({
        ok: false as const,
        error: "invalid patch",
      }),
    });

    expect(projected).toEqual({ ok: false, error: "invalid patch" });
    expect(loadSessionStore(storePath)).toEqual({
      "agent:main:main": expect.objectContaining({
        sessionId: "legacy-session",
      }),
    });
  });

  it("updates the freshest matching session entry across discovered agent stores", async () => {
    const stateDir = path.join(tempDir, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const cfg = {
      session: {
        mainKey: "main",
        store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
      },
      agents: { list: [{ id: "retired-agent", default: true }] },
    } satisfies OpenClawConfig;
    const configuredStorePath = path.join(
      stateDir,
      "agents",
      "retired-agent",
      "sessions",
      "sessions.json",
    );
    const discoveredStorePath = path.join(
      stateDir,
      "agents",
      "Retired Agent",
      "sessions",
      "sessions.json",
    );
    fs.mkdirSync(path.dirname(configuredStorePath), { recursive: true });
    fs.mkdirSync(path.dirname(discoveredStorePath), { recursive: true });
    fs.writeFileSync(
      configuredStorePath,
      JSON.stringify({
        "agent:retired-agent:main": { sessionId: "configured", updatedAt: 10 },
      }),
      "utf8",
    );
    fs.writeFileSync(
      discoveredStorePath,
      JSON.stringify({
        "agent:retired-agent:main": { sessionId: "discovered", updatedAt: 20 },
      }),
      "utf8",
    );

    const resolved = resolveSessionEntryAccessTarget({
      cfg,
      env,
      sessionKey: "agent:retired-agent:main",
    });

    expect(resolved.entry?.sessionId).toBe("discovered");

    const updated = await updateResolvedSessionEntry(
      {
        cfg,
        env,
        sessionKey: "agent:retired-agent:main",
      },
      (entry, context) => {
        expect(context.canonicalKey).toBe("agent:retired-agent:main");
        expect(context.storeKey).toBe("agent:retired-agent:main");
        entry.model = "gpt-5.5";
        entry.updatedAt = Date.now();
        return entry.sessionId;
      },
    );

    expect(updated).toMatchObject({
      found: true,
      canonicalKey: "agent:retired-agent:main",
      result: "discovered",
    });
    expect(loadSessionStore(configuredStorePath)["agent:retired-agent:main"]).toMatchObject({
      sessionId: "configured",
      updatedAt: 10,
    });
    expect(Object.values(loadSessionStore(discoveredStorePath))).toContainEqual(
      expect.objectContaining({
        model: "gpt-5.5",
        sessionId: "discovered",
        updatedAt: expect.any(Number),
      }),
    );
  });

  it("applies explicit replacements without exposing mutable store rows", async () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "session-1",
            status: "running",
            updatedAt: 10,
          },
          "agent:main:other": {
            sessionId: "session-2",
            status: "running",
            updatedAt: 20,
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
      "utf8",
    );

    const result = await applySessionEntryReplacements({
      storePath,
      update: (entries) => {
        const main = entries.find((entry) => entry.sessionKey === "agent:main:main");
        const other = entries.find((entry) => entry.sessionKey === "agent:main:other");
        if (other) {
          other.entry.status = "failed";
        }
        if (!main) {
          return { result: { replaced: false } };
        }
        main.entry.abortedLastRun = true;
        main.entry.updatedAt = 30;
        return {
          result: { replaced: true },
          replacements: [{ sessionKey: main.sessionKey, entry: main.entry }],
        };
      },
    });

    expect(result).toEqual({ replaced: true });
    const store = loadSessionStore(storePath);
    expect(store["agent:main:main"]).toMatchObject({
      abortedLastRun: true,
      sessionId: "session-1",
      updatedAt: 30,
    });
    expect(store["agent:main:other"]).toMatchObject({
      sessionId: "session-2",
      status: "running",
      updatedAt: 20,
    });

    const selectedKeys = await applySessionEntryReplacements({
      sessionKeys: ["agent:main:main"],
      storePath,
      update: (entries) => ({ result: entries.map((entry) => entry.sessionKey) }),
    });
    expect(selectedKeys).toEqual(["agent:main:main"]);
    await expect(
      applySessionEntryReplacements({
        sessionKeys: ["agent:main:main"],
        storePath,
        update: () => ({
          replacements: [{ sessionKey: "agent:main:other", entry: store["agent:main:other"] }],
          result: undefined,
        }),
      }),
    ).rejects.toThrow("outside the selected key set");
  });

  it("branches checkpoint sessions without exposing mutable store rows", async () => {
    const sourceSessionId = "11111111-1111-4111-8111-111111111111";
    const branchSessionId = "22222222-2222-4222-8222-222222222222";
    const branchPath = path.join(tempDir, "branch.jsonl");
    const now = Date.now();
    fs.writeFileSync(transcriptPath, `{"type":"session","id":"${sourceSessionId}"}\n`, "utf8");
    fs.writeFileSync(branchPath, `{"type":"session","id":"${branchSessionId}"}\n`, "utf8");
    const checkpoint = {
      checkpointId: "checkpoint-1",
      sessionKey: "agent:main:main",
      sessionId: sourceSessionId,
      createdAt: now,
      reason: "manual",
      preCompaction: {
        sessionId: sourceSessionId,
        sessionFile: transcriptPath,
        leafId: "leaf-1",
      },
      postCompaction: { sessionId: "33333333-3333-4333-8333-333333333333" },
    } satisfies NonNullable<SessionEntry["compactionCheckpoints"]>[number];
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          main: {
            label: "Main",
            sessionFile: transcriptPath,
            sessionId: sourceSessionId,
            updatedAt: now,
            compactionCheckpoints: [checkpoint],
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
      "utf8",
    );

    const result = await branchSessionFromCompactionCheckpoint({
      storePath,
      sourceKey: "agent:main:main",
      sourceStoreKey: "main",
      nextKey: "agent:main:branch",
      checkpointId: "checkpoint-1",
      forkTranscriptFromCheckpoint: async (selectedCheckpoint) => {
        expect(selectedCheckpoint).toEqual(checkpoint);
        return {
          status: "created",
          transcript: {
            sessionFile: branchPath,
            sessionId: branchSessionId,
            totalTokens: 42,
          },
        };
      },
      buildEntry: ({ currentEntry, forkedTranscript }) => ({
        ...currentEntry,
        sessionFile: forkedTranscript.sessionFile,
        sessionId: forkedTranscript.sessionId,
        totalTokens: forkedTranscript.totalTokens,
        updatedAt: now + 1,
      }),
    });

    expect(result).toMatchObject({
      status: "created",
      key: "agent:main:branch",
      entry: {
        sessionFile: branchPath,
        sessionId: branchSessionId,
        totalTokens: 42,
      },
    });
    expect(loadSessionStore(storePath)).toEqual({
      main: expect.objectContaining({ sessionId: sourceSessionId }),
      "agent:main:branch": expect.objectContaining({
        sessionFile: branchPath,
        sessionId: branchSessionId,
        totalTokens: 42,
      }),
    });
  });

  it("branches from the newest matching compaction checkpoint without sorting all checkpoints", async () => {
    const sourceSessionId = "11111111-1111-4111-8111-111111111111";
    const branchSessionId = "22222222-2222-4222-8222-222222222222";
    const branchPath = path.join(tempDir, "branch-newest.jsonl");
    fs.writeFileSync(branchPath, `{"type":"session","id":"${branchSessionId}"}\n`, "utf8");
    const oldMatchingCheckpoint = {
      checkpointId: "checkpoint-1",
      sessionKey: "agent:main:main",
      sessionId: sourceSessionId,
      createdAt: 10,
      reason: "manual",
      preCompaction: {
        sessionId: sourceSessionId,
        leafId: "old-leaf",
      },
      postCompaction: { sessionId: "33333333-3333-4333-8333-333333333333" },
    } satisfies NonNullable<SessionEntry["compactionCheckpoints"]>[number];
    const newestMatchingCheckpoint = {
      ...oldMatchingCheckpoint,
      createdAt: 20,
      preCompaction: {
        sessionId: sourceSessionId,
        leafId: "new-leaf",
      },
      postCompaction: { sessionId: "44444444-4444-4444-8444-444444444444" },
    } satisfies NonNullable<SessionEntry["compactionCheckpoints"]>[number];
    const newestDifferentCheckpoint = {
      ...oldMatchingCheckpoint,
      checkpointId: "checkpoint-2",
      createdAt: 30,
      preCompaction: {
        sessionId: sourceSessionId,
        leafId: "different-leaf",
      },
      postCompaction: { sessionId: "55555555-5555-4555-8555-555555555555" },
    } satisfies NonNullable<SessionEntry["compactionCheckpoints"]>[number];
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          main: {
            sessionId: sourceSessionId,
            updatedAt: 30,
            compactionCheckpoints: [
              oldMatchingCheckpoint,
              newestDifferentCheckpoint,
              newestMatchingCheckpoint,
            ],
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
      "utf8",
    );

    const result = await branchSessionFromCompactionCheckpoint({
      storePath,
      sourceKey: "agent:main:main",
      sourceStoreKey: "main",
      nextKey: "agent:main:branch-newest",
      checkpointId: "checkpoint-1",
      forkTranscriptFromCheckpoint: async (selectedCheckpoint) => {
        expect(selectedCheckpoint).toEqual(newestMatchingCheckpoint);
        return {
          status: "created",
          transcript: {
            sessionFile: branchPath,
            sessionId: branchSessionId,
          },
        };
      },
      buildEntry: ({ currentEntry, forkedTranscript }) => ({
        ...currentEntry,
        sessionFile: forkedTranscript.sessionFile,
        sessionId: forkedTranscript.sessionId,
      }),
    });

    expect(result).toMatchObject({
      status: "created",
      key: "agent:main:branch-newest",
      checkpoint: newestMatchingCheckpoint,
    });
  });

  it("does not persist checkpoint restores when the transcript boundary is missing", async () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "session-1",
            updatedAt: 10,
            compactionCheckpoints: [
              {
                checkpointId: "checkpoint-1",
                sessionKey: "agent:main:main",
                sessionId: "session-1",
                createdAt: 20,
                reason: "manual",
                preCompaction: {
                  sessionId: "session-1",
                  leafId: "leaf-1",
                },
                postCompaction: { sessionId: "session-2" },
              },
            ],
          },
        } satisfies Record<string, SessionEntry>,
        null,
        2,
      ),
      "utf8",
    );

    const before = fs.readFileSync(storePath, "utf8");
    const result = await restoreSessionFromCompactionCheckpoint({
      storePath,
      sessionKey: "agent:main:main",
      checkpointId: "checkpoint-1",
      forkTranscriptFromCheckpoint: async () => ({ status: "missing-boundary" }),
      buildEntry: () => {
        throw new Error("missing boundary should skip entry replacement");
      },
    });

    expect(result).toEqual({ status: "missing-boundary" });
    expect(fs.readFileSync(storePath, "utf8")).toBe(before);
  });

  it("cleans scoped lifecycle entries and unreferenced transcript artifacts", async () => {
    const nowMs = Date.now();
    const oldDate = new Date(nowMs - 600_000);
    const lifecycleSessionsDir = path.join(tempDir, "state", "agents", "main", "sessions");
    const lifecycleStorePath = path.join(lifecycleSessionsDir, "sessions.json");
    const removedTranscriptPath = path.join(lifecycleSessionsDir, "removed-lifecycle.jsonl");
    const customTranscriptPath = path.join(lifecycleSessionsDir, "custom-lifecycle-old.jsonl");
    const freshDefaultTranscriptPath = path.join(lifecycleSessionsDir, "custom-lifecycle.jsonl");
    const freshTranscriptPath = path.join(lifecycleSessionsDir, "fresh-lifecycle.jsonl");
    const referencedTranscriptPath = path.join(lifecycleSessionsDir, "referenced.jsonl");
    const orphanTranscriptPath = path.join(lifecycleSessionsDir, "orphan-lifecycle.jsonl");
    const siblingDir = path.join(tempDir, "state", "agents", "sibling", "sessions");
    const siblingTranscriptPath = path.join(siblingDir, "sibling-lifecycle.jsonl");
    fs.mkdirSync(lifecycleSessionsDir, { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });

    fs.writeFileSync(
      lifecycleStorePath,
      JSON.stringify({
        "agent:main:lifecycle-cleanup-removed": {
          sessionId: "removed-lifecycle",
        },
        "agent:main:lifecycle-cleanup-fresh": {
          sessionId: "fresh-lifecycle",
        },
        "agent:main:lifecycle-cleanup-custom": {
          sessionFile: "custom-lifecycle-old.jsonl",
          sessionId: "custom-lifecycle",
        },
        "agent:main:lifecycle-cleanup-sibling": {
          sessionFile: siblingTranscriptPath,
          sessionId: "sibling-lifecycle",
        },
        "agent:main:telegram:group:lifecycle-cleanup-room": {
          sessionId: "kept-by-segment",
        },
        "agent:main:regular": {
          sessionId: "referenced",
        },
      }),
      "utf-8",
    );
    fs.writeFileSync(removedTranscriptPath, '{"runId":"lifecycle-marker-removed"}\n', "utf-8");
    fs.writeFileSync(customTranscriptPath, '{"runId":"lifecycle-marker-custom"}\n', "utf-8");
    fs.writeFileSync(freshDefaultTranscriptPath, '{"runId":"lifecycle-marker-default"}\n', "utf-8");
    fs.writeFileSync(freshTranscriptPath, '{"runId":"lifecycle-marker-fresh"}\n', "utf-8");
    fs.writeFileSync(siblingTranscriptPath, '{"runId":"lifecycle-marker-sibling"}\n', "utf-8");
    fs.writeFileSync(
      referencedTranscriptPath,
      '{"runId":"lifecycle-marker-referenced"}\n',
      "utf-8",
    );
    fs.writeFileSync(orphanTranscriptPath, '{"runId":"lifecycle-marker-orphan"}\n', "utf-8");
    fs.utimesSync(removedTranscriptPath, oldDate, oldDate);
    fs.utimesSync(customTranscriptPath, oldDate, oldDate);
    fs.utimesSync(siblingTranscriptPath, oldDate, oldDate);
    fs.utimesSync(referencedTranscriptPath, oldDate, oldDate);
    fs.utimesSync(orphanTranscriptPath, oldDate, oldDate);

    const result = await cleanupSessionLifecycleArtifacts({
      storePath: lifecycleStorePath,
      sessionKeySegmentPrefix: "lifecycle-cleanup-",
      transcriptContentMarker: "lifecycle-marker-",
      orphanTranscriptMinAgeMs: 300_000,
      nowMs,
    });

    expect(result).toEqual({ removedEntries: 3, archivedTranscriptArtifacts: 3 });
    const loaded = loadSessionStore(lifecycleStorePath, { skipCache: true });
    expect(loaded).not.toHaveProperty("agent:main:lifecycle-cleanup-removed");
    expect(loaded).not.toHaveProperty("agent:main:lifecycle-cleanup-custom");
    expect(loaded).not.toHaveProperty("agent:main:lifecycle-cleanup-sibling");
    expect(loaded).toHaveProperty("agent:main:lifecycle-cleanup-fresh");
    expect(loaded).toHaveProperty("agent:main:telegram:group:lifecycle-cleanup-room");
    expect(loaded).toHaveProperty("agent:main:regular");
    const files = fs.readdirSync(lifecycleSessionsDir);
    expect(
      files.filter((file) => file.startsWith("removed-lifecycle.jsonl.deleted.")),
    ).toHaveLength(1);
    expect(files.filter((file) => file.startsWith("orphan-lifecycle.jsonl.deleted."))).toHaveLength(
      1,
    );
    expect(
      files.filter((file) => file.startsWith("custom-lifecycle-old.jsonl.deleted.")),
    ).toHaveLength(1);
    expect(files).toContain("custom-lifecycle.jsonl");
    expect(files).toContain("fresh-lifecycle.jsonl");
    expect(files).toContain("referenced.jsonl");
    expect(fs.existsSync(siblingTranscriptPath)).toBe(true);
    expect(fs.readdirSync(siblingDir)).toEqual(["sibling-lifecycle.jsonl"]);
  });

  it("preserves fresh lifecycle entries that only have explicit sessionFile metadata", async () => {
    const nowMs = Date.now();
    const lifecycleSessionsDir = path.join(tempDir, "state", "agents", "main", "sessions");
    const lifecycleStorePath = path.join(lifecycleSessionsDir, "sessions.json");
    const freshTranscriptPath = path.join(lifecycleSessionsDir, "session-file-only.jsonl");
    fs.mkdirSync(lifecycleSessionsDir, { recursive: true });
    await saveSessionStore(
      lifecycleStorePath,
      {
        "agent:main:lifecycle-cleanup-file-only": {
          sessionFile: freshTranscriptPath,
          updatedAt: nowMs,
        } as SessionEntry,
      },
      { skipMaintenance: true },
    );
    fs.writeFileSync(freshTranscriptPath, '{"runId":"lifecycle-marker-file-only"}\n', "utf-8");

    const result = await cleanupSessionLifecycleArtifacts({
      storePath: lifecycleStorePath,
      sessionKeySegmentPrefix: "lifecycle-cleanup-",
      transcriptContentMarker: "lifecycle-marker-",
      orphanTranscriptMinAgeMs: 300_000,
      nowMs,
    });

    expect(result).toEqual({ removedEntries: 0, archivedTranscriptArtifacts: 0 });
    expect(loadSessionStore(lifecycleStorePath, { skipCache: true })).toHaveProperty(
      "agent:main:lifecycle-cleanup-file-only",
    );
    expect(fs.existsSync(freshTranscriptPath)).toBe(true);
  });

  it("prefers current generated lifecycle transcripts over stale generated sessionFile metadata", async () => {
    const nowMs = Date.now();
    const oldDate = new Date(nowMs - 600_000);
    const currentSessionId = "11111111-1111-4111-8111-111111111111";
    const staleSessionId = "22222222-2222-4222-8222-222222222222";
    const lifecycleSessionsDir = path.join(tempDir, "state", "agents", "main", "sessions");
    const lifecycleStorePath = path.join(lifecycleSessionsDir, "sessions.json");
    const currentTranscriptPath = path.join(lifecycleSessionsDir, `${currentSessionId}.jsonl`);
    const staleTranscriptPath = path.join(lifecycleSessionsDir, `${staleSessionId}.jsonl`);
    fs.mkdirSync(lifecycleSessionsDir, { recursive: true });
    await saveSessionStore(
      lifecycleStorePath,
      {
        "agent:main:lifecycle-cleanup-current": {
          sessionFile: staleTranscriptPath,
          sessionId: currentSessionId,
          updatedAt: nowMs,
        },
      },
      { skipMaintenance: true },
    );
    fs.writeFileSync(currentTranscriptPath, '{"runId":"lifecycle-marker-current"}\n', "utf-8");
    fs.writeFileSync(staleTranscriptPath, '{"runId":"lifecycle-marker-stale"}\n', "utf-8");
    fs.utimesSync(staleTranscriptPath, oldDate, oldDate);

    const result = await cleanupSessionLifecycleArtifacts({
      storePath: lifecycleStorePath,
      sessionKeySegmentPrefix: "lifecycle-cleanup-",
      transcriptContentMarker: "lifecycle-marker-",
      orphanTranscriptMinAgeMs: 300_000,
      nowMs,
    });

    expect(result).toEqual({ removedEntries: 0, archivedTranscriptArtifacts: 1 });
    expect(loadSessionStore(lifecycleStorePath, { skipCache: true })).toHaveProperty(
      "agent:main:lifecycle-cleanup-current",
    );
    expect(fs.existsSync(currentTranscriptPath)).toBe(true);
    expect(
      fs
        .readdirSync(lifecycleSessionsDir)
        .filter((file) => file.startsWith(`${staleSessionId}.jsonl.deleted.`)),
    ).toHaveLength(1);
  });

  it("persists reset lifecycle entry changes with transcript replay and archive", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:main";
    const previousTranscript = path.join(tempDir, "previous-session.jsonl");
    const nextTranscript = path.join(tempDir, "next-session.jsonl");
    const previousEntry: SessionEntry = {
      sessionFile: previousTranscript,
      sessionId: "previous-session",
      updatedAt: now,
    };
    const nextEntry: SessionEntry = {
      sessionFile: nextTranscript,
      sessionId: "next-session",
      updatedAt: now + 1,
    };
    fs.writeFileSync(
      previousTranscript,
      [
        JSON.stringify({ type: "session", id: "previous-session" }),
        JSON.stringify({
          id: "msg-user",
          message: { role: "user", content: "hello" },
          parentId: null,
          timestamp: "2026-06-16T00:00:00.000Z",
          type: "message",
        }),
        JSON.stringify({
          id: "msg-assistant",
          message: { role: "assistant", content: "hi" },
          parentId: "msg-user",
          timestamp: "2026-06-16T00:00:01.000Z",
          type: "message",
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    await upsertSessionEntry({ sessionKey, storePath }, previousEntry);

    const result = await persistSessionResetLifecycle({
      agentId: "main",
      cleanupPreviousTranscript: true,
      nextEntry,
      nextSessionFile: nextTranscript,
      previousEntry,
      previousSessionId: previousEntry.sessionId,
      sessionKey,
      storePath,
    });

    expect(result.replayedMessages).toBe(2);
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject(nextEntry);
    expect(fs.existsSync(previousTranscript)).toBe(false);
    const archivedPreviousTranscripts = fs
      .readdirSync(tempDir)
      .filter((file) => file.startsWith("previous-session.jsonl.reset."));
    expect(archivedPreviousTranscripts).toHaveLength(1);
    const [archivedPreviousTranscriptName] = archivedPreviousTranscripts;
    const archivedPreviousTranscript = path.join(tempDir, archivedPreviousTranscriptName);
    expect(fs.readFileSync(archivedPreviousTranscript, "utf-8")).toContain(
      '"id":"previous-session"',
    );
    expect(fs.readFileSync(archivedPreviousTranscript, "utf-8")).toContain('"content":"hi"');
    expect(fs.readFileSync(nextTranscript, "utf-8")).toContain('"content":"hello"');
  });

  it("appends transcript events through a session scope", async () => {
    const scope = {
      sessionFile: transcriptPath,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };
    const event = {
      payload: { value: "hello" },
      type: "metadata",
    };

    await appendTranscriptEvent(scope, { type: "session", sessionId: "session-1" });
    await appendTranscriptEvent(scope, event);

    expect(fs.statSync(transcriptPath).mode & 0o777).toBe(0o600);
  });

  it("applies keyed lifecycle removals and artifact cleanup from the final store", async () => {
    const removedTranscriptPath = path.join(tempDir, "removed-session.jsonl");
    const sharedTranscriptPath = path.join(tempDir, "shared-session.jsonl");
    const orphanTranscriptPath = path.join(tempDir, "orphan-session.jsonl");
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          "agent:main:removed": {
            sessionId: "removed-session",
          },
          "agent:main:shared-remove": {
            sessionId: "shared-session",
          },
          "agent:main:shared-keep": {
            sessionId: "shared-session",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(removedTranscriptPath, '{"type":"session"}\n', "utf-8");
    fs.writeFileSync(sharedTranscriptPath, '{"type":"session"}\n', "utf-8");
    fs.writeFileSync(orphanTranscriptPath, "orphan", "utf-8");
    const oldDate = new Date(Date.now() - 60_000);
    fs.utimesSync(orphanTranscriptPath, oldDate, oldDate);

    const result = await applySessionEntryLifecycleMutation({
      storePath,
      removals: [
        { sessionKey: "agent:main:removed", archiveRemovedTranscript: true },
        { sessionKey: "agent:main:shared-remove", archiveRemovedTranscript: true },
      ],
      upserts: [
        {
          sessionKey: "agent:main:new",
          entry: { sessionId: "new-session", updatedAt: 123 },
        },
      ],
      skipMaintenance: true,
      restrictArchivedTranscriptsToStoreDir: true,
      pruneUnreferencedArtifacts: { olderThanMs: 1 },
    });

    expect(result.removedEntries).toBe(2);
    expect(result.unreferencedArtifacts?.removedFiles).toBe(1);
    expect(loadSessionStore(storePath, { skipCache: true })).toEqual({
      "agent:main:shared-keep": {
        sessionId: "shared-session",
      },
      "agent:main:new": {
        sessionId: "new-session",
        updatedAt: 123,
      },
    });
    expect(fs.existsSync(removedTranscriptPath)).toBe(false);
    expect(fs.existsSync(sharedTranscriptPath)).toBe(true);
    expect(fs.existsSync(orphanTranscriptPath)).toBe(false);
    expect(
      fs.readdirSync(tempDir).filter((file) => file.startsWith("removed-session.jsonl.deleted.")),
    ).toHaveLength(1);
  });

  it("does not apply stale lifecycle removal plans to changed entries", async () => {
    const stalePlanEntry: SessionEntry = {
      sessionId: "planned-session",
      updatedAt: 1,
    };
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          "agent:main:planned": {
            sessionId: "planned-session",
            updatedAt: 2,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = await applySessionEntryLifecycleMutation({
      storePath,
      removals: [
        {
          sessionKey: "agent:main:planned",
          expectedEntry: stalePlanEntry,
          archiveRemovedTranscript: true,
        },
      ],
      skipMaintenance: true,
    });

    expect(result.removedEntries).toBe(0);
    expect(loadSessionStore(storePath, { skipCache: true })).toEqual({
      "agent:main:planned": {
        sessionId: "planned-session",
        updatedAt: 2,
      },
    });
  });

  it("builds lifecycle upsert entries from the locked store snapshot", async () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          "agent:main:existing": {
            sessionId: "current-session",
            updatedAt: 10,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = await applySessionEntryLifecycleMutation({
      storePath,
      upserts: [
        {
          sessionKey: "agent:main:existing",
          buildEntry: ({ currentEntry }) => ({
            ...currentEntry,
            sessionId: currentEntry?.sessionId ?? "missing",
            updatedAt: 20,
          }),
        },
      ],
      skipMaintenance: true,
    });

    expect(result.afterCount).toBe(1);
    expect(loadSessionStore(storePath, { skipCache: true })).toEqual({
      "agent:main:existing": {
        sessionId: "current-session",
        updatedAt: 20,
      },
    });
  });

  it("appends to an explicit transcript artifact without a session key", async () => {
    const scope = {
      sessionFile: transcriptPath,
      sessionId: "session-1",
      storePath,
    };
    const event = {
      payload: { value: "keyless" },
      type: "metadata",
    };

    await appendTranscriptEvent(scope, event);

    // Explicit-artifact writes never touch entry metadata: no entry appears.
    expect(listSessionEntries({ storePath })).toEqual([]);
  });

  it("trims a manual compact transcript and clears stale token metadata", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const manualTranscriptPath = path.join(tempDir, `${sessionId}.jsonl`);
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:main",
      storePath,
    };
    const contextBudgetStatus: NonNullable<SessionEntry["contextBudgetStatus"]> = {
      schemaVersion: 1,
      source: "pre-prompt-estimate",
      updatedAt: 90,
      provider: "openai",
      model: "gpt-5.5",
      route: "fits",
      shouldCompact: false,
      estimatedPromptTokens: 10,
      contextTokenBudget: 100,
      promptBudgetBeforeReserve: 80,
      reserveTokens: 20,
      effectiveReserveTokens: 20,
      remainingPromptBudgetTokens: 70,
      overflowTokens: 0,
      toolResultReducibleChars: 0,
      messageCount: 1,
      unwindowedMessageCount: 1,
    };
    await upsertSessionEntry(scope, {
      contextBudgetStatus,
      inputTokens: 10,
      outputTokens: 20,
      sessionFile: manualTranscriptPath,
      sessionId,
      totalTokens: 30,
      totalTokensFresh: true,
      updatedAt: 100,
    });
    const transcriptRecords = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-06-19T12:00:00.000Z",
        cwd: tempDir,
      },
      ...[1, 2, 3, 4].map((index) => ({
        type: "message",
        id: `entry-${index}`,
        parentId: index === 1 ? null : `entry-${index - 1}`,
        timestamp: `2026-06-19T12:00:0${index}.000Z`,
        message: { role: "user", content: `message ${index}`, timestamp: index },
      })),
    ];
    const originalTranscript = `${transcriptRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
    fs.writeFileSync(manualTranscriptPath, originalTranscript, { encoding: "utf-8", mode: 0o640 });
    const updates: unknown[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));

    const result = await trimSessionTranscriptForManualCompact(scope, {
      maxLines: 3,
      nowMs: 500,
    });

    unsubscribe();
    expect(result).toMatchObject({ compacted: true, kept: 3 });
    const archived = result.compacted ? result.archived : "";
    expect(path.basename(archived)).toMatch(new RegExp(`^${sessionId}\\.jsonl\\.bak\\.`));
    expect(fs.readFileSync(archived, "utf-8")).toBe(originalTranscript);
    const trimmedRecords = fs
      .readFileSync(manualTranscriptPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(trimmedRecords).toMatchObject([
      { type: "session", id: sessionId },
      { type: "message", id: "entry-3", parentId: null },
      { type: "message", id: "entry-4", parentId: "entry-3" },
    ]);
    expect(fs.statSync(manualTranscriptPath).mode & 0o777).toBe(0o600);
    const reopened = SessionManager.open(manualTranscriptPath, tempDir, tempDir);
    expect(reopened.getEntries().map((entry) => entry.id)).toEqual(["entry-3", "entry-4"]);
    expect(reopened.buildSessionContext().messages).toHaveLength(2);
    const updatedEntry = loadSessionEntry(scope);
    expect(updatedEntry).toMatchObject({
      sessionFile: manualTranscriptPath,
      sessionId,
      updatedAt: 500,
    });
    expect(updatedEntry?.contextBudgetStatus).toBeUndefined();
    expect(updatedEntry?.inputTokens).toBeUndefined();
    expect(updatedEntry?.outputTokens).toBeUndefined();
    expect(updatedEntry?.totalTokens).toBeUndefined();
    expect(updatedEntry?.totalTokensFresh).toBeUndefined();
    expect(updates).toEqual([
      { sessionFile: archived },
      { sessionFile: fs.realpathSync(manualTranscriptPath) },
    ]);
  });

  it("keeps retained messages reachable through an out-of-window label", async () => {
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const sessionFile = path.join(tempDir, `${sessionId}.jsonl`);
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:main",
      storePath,
    };
    const records = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-06-19T12:00:00.000Z",
        cwd: tempDir,
      },
      {
        type: "message",
        id: "old",
        parentId: null,
        timestamp: "2026-06-19T12:00:01.000Z",
        message: { role: "user", content: "old", timestamp: 1 },
      },
      {
        type: "message",
        id: "kept-1",
        parentId: "old",
        timestamp: "2026-06-19T12:00:02.000Z",
        message: { role: "user", content: "kept one", timestamp: 2 },
      },
      {
        type: "label",
        id: "label-1",
        parentId: "kept-1",
        targetId: "old",
        label: "trimmed target",
        timestamp: "2026-06-19T12:00:03.000Z",
      },
      {
        type: "message",
        id: "kept-2",
        parentId: "label-1",
        timestamp: "2026-06-19T12:00:04.000Z",
        message: { role: "user", content: "kept two", timestamp: 4 },
      },
    ];
    await upsertSessionEntry(scope, { sessionFile, sessionId, updatedAt: 1 });
    fs.writeFileSync(
      sessionFile,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf-8",
    );

    await expect(
      trimSessionTranscriptForManualCompact(scope, { maxLines: 4 }),
    ).resolves.toMatchObject({ compacted: true, kept: 4 });

    const context = SessionManager.open(sessionFile, tempDir, tempDir).buildSessionContext();
    expect(JSON.stringify(context.messages)).toContain("kept one");
    expect(JSON.stringify(context.messages)).toContain("kept two");
  });

  it("does not reactivate an abandoned branch when a leaf target was trimmed", async () => {
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const sessionFile = path.join(tempDir, `${sessionId}.jsonl`);
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:main",
      storePath,
    };
    const records = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-06-19T12:00:00.000Z",
        cwd: tempDir,
      },
      {
        type: "message",
        id: "selected-before-window",
        parentId: null,
        timestamp: "2026-06-19T12:00:01.000Z",
        message: { role: "user", content: "selected", timestamp: 1 },
      },
      {
        type: "message",
        id: "abandoned-side-row",
        parentId: "selected-before-window",
        appendMode: "side",
        timestamp: "2026-06-19T12:00:02.000Z",
        message: { role: "user", content: "must stay hidden", timestamp: 2 },
      },
      {
        type: "leaf",
        id: "leaf-1",
        parentId: "abandoned-side-row",
        targetId: "selected-before-window",
        appendParentId: "selected-before-window",
        timestamp: "2026-06-19T12:00:03.000Z",
      },
    ];
    await upsertSessionEntry(scope, { sessionFile, sessionId, updatedAt: 1 });
    fs.writeFileSync(
      sessionFile,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf-8",
    );

    await expect(
      trimSessionTranscriptForManualCompact(scope, { maxLines: 3 }),
    ).resolves.toMatchObject({ compacted: true, kept: 3 });

    const persisted = fs
      .readFileSync(sessionFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(persisted.find((entry) => entry.type === "leaf")).toMatchObject({
      targetId: null,
      appendParentId: null,
    });
    expect(
      SessionManager.open(sessionFile, tempDir, tempDir).buildSessionContext().messages,
    ).toEqual([]);
  });

  it("keeps malformed leaf controls transparent while re-rooting retained descendants", async () => {
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const sessionFile = path.join(tempDir, `${sessionId}.jsonl`);
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:main",
      storePath,
    };
    const records = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-06-19T12:00:00.000Z",
        cwd: tempDir,
      },
      {
        type: "message",
        id: "trimmed",
        parentId: null,
        message: { role: "user", content: "trimmed", timestamp: 1 },
        timestamp: "2026-06-19T12:00:01.000Z",
      },
      {
        type: "message",
        id: "retained-root",
        parentId: "trimmed",
        message: { role: "user", content: "retained root", timestamp: 2 },
        timestamp: "2026-06-19T12:00:02.000Z",
      },
      {
        type: "leaf",
        id: "malformed-leaf",
        parentId: "retained-root",
        timestamp: "2026-06-19T12:00:03.000Z",
      },
      {
        type: "message",
        id: "retained-child",
        parentId: "malformed-leaf",
        message: { role: "user", content: "retained child", timestamp: 4 },
        timestamp: "2026-06-19T12:00:04.000Z",
      },
    ];
    await upsertSessionEntry(scope, { sessionFile, sessionId, updatedAt: 1 });
    fs.writeFileSync(
      sessionFile,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );

    await expect(
      trimSessionTranscriptForManualCompact(scope, { maxLines: 4 }),
    ).resolves.toMatchObject({ compacted: true, kept: 4 });

    const serializedContext = JSON.stringify(
      SessionManager.open(sessionFile, tempDir, tempDir).buildSessionContext().messages,
    );
    expect(serializedContext).toContain("retained root");
    expect(serializedContext).toContain("retained child");
  });

  it("repairs a retained compaction boundary when its first kept entry was trimmed", async () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const sessionFile = path.join(tempDir, `${sessionId}.jsonl`);
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:main",
      storePath,
    };
    const records = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-06-19T12:00:00.000Z",
        cwd: tempDir,
      },
      {
        type: "message",
        id: "old-boundary",
        parentId: null,
        timestamp: "2026-06-19T12:00:01.000Z",
        message: { role: "user", content: "old", timestamp: 1 },
      },
      {
        type: "message",
        id: "kept-before-compaction",
        parentId: "old-boundary",
        timestamp: "2026-06-19T12:00:02.000Z",
        message: { role: "user", content: "kept before", timestamp: 2 },
      },
      {
        type: "compaction",
        id: "compaction-1",
        parentId: "kept-before-compaction",
        timestamp: "2026-06-19T12:00:03.000Z",
        summary: "summary",
        firstKeptEntryId: "old-boundary",
        tokensBefore: 100,
      },
      {
        type: "compaction",
        id: "compaction-2",
        parentId: "compaction-1",
        timestamp: "2026-06-19T12:00:04.000Z",
        summary: "hardened summary",
        firstKeptEntryId: "compaction-2",
        tokensBefore: 50,
      },
      {
        type: "message",
        id: "kept-after-compaction",
        parentId: "compaction-2",
        timestamp: "2026-06-19T12:00:05.000Z",
        message: { role: "user", content: "kept after", timestamp: 5 },
      },
    ];
    await upsertSessionEntry(scope, { sessionFile, sessionId, updatedAt: 1 });
    fs.writeFileSync(
      sessionFile,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf-8",
    );

    await expect(
      trimSessionTranscriptForManualCompact(scope, { maxLines: 5 }),
    ).resolves.toMatchObject({ compacted: true, kept: 5 });

    const reopened = SessionManager.open(sessionFile, tempDir, tempDir);
    expect(
      reopened
        .getEntries()
        .find((entry) => entry.type === "compaction" && entry.id === "compaction-1"),
    ).toMatchObject({
      firstKeptEntryId: "kept-before-compaction",
    });
    expect(
      reopened
        .getEntries()
        .find((entry) => entry.type === "compaction" && entry.id === "compaction-2"),
    ).toMatchObject({ firstKeptEntryId: "compaction-2" });
    const serializedContext = JSON.stringify(reopened.buildSessionContext().messages);
    expect(serializedContext).not.toContain("kept before");
    expect(serializedContext).toContain("kept after");
  });

  it("prefers the current generated transcript over a stale generated sessionFile", async () => {
    const currentSessionId = "11111111-1111-4111-8111-111111111111";
    const staleSessionId = "22222222-2222-4222-8222-222222222222";
    const currentTranscriptPath = path.join(tempDir, `${currentSessionId}.jsonl`);
    const staleTranscriptPath = path.join(tempDir, `${staleSessionId}.jsonl`);
    const scope = {
      agentId: "main",
      sessionId: currentSessionId,
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntry(scope, {
      sessionFile: staleTranscriptPath,
      sessionId: currentSessionId,
      updatedAt: 100,
    });
    const currentHeader = {
      type: "session",
      version: 3,
      id: currentSessionId,
      timestamp: "2026-06-19T12:00:00.000Z",
      cwd: tempDir,
    };
    const currentOne = {
      type: "message",
      id: "current-one",
      parentId: null,
      timestamp: "2026-06-19T12:00:01.000Z",
      message: { role: "user", content: "current one", timestamp: 1 },
    };
    const currentTwo = {
      type: "message",
      id: "current-two",
      parentId: "current-one",
      timestamp: "2026-06-19T12:00:02.000Z",
      message: { role: "user", content: "current two", timestamp: 2 },
    };
    fs.writeFileSync(
      currentTranscriptPath,
      `${[currentHeader, currentOne, currentTwo].map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf-8",
    );
    fs.writeFileSync(staleTranscriptPath, "stale one\nstale two\n", "utf-8");

    const result = await trimSessionTranscriptForManualCompact(scope, {
      maxLines: 2,
      sessionFile: staleTranscriptPath,
    });

    expect(result).toMatchObject({ compacted: true, kept: 2 });
    expect(fs.readFileSync(currentTranscriptPath, "utf-8")).toBe(
      `${JSON.stringify(currentHeader)}\n${JSON.stringify({ ...currentTwo, parentId: null })}\n`,
    );
    expect(fs.readFileSync(staleTranscriptPath, "utf-8")).toBe("stale one\nstale two\n");
  });

  it("rejects transcript writes without a session key or explicit file", async () => {
    await expect(
      appendTranscriptEvent({ sessionId: "session-1", storePath }, { type: "metadata" }),
    ).rejects.toThrow(/session key or explicit session file/);
  });

  it("rejects raw message transcript events", async () => {
    const scope = {
      sessionFile: transcriptPath,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };

    await expect(
      appendTranscriptEvent(scope, {
        id: "msg-1",
        message: { role: "user", content: "hello" },
        parentId: null,
        type: "message",
      }),
    ).rejects.toThrow(/appendTranscriptMessage/);
    expect(fs.existsSync(transcriptPath)).toBe(false);
  });

  it("appends messages and publishes updates through a session scope", async () => {
    const scope = {
      agentId: "main",
      sessionFile: transcriptPath,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };
    const updates: unknown[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      updates.push(update);
    });

    const appended = await appendTranscriptMessage(scope, {
      cwd: tempDir,
      idempotencyLookup: "scan",
      message: {
        role: "assistant",
        content: "hello",
        idempotencyKey: "assistant-once",
      },
    });
    const replayed = await appendTranscriptMessage(scope, {
      cwd: tempDir,
      idempotencyLookup: "scan",
      message: {
        role: "assistant",
        content: "hello again",
        idempotencyKey: "assistant-once",
      },
    });
    await publishTranscriptUpdate(scope, {
      agentId: "main",
      message: appended.message,
      messageId: appended.messageId,
      sessionKey: scope.sessionKey,
    });
    unsubscribe();

    expect(replayed).toMatchObject({
      appended: false,
      messageId: appended.messageId,
      message: expect.objectContaining({
        content: "hello",
        idempotencyKey: "assistant-once",
      }),
    });
    expect(updates).toEqual([
      {
        agentId: "main",
        message: appended.message,
        messageId: appended.messageId,
        sessionId: scope.sessionId,
        sessionFile: transcriptPath,
        sessionKey: scope.sessionKey,
        target: {
          agentId: "main",
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
        },
      },
    ]);
  });

  it("persists a transcript turn, touches metadata, and publishes after the write", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-lock-order",
      sessionKey: "agent:main:lock-order",
      storePath,
    };
    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    const updates: Array<{
      lineCount: number;
      sessionFile: string | undefined;
      updatedAt: number | undefined;
    }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      const lines = fs.readFileSync(update.sessionFile, "utf8").trim().split("\n");
      updates.push({
        lineCount: lines.length,
        sessionFile: loadSessionEntry(scope)?.sessionFile,
        updatedAt: loadSessionEntry(scope)?.updatedAt,
      });
    });

    const result = await persistSessionTranscriptTurn(scope, {
      cwd: tempDir,
      messages: [
        {
          message: {
            role: "user",
            content: "hello",
            timestamp: 100,
          },
        },
        {
          message: {
            role: "assistant",
            content: "hi there",
            timestamp: 200,
          },
        },
      ],
      publishWhen: "always",
      touchSessionEntry: true,
      updateMode: "file-only",
    });
    unsubscribe();

    expect(result.appendedCount).toBe(2);
    expect(loadSessionEntry(scope)).toMatchObject({
      sessionFile: result.sessionFile,
      sessionId: scope.sessionId,
      updatedAt: expect.any(Number),
    });
    expect(loadSessionEntry(scope)?.updatedAt).toBeGreaterThanOrEqual(10);
    expect(updates).toEqual([
      {
        lineCount: 3,
        sessionFile: result.sessionFile,
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it("queues transcript turn appends before taking the file write lock", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    let markShouldAppendEntered!: () => void;
    const shouldAppendEntered = new Promise<void>((resolve) => {
      markShouldAppendEntered = resolve;
    });
    let resumeShouldAppend!: () => void;
    const shouldAppendReleased = new Promise<boolean>((resolve) => {
      resumeShouldAppend = () => resolve(true);
    });

    const turnPromise = persistSessionTranscriptTurn(scope, {
      cwd: tempDir,
      messages: [
        {
          message: {
            role: "assistant",
            content: "batch reply",
            timestamp: 100,
          },
          shouldAppend: async () => {
            markShouldAppendEntered();
            return await shouldAppendReleased;
          },
        },
      ],
      publishWhen: "always",
      touchSessionEntry: true,
      updateMode: "file-only",
    });

    await shouldAppendEntered;
    const queuedAppendPromise = appendTranscriptMessage(scope, {
      cwd: tempDir,
      message: {
        role: "user",
        content: "queued prompt",
        timestamp: 200,
      },
    });
    resumeShouldAppend();

    const results = Promise.all([turnPromise, queuedAppendPromise]);
    const completed = await Promise.race([
      results.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 1_000);
      }),
    ]);
    expect(completed).toBe(true);
    await results;
  });

  it("rejects expected-session transcript turns after a queued session rebind", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-original",
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    let releaseReset = () => {};
    const resetGate = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    let markResetStarted = () => {};
    const resetStarted = new Promise<void>((resolve) => {
      markResetStarted = resolve;
    });
    const replacementSessionFile = path.join(tempDir, "session-replacement.jsonl");
    const reset = updateSessionStoreEntry({
      storePath,
      sessionKey: scope.sessionKey,
      update: async () => {
        markResetStarted();
        await resetGate;
        return {
          sessionFile: replacementSessionFile,
          sessionId: "session-replacement",
        };
      },
    });
    await resetStarted;

    const turn = persistSessionTranscriptTurn(scope, {
      expectedSessionId: scope.sessionId,
      messages: [
        {
          message: {
            role: "assistant",
            content: "late reply",
            timestamp: 100,
          },
        },
      ],
      publishWhen: "always",
      touchSessionEntry: true,
      updateMode: "file-only",
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    releaseReset();

    await reset;
    const result = await turn;

    expect(result).toMatchObject({
      appendedCount: 0,
      rejectedReason: "session-rebound",
    });
    expect(fs.existsSync(path.join(tempDir, "session-original.jsonl"))).toBe(false);
    expect(fs.existsSync(replacementSessionFile)).toBe(false);
  });

  it("publishes transcript turn appends through an active owned write lock", async () => {
    const scope = {
      agentId: "main",
      sessionFile: transcriptPath,
      sessionId: "session-owned-publish",
      sessionKey: "agent:main:owned-publish",
      storePath,
    };
    const publishOptions: Array<boolean | undefined> = [];
    const publishedEntryBatches: unknown[][] = [];

    await withOwnedSessionTranscriptWrites(
      {
        sessionFile: transcriptPath,
        sessionKey: scope.sessionKey,
        withSessionWriteLock: async (run, options) => {
          publishOptions.push(options?.publishOwnedWrite);
          const result = await run();
          publishedEntryBatches.push([...(options?.resolvePublishedEntries?.(result) ?? [])]);
          return result;
        },
      },
      async () =>
        await persistSessionTranscriptTurn(scope, {
          cwd: tempDir,
          messages: [
            {
              message: {
                role: "assistant",
                content: "owned batch",
                timestamp: 100,
              },
            },
          ],
          publishWhen: "always",
          touchSessionEntry: true,
          updateMode: "file-only",
        }),
    );

    expect(publishOptions).toEqual([true]);
    expect(publishedEntryBatches).toHaveLength(1);
    expect(publishedEntryBatches[0]).toEqual([
      expect.objectContaining({ kind: "header" }),
      expect.objectContaining({ kind: "id" }),
    ]);
  });

  it("honors thread fallback paths when resolving transcript scope from the store", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:demo-channel:1234:thread:456",
      storePath,
    };
    const event = {
      payload: { value: "hello" },
      type: "metadata",
    };

    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await appendTranscriptEvent(scope, event);

    const expectedTranscriptPath = path.join(tempDir, "session-1-topic-456.jsonl");
    expect(fs.existsSync(expectedTranscriptPath)).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "session-1.jsonl"))).toBe(false);
    expect(fs.realpathSync(loadSessionEntry(scope)?.sessionFile ?? "")).toBe(
      fs.realpathSync(expectedTranscriptPath),
    );
  });

  it("resolves runtime transcript targets from scope without caller-owned paths", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });

    const target = await resolveSessionTranscriptRuntimeTarget(scope);

    expect(target).toMatchObject({
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
    });
    expect(fs.realpathSync(path.dirname(target.sessionFile))).toBe(fs.realpathSync(tempDir));
    expect(path.basename(target.sessionFile)).toBe("session-1.jsonl");
    expect(loadSessionEntry(scope)?.sessionFile).toBe(target.sessionFile);
  });

  it("preserves an explicitly resolved runtime transcript file target", async () => {
    const explicitSessionFile = path.join(tempDir, "explicit-session.jsonl");
    const scope = {
      agentId: "main",
      sessionFile: explicitSessionFile,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });

    const readTarget = await resolveSessionTranscriptRuntimeReadTarget(scope);
    const writeTarget = await resolveSessionTranscriptRuntimeTarget(scope);

    expect(readTarget.sessionFile).toBe(explicitSessionFile);
    expect(writeTarget.sessionFile).toBe(explicitSessionFile);
    expect(loadSessionEntry(scope)?.sessionFile).toBeUndefined();
  });

  it("uses a supplied read session entry without loading the store", () => {
    const explicitSessionFile = path.join(tempDir, "entry-session.jsonl");
    fs.writeFileSync(explicitSessionFile, "", "utf8");
    fs.writeFileSync(storePath, "{not-json", "utf8");

    const target = resolveSessionTranscriptReadTarget({
      agentId: "main",
      sessionEntry: {
        sessionFile: explicitSessionFile,
        sessionId: "session-1",
      },
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    });

    expect(target).toMatchObject({
      agentId: "main",
      sessionFile: fs.realpathSync(explicitSessionFile),
      sessionId: "session-1",
      sessionKey: "agent:main:main",
    });
  });

  it("resolves an explicit read transcript file without agent identity", () => {
    const explicitSessionFile = path.join(tempDir, "explicit-read-session.jsonl");

    const target = resolveSessionTranscriptReadTarget({
      sessionFile: explicitSessionFile,
      sessionId: "session-1",
    });

    expect(target).toEqual({
      sessionFile: explicitSessionFile,
      sessionId: "session-1",
    });
  });

  it("keeps read and write runtime targets aligned for new topic sessions", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-2",
      sessionKey: "agent:main:main:topic:456",
      storePath,
      threadId: "456",
    };
    fs.writeFileSync(
      path.join(tempDir, "session-1-topic-456.jsonl"),
      '{"type":"session","id":"session-1"}\n',
      "utf8",
    );
    await upsertSessionEntry(
      { sessionKey: scope.sessionKey, storePath },
      {
        sessionFile: "session-1-topic-456.jsonl",
        sessionId: "session-1",
        updatedAt: 10,
      },
    );

    const readTarget = await resolveSessionTranscriptRuntimeReadTarget(scope);
    const writeTarget = await resolveSessionTranscriptRuntimeTarget(scope);

    expect(path.basename(readTarget.sessionFile)).toBe("session-2-topic-456.jsonl");
    expect(writeTarget.sessionFile).toBe(readTarget.sessionFile);
    expect(loadSessionEntry(scope)?.sessionFile).toBe(readTarget.sessionFile);
  });

  it("persists transcript metadata under the normalized session key", async () => {
    const canonicalScope = {
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(canonicalScope, {
      sessionId: canonicalScope.sessionId,
      updatedAt: 10,
    });
    await appendTranscriptEvent(
      {
        agentId: "main",
        sessionId: canonicalScope.sessionId,
        sessionKey: "AGENT:MAIN:MAIN",
        storePath,
      },
      { id: "event-1", type: "metadata" },
    );

    expect(listSessionEntries({ storePath }).map((entry) => entry.sessionKey)).toEqual([
      canonicalScope.sessionKey,
    ]);
    expect(loadSessionEntry(canonicalScope)?.sessionFile).toBeTruthy();
  });
});
