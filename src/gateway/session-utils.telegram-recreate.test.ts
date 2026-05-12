import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  recordSessionMetaFromInbound,
  updateLastRoute,
  updateSessionStore,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { listSessionsFromStore } from "./session-utils.js";

const TELEGRAM_DIRECT_KEY = "agent:main:telegram:direct:7463849194";

const cfg = {
  agents: {
    defaults: {
      model: "openai/gpt-5.4",
      workspace: "/tmp/openclaw",
    },
  },
  session: {
    dmScope: "per-channel-peer",
  },
} satisfies Partial<OpenClawConfig> as OpenClawConfig;

function createTelegramDirectContext(): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "telegram:7463849194",
    AccountId: "default",
    ChatType: "direct",
    ConversationLabel: "Alice id:7463849194",
    From: "telegram:7463849194",
    To: "telegram:7463849194",
    SenderId: "7463849194",
    SenderName: "Alice",
    SessionKey: TELEGRAM_DIRECT_KEY,
  };
}

describe("Telegram direct session recreation after delete", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-telegram-session-recreate-",
  });
  let tempDir = "";
  let storePath = "";

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  it("surfaces a deleted Telegram direct session again after the next inbound message", async () => {
    tempDir = await suiteRootTracker.make("direct");
    storePath = path.join(tempDir, "sessions.json");
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [TELEGRAM_DIRECT_KEY]: {
            sessionId: "old-session",
            updatedAt: 1_700_000_000_000,
            chatType: "direct",
            channel: "telegram",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await updateSessionStore(storePath, (store) => {
      delete store[TELEGRAM_DIRECT_KEY];
    });
    expect(loadSessionStore(storePath, { skipCache: true })[TELEGRAM_DIRECT_KEY]).toBeUndefined();

    const ctx = createTelegramDirectContext();
    await recordSessionMetaFromInbound({
      storePath,
      sessionKey: TELEGRAM_DIRECT_KEY,
      ctx,
    });
    await updateLastRoute({
      storePath,
      sessionKey: TELEGRAM_DIRECT_KEY,
      channel: "telegram",
      to: "telegram:7463849194",
      accountId: "default",
      ctx,
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    const listed = listSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: {},
    });

    expect(store[TELEGRAM_DIRECT_KEY]?.lastChannel).toBe("telegram");
    expect(store[TELEGRAM_DIRECT_KEY]?.lastTo).toBe("telegram:7463849194");
    expect(store[TELEGRAM_DIRECT_KEY]?.origin?.chatType).toBe("direct");
    expect(store[TELEGRAM_DIRECT_KEY]?.origin?.provider).toBe("telegram");
    expect(listed.sessions.map((session) => session.key)).toContain(TELEGRAM_DIRECT_KEY);
  });
});
