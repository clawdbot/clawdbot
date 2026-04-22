import fs from "node:fs/promises";
import path from "node:path";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/config-runtime";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  updateSessionStore,
} from "openclaw/plugin-sdk/config-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "../../../src/test-helpers/temp-dir.js";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const TELEGRAM_DIRECT_KEY = "agent:main:telegram:direct:7463849194";

describe("Telegram direct session recreation after delete", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-telegram-context-recreate-",
  });

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearSessionStoreCacheForTest();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  it("records a deleted direct session again when the next DM is processed", async () => {
    const tempDir = await suiteRootTracker.make("direct");
    const storePath = path.join(tempDir, "sessions.json");
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
          workspace: "/tmp/openclaw",
        },
      },
      channels: { telegram: {} },
      messages: { groupChat: { mentionPatterns: [] } },
      session: {
        dmScope: "per-channel-peer" as const,
        store: storePath,
      },
    };
    setRuntimeConfigSnapshot(cfg as never);
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

    const context = await buildTelegramMessageContextForTest({
      cfg,
      message: {
        message_id: 2,
        chat: { id: 7463849194, type: "private" },
        date: 1_700_000_001,
        text: "hello again",
        from: { id: 7463849194, first_name: "Alice" },
      },
      sessionRuntime: null,
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(context?.ctxPayload?.SessionKey).toBe(TELEGRAM_DIRECT_KEY);
    expect(store[TELEGRAM_DIRECT_KEY]).toEqual(
      expect.objectContaining({
        lastChannel: "telegram",
        lastTo: "telegram:7463849194",
        origin: expect.objectContaining({
          provider: "telegram",
          chatType: "direct",
        }),
      }),
    );
  });
});
