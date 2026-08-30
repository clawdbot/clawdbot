import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { buildConversationIdentity } from "./conversation-identity.js";
import {
  listConversations,
  registerConversationAddresses,
  resolveConversation,
  resolveCurrentSessionPrimaryConversation,
} from "./conversation-registry.js";
import {
  commitReplySessionInitialization,
  deleteSessionEntryLifecycle,
  loadReplySessionInitializationSnapshot,
  upsertSessionEntryCore as upsertCanonicalSessionEntry,
} from "./session-accessor.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionEntry, SessionOrigin } from "./types.js";

type LegacyDeliveryFixture = Partial<SessionEntry> & {
  deliveryContext?: DeliveryContext;
  origin?: SessionOrigin;
};

const upsertSessionEntryCore = (
  scope: Parameters<typeof upsertCanonicalSessionEntry>[0],
  entry: LegacyDeliveryFixture,
) => upsertCanonicalSessionEntry(scope, normalizeLegacySessionEntryDelivery(entry as SessionEntry));

describe("conversation registry", () => {
  let tempDir: string;
  let storePath: string;

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-conversations-");
    storePath = path.join(tempDir, "sessions.json");
  });

  it("links multiple direct peers to a shared main context without conflating addresses", async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:main", storePath };
    await upsertSessionEntryCore(scope, {
      sessionId: "shared-main-session",
      updatedAt: 100,
      chatType: "direct",
      deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-a" },
      origin: { provider: "reef", accountId: "default", nativeDirectUserId: "peer-a" },
    });
    await upsertSessionEntryCore(scope, {
      sessionId: "shared-main-session",
      updatedAt: 200,
      chatType: "direct",
      deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-b" },
      origin: { provider: "reef", accountId: "default", nativeDirectUserId: "peer-b" },
    });

    const conversations = listConversations({ agentId: "main", storePath }, { channel: "reef" });
    expect(conversations.map((entry) => entry.target).toSorted()).toEqual([
      "reef:peer-a",
      "reef:peer-b",
    ]);
    expect(conversations.every((entry) => entry.role === "participant")).toBe(true);
    expect(conversations.every((entry) => entry.sessionKey === scope.sessionKey)).toBe(true);
    expect(
      resolveCurrentSessionPrimaryConversation({ ...scope, sessionId: "shared-main-session" }),
    ).toBeUndefined();

    const peerA = conversations.find((entry) => entry.target === "reef:peer-a");
    expect(peerA).toBeDefined();
    expect(resolveConversation({ agentId: "main", storePath }, peerA!.conversationRef)).toEqual(
      peerA,
    );
  });

  it("catalogs a directory address without inventing a model-context session", () => {
    const identity = buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "reef:peer-a",
      deliveryTarget: "reef:peer-a",
      nativeDirectUserId: "peer-a",
      label: "@peer-a's agent",
    });
    expect(identity).toBeDefined();
    registerConversationAddresses({ agentId: "main", storePath }, [identity!], 100);

    const [conversation] = listConversations({ agentId: "main", storePath }, { channel: "reef" });
    expect(conversation).toMatchObject({
      conversationRef: identity?.conversationRef,
      target: "reef:peer-a",
      label: "@peer-a's agent",
      firstSeenAt: 100,
      lastSeenAt: 100,
    });
    expect(conversation?.sessionId).toBeUndefined();
    expect(conversation?.sessionKey).toBeUndefined();
    expect(conversation?.role).toBeUndefined();
    expect(resolveConversation({ agentId: "main", storePath }, identity!.conversationRef)).toEqual(
      conversation,
    );
  });

  it("round-trips authoritative route context on its conversation association", async () => {
    const sessionKey = "agent:main:discord:channel:ops";
    const scope = { agentId: "main", sessionKey, storePath };
    await upsertSessionEntryCore(scope, {
      sessionId: "ops-session",
      updatedAt: 100,
      chatType: "channel",
      deliveryContext: { channel: "discord", accountId: "default", to: "channel:ops" },
    });
    const snapshot = loadReplySessionInitializationSnapshot(scope);

    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      routeContext: {
        peerId: "canonical-ops",
        guildId: "guild-a",
        parentPeerId: "parent-a",
        memberRoleIds: ["support", "admin"],
      },
      sessionEntry: snapshot.currentEntry!,
      sessionKey,
      snapshotEntry: snapshot.currentEntry,
      storePath,
    });

    expect(committed.ok).toBe(true);
    const canonicalConversation = listConversations(scope).find(
      (conversation) => conversation.peerId === "canonical-ops",
    );
    expect(canonicalConversation).toBeDefined();
    const conversationRef = canonicalConversation!.conversationRef;
    expect(
      resolveCurrentSessionPrimaryConversation({ ...scope, sessionId: "ops-session" }),
    ).toEqual(canonicalConversation);
    expect(
      resolveCurrentSessionPrimaryConversation({ ...scope, sessionId: "another-session" }),
    ).toBeUndefined();
    expect(
      resolveCurrentSessionPrimaryConversation({
        ...scope,
        sessionId: "ops-session",
        sessionKey: "agent:main:discord:channel:another",
      }),
    ).toBeUndefined();
    expect(resolveConversation({ agentId: "main", storePath }, conversationRef)).toMatchObject({
      peerId: "canonical-ops",
      observedFromSession: true,
      routeContextObserved: true,
      routeContext: {
        peerId: "canonical-ops",
        guildId: "guild-a",
        parentPeerId: "parent-a",
        memberRoleIds: ["admin", "support"],
      },
    });

    await upsertCanonicalSessionEntry(scope, { label: "generic current write", updatedAt: 200 });
    expect(
      listConversations(scope).filter((conversation) => conversation.role === "primary"),
    ).toEqual([expect.objectContaining({ conversationRef, peerId: "canonical-ops" })]);
    const afterCurrentWrite = resolveConversation({ agentId: "main", storePath }, conversationRef);
    expect(afterCurrentWrite).toMatchObject({
      routeContextObserved: true,
      routeContext: { guildId: "guild-a" },
    });

    const resolved = resolveSqliteReadScope(scope);
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    database.db
      .prepare(
        `INSERT INTO session_conversations (
          session_id, conversation_id, role, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id, conversation_id, role) DO UPDATE SET
          last_seen_at = excluded.last_seen_at`,
      )
      .run(
        "ops-session",
        conversationRef,
        "primary",
        afterCurrentWrite!.firstSeenAt,
        afterCurrentWrite!.lastSeenAt,
      );
    closeOpenClawAgentDatabasesForTest();

    expect(resolveConversation({ agentId: "main", storePath }, conversationRef)).not.toMatchObject({
      routeContextObserved: true,
    });
    expect(
      resolveCurrentSessionPrimaryConversation({ ...scope, sessionId: "ops-session" })
        ?.routeContext,
    ).toBeUndefined();
    await upsertCanonicalSessionEntry(scope, {
      label: "after older writer",
      updatedAt: afterCurrentWrite!.lastSeenAt + 1,
    });
    expect(resolveConversation({ agentId: "main", storePath }, conversationRef)).not.toMatchObject({
      routeContextObserved: true,
    });
  });

  it("keeps route context with each conversation when a shared session changes primary", async () => {
    const sessionKey = "agent:main:discord:channel:shared";
    const scope = { agentId: "main", sessionKey, storePath };
    const writeRoute = async (target: string, guildId: string, updatedAt: number) => {
      await upsertSessionEntryCore(scope, {
        sessionId: "shared-session",
        updatedAt,
        chatType: "channel",
        deliveryContext: { channel: "discord", accountId: "default", to: target },
      });
      const snapshot = loadReplySessionInitializationSnapshot(scope);
      const committed = await commitReplySessionInitialization({
        activeSessionKey: sessionKey,
        agentId: "main",
        expectedRevision: snapshot.revision,
        routeContext: { guildId },
        sessionEntry: snapshot.currentEntry!,
        sessionKey,
        snapshotEntry: snapshot.currentEntry,
        storePath,
      });
      expect(committed.ok).toBe(true);
    };

    await writeRoute("channel:alpha", "guild-alpha", 100);
    await writeRoute("channel:beta", "guild-beta", 200);

    expect(
      listConversations(scope, { channel: "discord" })
        .map(({ target, routeContext }) => ({ target, routeContext }))
        .toSorted((left, right) => left.target.localeCompare(right.target)),
    ).toEqual([
      { target: "channel:alpha", routeContext: { guildId: "guild-alpha" } },
      { target: "channel:beta", routeContext: { guildId: "guild-beta" } },
    ]);
    const resolved = resolveSqliteReadScope(scope);
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .updateTable("session_conversations")
        .set({ last_seen_at: 300 })
        .where("session_id", "=", "shared-session")
        .where("role", "=", "related"),
    );
    expect(
      resolveCurrentSessionPrimaryConversation({ ...scope, sessionId: "shared-session" }),
    ).toMatchObject({ target: "channel:beta", routeContext: { guildId: "guild-beta" } });
  });

  it("preserves context across an unobserved rollover and clears it on observed-empty ingress", async () => {
    const sessionKey = "agent:main:discord:channel:rollover";
    const scope = { agentId: "main", sessionKey, storePath };
    await upsertSessionEntryCore(scope, {
      sessionId: "before-rollover",
      updatedAt: 100,
      chatType: "channel",
      deliveryContext: { channel: "discord", accountId: "default", to: "channel:rollover" },
    });
    let snapshot = loadReplySessionInitializationSnapshot(scope);
    await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      routeContext: { guildId: "guild-a", memberRoleIds: ["support"] },
      sessionEntry: snapshot.currentEntry!,
      sessionKey,
      snapshotEntry: snapshot.currentEntry,
      storePath,
    });

    snapshot = loadReplySessionInitializationSnapshot(scope);
    const rollover = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      sessionEntry: { ...snapshot.currentEntry!, sessionId: "after-rollover", updatedAt: 200 },
      sessionKey,
      snapshotEntry: snapshot.currentEntry,
      storePath,
    });
    expect(rollover.ok).toBe(true);
    expect(listConversations(scope)[0]).toMatchObject({
      sessionId: "after-rollover",
      routeContextObserved: true,
      routeContext: { guildId: "guild-a", memberRoleIds: ["support"] },
    });
    expect(
      resolveCurrentSessionPrimaryConversation({ ...scope, sessionId: "before-rollover" }),
    ).toBeUndefined();
    expect(
      resolveCurrentSessionPrimaryConversation({ ...scope, sessionId: "after-rollover" }),
    ).toMatchObject({ routeContext: { guildId: "guild-a" } });

    snapshot = loadReplySessionInitializationSnapshot(scope);
    await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      routeContext: null,
      sessionEntry: snapshot.currentEntry!,
      sessionKey,
      snapshotEntry: snapshot.currentEntry,
      storePath,
    });
    expect(listConversations(scope)[0]).toMatchObject({
      sessionId: "after-rollover",
      routeContextObserved: true,
    });
    expect(listConversations(scope)[0]?.routeContext).toBeUndefined();
    expect(
      resolveCurrentSessionPrimaryConversation({ ...scope, sessionId: "after-rollover" })
        ?.routeContext,
    ).toBeUndefined();
  });

  it.each([
    { entry_valid: 0 },
    { entry_json: JSON.stringify({ sessionId: "wrong-session", updatedAt: 100 }) },
  ])("does not bind an invalid current entry to its primary address: %j", async (invalid) => {
    const scope = { agentId: "main", sessionKey: "agent:main:reef:direct:peer-a", storePath };
    await upsertSessionEntry(scope, {
      sessionId: "peer-a-session",
      updatedAt: 100,
      chatType: "direct",
      deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-a" },
    });
    const resolved = resolveSqliteReadScope(scope);
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .updateTable("session_nodes")
        .set(invalid)
        .where("session_key", "=", scope.sessionKey),
    );
    expect(
      resolveCurrentSessionPrimaryConversation({ ...scope, sessionId: "peer-a-session" }),
    ).toBeUndefined();
  });

  it("orders fresh directory addresses with session-backed conversation activity", async () => {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:reef:direct:peer-a", storePath },
      {
        sessionId: "peer-a-session",
        updatedAt: 100,
        chatType: "direct",
        deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-a" },
      },
    );
    const freshIdentity = buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "reef:peer-b",
      deliveryTarget: "reef:peer-b",
    });
    expect(freshIdentity).toBeDefined();
    const freshAt = Date.now() + 1_000;
    registerConversationAddresses({ agentId: "main", storePath }, [freshIdentity!], freshAt);

    expect(
      listConversations({ agentId: "main", storePath }, { channel: "reef", limit: 1 }),
    ).toEqual([
      expect.objectContaining({
        conversationRef: freshIdentity?.conversationRef,
        target: "reef:peer-b",
        lastSeenAt: freshAt,
      }),
    ]);
  });

  it("keeps a live binding when newer historical activity has no current entry", async () => {
    const liveSessionKey = "agent:main:reef:direct:peer-a-live";
    const staleSessionKey = "agent:main:reef:direct:peer-a-stale";
    for (const [sessionKey, sessionId] of [
      [liveSessionKey, "live-session"],
      [staleSessionKey, "stale-session"],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        {
          sessionId,
          updatedAt: 100,
          chatType: "direct",
          deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-a" },
        },
      );
    }
    const resolved = resolveSqliteReadScope({ agentId: "main", storePath });
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const db = getSessionKysely(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_conversations")
        .set({ last_seen_at: 100 })
        .where("session_id", "=", "live-session"),
    );
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_conversations")
        .set({ last_seen_at: 200 })
        .where("session_id", "=", "stale-session"),
    );
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_nodes").where("session_key", "=", staleSessionKey),
    );

    expect(
      listConversations({ agentId: "main", storePath }, { channel: "reef", limit: 1 })[0],
    ).toMatchObject({
      target: "reef:peer-a",
      sessionId: "live-session",
      sessionKey: liveSessionKey,
      lastSeenAt: 100,
    });
  });

  it("resolves historical addresses through the current session binding after reset", async () => {
    const sessionKey = "agent:main:reef:direct:peer-a";
    const scope = { agentId: "main", sessionKey, storePath };
    await upsertSessionEntryCore(scope, {
      sessionId: "old-session",
      updatedAt: 100,
      chatType: "direct",
      deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-a" },
      origin: { provider: "reef", accountId: "default", nativeDirectUserId: "peer-a" },
    });
    const [historical] = listConversations({ agentId: "main", storePath }, { channel: "reef" });
    expect(historical?.sessionId).toBe("old-session");

    await upsertSessionEntryCore(scope, {
      sessionId: "current-session",
      updatedAt: 200,
      chatType: "direct",
    });

    expect(
      resolveConversation({ agentId: "main", storePath }, historical?.conversationRef ?? "missing"),
    ).toMatchObject({
      conversationRef: historical?.conversationRef,
      sessionId: "current-session",
      sessionKey,
      target: "reef:peer-a",
    });
  });

  it("retains a deleted session's address without exposing a stale binding", async () => {
    const sessionKey = "agent:main:reef:direct:peer-a";
    const scope = { agentId: "main", sessionKey, storePath };
    await upsertSessionEntryCore(scope, {
      sessionId: "deleted-session",
      updatedAt: 100,
      chatType: "direct",
      deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-a" },
    });
    const [linked] = listConversations({ agentId: "main", storePath }, { channel: "reef" });
    expect(linked?.sessionId).toBe("deleted-session");

    await deleteSessionEntryLifecycle({
      agentId: "main",
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      archiveTranscript: false,
    });
    expect(
      resolveCurrentSessionPrimaryConversation({ ...scope, sessionId: "deleted-session" }),
    ).toBeUndefined();

    expect(
      resolveConversation({ agentId: "main", storePath }, linked?.conversationRef ?? "missing"),
    ).toMatchObject({
      conversationRef: linked?.conversationRef,
      target: "reef:peer-a",
    });
    expect(
      resolveConversation({ agentId: "main", storePath }, linked?.conversationRef ?? "missing"),
    ).not.toMatchObject({ sessionId: expect.any(String), sessionKey: expect.any(String) });
  });
});
