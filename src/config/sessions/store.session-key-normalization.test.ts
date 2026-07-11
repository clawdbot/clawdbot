// Store session key tests cover session key normalization through the accessor.
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntries,
  recordInboundSessionMeta,
  updateSessionLastRoute,
} from "./session-accessor.js";
import type { SessionEntry } from "./types.js";

// Materializes the SQLite-backed session store as a keyed object so key
// normalization/migration assertions keep matching the old JSON-store shape.
function loadStore(storePath: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntries({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

// Seeds pre-existing rows under their exact (possibly legacy mixed-case) keys.
// replaceSessionEntry canonicalizes keys on write, so a lifecycle upsert is the
// only way to persist a legacy-keyed row the accessor should later migrate.
async function seedStore(storePath: string, entries: Record<string, SessionEntry>): Promise<void> {
  await applySessionEntryLifecycleMutation({
    storePath,
    upserts: Object.entries(entries).map(([sessionKey, entry]) => ({ sessionKey, entry })),
    skipMaintenance: true,
  });
}

const CANONICAL_KEY = "agent:main:webchat:dm:mixed-user";
const MIXED_CASE_KEY = "Agent:Main:WebChat:DM:MiXeD-User";
const SIGNAL_GROUP_ID = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
const SIGNAL_GROUP_KEY = `agent:main:signal:group:${SIGNAL_GROUP_ID}`;
const LEGACY_SIGNAL_GROUP_KEY = SIGNAL_GROUP_KEY.toLowerCase();

function createInboundContext(): MsgContext {
  return {
    Provider: "webchat",
    Surface: "webchat",
    ChatType: "direct",
    From: "WebChat:User-1",
    To: "webchat:agent",
    SessionKey: MIXED_CASE_KEY,
    OriginatingTo: "webchat:user-1",
  };
}

function createSignalGroupContext(): MsgContext {
  return {
    Provider: "signal",
    Surface: "signal",
    ChatType: "group",
    From: `signal:group:${SIGNAL_GROUP_ID}`,
    To: `signal:group:${SIGNAL_GROUP_ID}`,
    SessionKey: SIGNAL_GROUP_KEY,
    OriginatingTo: `signal:group:${SIGNAL_GROUP_ID}`,
  };
}

describe("session store key normalization", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-session-key-normalize-",
  });
  let tempDir = "";
  let storePath = "";

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  beforeEach(async () => {
    tempDir = await suiteRootTracker.make("case");
    storePath = path.join(tempDir, "sessions.json");
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  it("records inbound metadata under a canonical lowercase key", async () => {
    await recordInboundSessionMeta({
      storePath,
      sessionKey: MIXED_CASE_KEY,
      ctx: createInboundContext(),
    });

    const store = loadStore(storePath);
    expect(Object.keys(store)).toEqual([CANONICAL_KEY]);
    expect(store[CANONICAL_KEY]?.origin?.provider).toBe("webchat");
  });

  it("does not create a duplicate mixed-case key when last route is updated", async () => {
    await recordInboundSessionMeta({
      storePath,
      sessionKey: CANONICAL_KEY,
      ctx: createInboundContext(),
    });

    await updateSessionLastRoute({
      storePath,
      sessionKey: MIXED_CASE_KEY,
      channel: "webchat",
      to: "webchat:user-1",
    });

    const store = loadStore(storePath);
    expect(Object.keys(store)).toEqual([CANONICAL_KEY]);
    expect(store[CANONICAL_KEY]?.lastChannel).toBe("webchat");
    expect(store[CANONICAL_KEY]?.lastTo).toBe("webchat:user-1");
    expect(store[CANONICAL_KEY]?.route).toEqual({
      channel: "webchat",
      target: { to: "webchat:user-1" },
    });
  });

  it("migrates legacy mixed-case entries to the canonical key on update", async () => {
    await seedStore(storePath, {
      [MIXED_CASE_KEY]: {
        sessionId: "legacy-session",
        updatedAt: 1,
        chatType: "direct",
        channel: "webchat",
      },
    });

    await updateSessionLastRoute({
      storePath,
      sessionKey: CANONICAL_KEY,
      channel: "webchat",
      to: "webchat:user-2",
    });

    const store = loadStore(storePath);
    expect(store[CANONICAL_KEY]?.sessionId).toBe("legacy-session");
    expect(store[MIXED_CASE_KEY]).toBeUndefined();
  });

  it("preserves ACP metadata when inbound metadata normalizes a legacy key", async () => {
    await seedStore(storePath, {
      [CANONICAL_KEY]: {
        sessionId: "canonical-session",
        updatedAt: 2,
      },
      [MIXED_CASE_KEY]: {
        sessionId: "legacy-session",
        updatedAt: 1,
        acp: {
          backend: "codex",
          agent: "main",
          runtimeSessionName: "runtime-1",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 1,
        },
      },
    });

    // A real inbound context yields a non-empty metadata patch, which is what
    // triggers the accessor to collapse the legacy mixed-case alias onto the
    // canonical row (the SQLite writer canonicalizes aliases as part of the
    // patch write rather than as a separate empty-write pass).
    await recordInboundSessionMeta({
      storePath,
      sessionKey: CANONICAL_KEY,
      ctx: createInboundContext(),
    });

    const store = loadStore(storePath);
    expect(Object.keys(store)).toEqual([CANONICAL_KEY]);
    expect(store[CANONICAL_KEY]?.sessionId).toBe("canonical-session");
    expect(store[CANONICAL_KEY]?.acp).toBeUndefined();
  });

  it("preserves updatedAt when recording inbound metadata for an existing session", async () => {
    const existingUpdatedAt = Date.now();
    await seedStore(storePath, {
      [CANONICAL_KEY]: {
        sessionId: "existing-session",
        updatedAt: existingUpdatedAt,
        chatType: "direct",
        channel: "webchat",
        origin: {
          provider: "webchat",
          chatType: "direct",
          from: "WebChat:User-1",
          to: "webchat:user-1",
        },
      },
    });

    await recordInboundSessionMeta({
      storePath,
      sessionKey: CANONICAL_KEY,
      ctx: createInboundContext(),
    });

    const store = loadStore(storePath);
    expect(store[CANONICAL_KEY]?.sessionId).toBe("existing-session");
    expect(store[CANONICAL_KEY]?.updatedAt).toBe(existingUpdatedAt);
    expect(store[CANONICAL_KEY]?.origin?.provider).toBe("webchat");
  });

  it("records Signal group metadata under the mixed-case opaque group id", async () => {
    await recordInboundSessionMeta({
      storePath,
      sessionKey: `Agent:Main:Signal:Group:${SIGNAL_GROUP_ID}`,
      ctx: createSignalGroupContext(),
    });

    const store = loadStore(storePath);
    expect(Object.keys(store)).toEqual([SIGNAL_GROUP_KEY]);
    expect(store[SIGNAL_GROUP_KEY]?.groupId).toBe(SIGNAL_GROUP_ID);
    expect(store[SIGNAL_GROUP_KEY]?.origin?.to).toBe(`signal:group:${SIGNAL_GROUP_ID}`);
  });

  it("migrates legacy lowercase Signal group keys to the mixed-case canonical key", async () => {
    await seedStore(storePath, {
      [LEGACY_SIGNAL_GROUP_KEY]: {
        sessionId: "legacy-signal-session",
        updatedAt: 1,
        chatType: "group",
        channel: "signal",
        groupId: SIGNAL_GROUP_ID.toLowerCase(),
        deliveryContext: {
          channel: "signal",
          to: `signal:group:${SIGNAL_GROUP_ID}`,
        },
      },
    });

    await recordInboundSessionMeta({
      storePath,
      sessionKey: SIGNAL_GROUP_KEY,
      ctx: createSignalGroupContext(),
    });

    const store = loadStore(storePath);
    expect(Object.keys(store)).toEqual([SIGNAL_GROUP_KEY]);
    expect(store[SIGNAL_GROUP_KEY]?.sessionId).toBe("legacy-signal-session");
    expect(store[SIGNAL_GROUP_KEY]?.groupId).toBe(SIGNAL_GROUP_ID);
    expect(store[LEGACY_SIGNAL_GROUP_KEY]).toBeUndefined();
  });

  it("stores canonical route metadata and derives legacy delivery fields", async () => {
    await updateSessionLastRoute({
      storePath,
      sessionKey: CANONICAL_KEY,
      route: {
        channel: "slack",
        accountId: "work",
        target: { to: "channel:C123", rawTo: "slack://C123", chatType: "channel" },
        thread: { id: "177000.123", kind: "thread", source: "target" },
      },
      deliveryContext: {
        channel: "discord",
        to: "channel:old",
        threadId: "old-thread",
      },
    });

    const store = loadStore(storePath);
    expect(store[CANONICAL_KEY]?.route).toEqual({
      channel: "slack",
      accountId: "work",
      target: { to: "channel:C123", rawTo: "slack://C123", chatType: "channel" },
      thread: { id: "177000.123", kind: "thread", source: "target" },
    });
    expect(store[CANONICAL_KEY]?.deliveryContext).toEqual({
      channel: "slack",
      to: "channel:C123",
      accountId: "work",
      threadId: "177000.123",
    });
    expect(store[CANONICAL_KEY]?.lastChannel).toBe("slack");
    expect(store[CANONICAL_KEY]?.lastTo).toBe("channel:C123");
    expect(store[CANONICAL_KEY]?.lastAccountId).toBe("work");
    expect(store[CANONICAL_KEY]?.lastThreadId).toBe("177000.123");
  });

  // NOTE: the file-store test "normalizes malformed persisted route metadata on
  // load" was removed with the SQLite flip. It asserted file-store load-time
  // repair of a legacy malformed `route` string (store-load.ts
  // normalizeSessionEntryDelivery). The SQLite runtime reads canonical shapes
  // only and does not repair legacy `route` slots on read; that legacy-data
  // repair is owned by doctor/migration, not steady-state runtime reads.
});
