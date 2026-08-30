// Telegram tests cover message-session routing and persisted model inheritance.
import { createRequire } from "node:module";
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";
import { createTelegramMessageSessionRuntime } from "./bot-handlers.message-context.js";

function createRuntime(entries: Record<string, SessionEntry>, storePath: string) {
  const getSessionEntry = vi.fn<NonNullable<TelegramBotDeps["getSessionEntry"]>>(
    ({ sessionKey }) => entries[sessionKey],
  );
  const telegramDeps = {
    resolveStorePath: vi.fn(() => storePath),
    getSessionEntry,
  } as Pick<TelegramBotDeps, "resolveStorePath" | "getSessionEntry"> as TelegramBotDeps;
  const { resolveTelegramSessionState } = createTelegramMessageSessionRuntime({
    accountId: "default",
    resolveTelegramGroupConfig: () => ({}),
    telegramDeps,
  });
  return { resolveTelegramSessionState, getSessionEntry };
}

describe("createTelegramMessageSessionRuntime", () => {
  it("does not activate an unused configured default while reading the session model", () => {
    const storePath = "/tmp/telegram-sessions.sqlite";
    const sessionKey = "agent:main:main:thread:12345:99";
    const entry: SessionEntry = {
      sessionId: "child",
      updatedAt: 2,
      modelProvider: "selected-provider",
      model: "selected-model",
    };
    const { resolveTelegramSessionState, getSessionEntry } = createRuntime(
      { [sessionKey]: entry },
      storePath,
    );
    const tsxApi: typeof import("tsx/cjs/api") = createRequire(import.meta.url)("tsx/cjs/api");
    const coldRuntime = vi.spyOn(tsxApi, "require").mockImplementation(() => {
      throw new Error("unused configured model entered provider runtime");
    });
    try {
      const state = resolveTelegramSessionState({
        chatId: 12345,
        isGroup: false,
        threadSpec: { id: 99, scope: "dm" },
        botHasTopicsEnabled: true,
        senderId: 12345,
        runtimeCfg: { agents: { defaults: { model: "unused-provider/unused-model" } } },
      });

      expect(state).toEqual({
        agentId: "main",
        sessionEntry: entry,
        sessionKey,
        storePath,
        model: "selected-provider/selected-model",
      });
      expect(getSessionEntry.mock.calls.map(([params]) => params)).toEqual([
        { storePath, sessionKey },
        { storePath, sessionKey: "agent:main:main" },
      ]);
      expect(coldRuntime).not.toHaveBeenCalled();
    } finally {
      coldRuntime.mockRestore();
    }
  });

  it("inherits a DM topic model override through keyed session loads", () => {
    const storePath = "/tmp/telegram-sessions.sqlite";
    const childSessionKey = "agent:main:main:thread:12345:99";
    const parentSessionKey = "agent:main:main";
    const entries: Record<string, SessionEntry> = {
      [childSessionKey]: { sessionId: "child", updatedAt: 2 },
      [parentSessionKey]: {
        sessionId: "parent",
        updatedAt: 1,
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-7",
        modelOverrideSource: "user",
      },
    };
    const { resolveTelegramSessionState, getSessionEntry } = createRuntime(entries, storePath);

    const state = resolveTelegramSessionState({
      chatId: 12345,
      isGroup: false,
      threadSpec: { id: 99, scope: "dm" },
      botHasTopicsEnabled: true,
      senderId: 12345,
      runtimeCfg: {},
    });

    expect(state.sessionKey).toBe(childSessionKey);
    expect(state.model).toBe("anthropic/claude-opus-4-7");
    expect(getSessionEntry.mock.calls.map(([params]) => params)).toEqual([
      { storePath, sessionKey: childSessionKey },
      { storePath, sessionKey: parentSessionKey },
    ]);
  });
});
