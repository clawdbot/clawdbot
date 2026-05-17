import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  recordSessionMetaFromInbound,
  updateLastRoute,
} from "../sessions.js";

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
    await fs.writeFile(storePath, "{}", "utf-8");
  });

  afterEach(async () => {
    clearSessionStoreCacheForTest();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  it("records inbound metadata under a canonical lowercase key", async () => {
    await recordSessionMetaFromInbound({
      storePath,
      sessionKey: MIXED_CASE_KEY,
      ctx: createInboundContext(),
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toEqual([CANONICAL_KEY]);
    expect(store[CANONICAL_KEY]?.origin?.provider).toBe("webchat");
  });

  it("does not create a duplicate mixed-case key when last route is updated", async () => {
    await recordSessionMetaFromInbound({
      storePath,
      sessionKey: CANONICAL_KEY,
      ctx: createInboundContext(),
    });

    await updateLastRoute({
      storePath,
      sessionKey: MIXED_CASE_KEY,
      channel: "webchat",
      to: "webchat:user-1",
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toEqual([CANONICAL_KEY]);
    expect(store[CANONICAL_KEY]?.lastChannel).toBe("webchat");
    expect(store[CANONICAL_KEY]?.lastTo).toBe("webchat:user-1");
  });

  it("migrates legacy mixed-case entries to the canonical key on update", async () => {
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [MIXED_CASE_KEY]: {
            sessionId: "legacy-session",
            updatedAt: 1,
            chatType: "direct",
            channel: "webchat",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    clearSessionStoreCacheForTest();

    await updateLastRoute({
      storePath,
      sessionKey: CANONICAL_KEY,
      channel: "webchat",
      to: "webchat:user-2",
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[CANONICAL_KEY]?.sessionId).toBe("legacy-session");
    expect(store[MIXED_CASE_KEY]).toBeUndefined();
  });

  it("preserves updatedAt when recording inbound metadata for an existing session", async () => {
    const existingUpdatedAt = Date.now();
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
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
        },
        null,
        2,
      ),
      "utf-8",
    );
    clearSessionStoreCacheForTest();

    await recordSessionMetaFromInbound({
      storePath,
      sessionKey: CANONICAL_KEY,
      ctx: createInboundContext(),
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[CANONICAL_KEY]?.sessionId).toBe("existing-session");
    expect(store[CANONICAL_KEY]?.updatedAt).toBe(existingUpdatedAt);
    expect(store[CANONICAL_KEY]?.origin?.provider).toBe("webchat");
  });

  it("records Signal group metadata under the mixed-case opaque group id", async () => {
    await recordSessionMetaFromInbound({
      storePath,
      sessionKey: `Agent:Main:Signal:Group:${SIGNAL_GROUP_ID}`,
      ctx: createSignalGroupContext(),
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toEqual([SIGNAL_GROUP_KEY]);
    expect(store[SIGNAL_GROUP_KEY]?.groupId).toBe(SIGNAL_GROUP_ID);
    expect(store[SIGNAL_GROUP_KEY]?.origin?.to).toBe(`signal:group:${SIGNAL_GROUP_ID}`);
  });

  it("migrates legacy lowercase Signal group keys to the mixed-case canonical key", async () => {
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
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
        },
        null,
        2,
      ),
      "utf-8",
    );
    clearSessionStoreCacheForTest();

    await recordSessionMetaFromInbound({
      storePath,
      sessionKey: SIGNAL_GROUP_KEY,
      ctx: createSignalGroupContext(),
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toEqual([SIGNAL_GROUP_KEY]);
    expect(store[SIGNAL_GROUP_KEY]?.sessionId).toBe("legacy-signal-session");
    expect(store[SIGNAL_GROUP_KEY]?.groupId).toBe(SIGNAL_GROUP_ID);
    expect(store[LEGACY_SIGNAL_GROUP_KEY]).toBeUndefined();
  });
});
