import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as modelSessionRuntime from "openclaw/plugin-sdk/model-session-runtime";
import { describe, expect, it, vi } from "vitest";
import { applyTelegramModelCallbackSelection } from "./bot-handlers.callback-model-selection.js";

type ResolveStorePathFn =
  typeof import("openclaw/plugin-sdk/session-store-runtime").resolveStorePath;

describe("applyTelegramModelCallbackSelection", () => {
  it("fails closed when the routed session changes during catalog lookup", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
          models: { "openai/gpt-5.4": {} },
        },
        list: [{ id: "agent-a", default: true }, { id: "agent-b" }],
      },
    };
    const sessionEntry = { sessionId: "session-a", updatedAt: Date.now() };
    let routedSession = {
      agentId: "agent-a",
      sessionKey: "agent:agent-a:telegram:direct:1234",
      storePath: "/tmp/agent-a-sessions.json",
      sessionEntry,
      model: "openai/gpt-5.4",
    };
    const catalogStarted = createDeferred<void>();
    const finishCatalog = createDeferred<void>();
    const buildModelsProviderData = vi.fn(async () => {
      catalogStarted.resolve();
      await finishCatalog.promise;
      return {
        providers: ["openai"],
        byProvider: new Map([["openai", new Set(["gpt-5.4"])]]),
        modelCatalog: [{ provider: "openai", id: "gpt-5.4" }],
      };
    });
    const editMessageWithButtons = vi.fn(async () => undefined);
    const appliedSelection = {
      status: "applied",
      changed: true,
      provider: "openai",
      model: "gpt-5.4",
      effectiveModelRef: "openai/gpt-5.4",
      agentRuntime: "openclaw",
      contextTokens: 0,
    } satisfies Awaited<ReturnType<typeof modelSessionRuntime.applySessionModelSelection>>;
    const applySessionModelSelection = vi
      .spyOn(modelSessionRuntime, "applySessionModelSelection")
      .mockResolvedValue(appliedSelection);
    const telegramDeps = {
      getRuntimeConfig: () => cfg,
      buildModelsProviderData,
      resolveStorePath: ((_store, { agentId } = {}) =>
        `/tmp/${agentId}-sessions.json`) satisfies ResolveStorePathFn,
      getSessionEntry: () => sessionEntry,
    };

    try {
      const callbackPromise = applyTelegramModelCallbackSelection({
        callback: { type: "select", provider: "openai", model: "gpt-5.4" },
        expectedSelection: { provider: "openai", model: "gpt-5.4" },
        chatId: 1234,
        isGroup: false,
        threadSpec: { scope: "dm" },
        botHasTopicsEnabled: false,
        senderId: "9",
        telegramDeps: telegramDeps as never,
        messageRuntime: {
          resolveTelegramSessionState: vi.fn(() => routedSession),
        },
        editMessageWithButtons,
        reauthorizeCallback: async () => true,
      });

      await catalogStarted.promise;
      routedSession = {
        agentId: "agent-b",
        sessionKey: "agent:agent-b:telegram:direct:1234",
        storePath: "/tmp/agent-b-sessions.json",
        sessionEntry: { sessionId: "session-b", updatedAt: Date.now() },
        model: "openai/gpt-5.4",
      };
      finishCatalog.resolve();
      await callbackPromise;

      expect(applySessionModelSelection).not.toHaveBeenCalled();
      expect(editMessageWithButtons).toHaveBeenCalledWith(
        "❌ Model routing changed while this selection was loading. Reopen /model and try again.",
        [],
      );
    } finally {
      finishCatalog.resolve();
      applySessionModelSelection.mockRestore();
    }
  });
});
