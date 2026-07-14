/**
 * Tests Telegram session recreation helpers and persisted session mapping.
 */
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import { loadCombinedSessionStoreForGateway } from "../config/sessions/combined-store-gateway.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  recordInboundSessionMeta,
  replaceSessionEntry,
  updateSessionLastRoute,
} from "../config/sessions/session-accessor.js";
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

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  it("surfaces a deleted Telegram direct session again after the next inbound message", async () => {
    const tempDir = await suiteRootTracker.make("direct");
    const storePath = path.join(tempDir, "sessions.json");
    await replaceSessionEntry(
      { storePath, sessionKey: TELEGRAM_DIRECT_KEY },
      {
        sessionId: "old-session",
        updatedAt: 1_700_000_000_000,
        chatType: "direct",
        channel: "telegram",
      },
    );
    await deleteSessionEntryLifecycle({
      archiveTranscript: false,
      storePath,
      target: {
        canonicalKey: TELEGRAM_DIRECT_KEY,
        storeKeys: [TELEGRAM_DIRECT_KEY],
      },
    });
    expect(loadSessionEntry({ storePath, sessionKey: TELEGRAM_DIRECT_KEY })).toBeUndefined();

    const ctx = createTelegramDirectContext();
    await recordInboundSessionMeta({
      storePath,
      sessionKey: TELEGRAM_DIRECT_KEY,
      ctx,
    });
    await updateSessionLastRoute({
      storePath,
      sessionKey: TELEGRAM_DIRECT_KEY,
      channel: "telegram",
      to: "telegram:7463849194",
      accountId: "default",
      ctx,
    });

    const entry = loadSessionEntry({ storePath, sessionKey: TELEGRAM_DIRECT_KEY });
    const runtimeCfg = {
      ...cfg,
      session: { ...cfg.session, store: storePath },
    } satisfies OpenClawConfig;
    const loaded = loadCombinedSessionStoreForGateway(runtimeCfg, { agentId: "main" });
    const listed = listSessionsFromStore({
      cfg: runtimeCfg,
      storePath: loaded.storePath,
      store: loaded.store,
      opts: {},
    });

    expect(entry?.lastChannel).toBe("telegram");
    expect(entry?.lastTo).toBe("telegram:7463849194");
    expect(entry?.origin?.chatType).toBe("direct");
    expect(entry?.origin?.provider).toBe("telegram");
    expect(listed.sessions.map((session) => session.key)).toContain(TELEGRAM_DIRECT_KEY);
  });
});
