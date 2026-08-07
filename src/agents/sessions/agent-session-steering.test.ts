import { describe, expect, it, vi } from "vitest";
import type { Model } from "../../llm/types.js";
import type { AgentEvent, AgentMessage } from "../runtime/index.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const testModel: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

function createResourceLoader(): ResourceLoader {
  const extensions: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

async function createSession(sessionManager = SessionManager.inMemory()) {
  const { session } = await createAgentSession({
    authStorage: AuthStorage.inMemory(),
    model: testModel,
    resourceLoader: createResourceLoader(),
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
    modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
  });
  return session;
}

function getQueuedMessage(calls: ReadonlyArray<readonly [AgentMessage]>): AgentMessage {
  const message = calls[0]?.[0];
  if (!message) {
    throw new Error("expected queued steering message");
  }
  return message;
}

function getEventHandler(session: Awaited<ReturnType<typeof createSession>>) {
  const eventTarget = session as unknown as {
    handleAgentEvent(event: AgentEvent): Promise<void>;
  };
  return async (event: AgentEvent) => await eventTarget.handleAgentEvent(event);
}

describe("AgentSession steering receipts", () => {
  it("cancels identical queued text by exact receipt", async () => {
    const session = await createSession();
    const first = await session.steerWithReceipt("same delegated prompt");
    const second = await session.steerWithReceipt("same delegated prompt");

    expect(session.getSteeringMessages()).toEqual([
      "same delegated prompt",
      "same delegated prompt",
    ]);
    expect(second.cancel()).toBe(true);
    expect(second.cancel()).toBe(false);
    expect(session.getSteeringMessages()).toEqual(["same delegated prompt"]);
    expect(first.cancel()).toBe(true);
    expect(session.getSteeringMessages()).toEqual([]);
    await expect(first.committed).rejects.toThrow("cancelled");
    await expect(second.committed).rejects.toThrow("cancelled");
    session.dispose();
  });

  it("settles only after the queued user message is persisted", async () => {
    const sessionManager = SessionManager.inMemory();
    const session = await createSession(sessionManager);
    const coreSteer = vi.spyOn(session.agent, "steerWithReceipt");
    const receipt = await session.steerWithReceipt("durable delegated prompt");
    const message = getQueuedMessage(coreSteer.mock.calls);
    const handleAgentEvent = getEventHandler(session);
    let persisted = false;
    let committed = false;
    const appendMessage = sessionManager.appendMessage.bind(sessionManager);
    vi.spyOn(sessionManager, "appendMessage").mockImplementation((...args) => {
      expect(committed).toBe(false);
      const entryId = appendMessage(...args);
      persisted = true;
      return entryId;
    });
    void receipt.committed.then(() => {
      expect(persisted).toBe(true);
      committed = true;
    });

    await handleAgentEvent({ type: "message_start", message });
    expect(committed).toBe(false);
    expect(session.getSteeringMessages()).toEqual([]);

    await handleAgentEvent({ type: "message_end", message });
    await receipt.committed;

    expect(persisted).toBe(true);
    expect(committed).toBe(true);
    session.dispose();
  });

  it("rejects when user-message persistence fails", async () => {
    const sessionManager = SessionManager.inMemory();
    const session = await createSession(sessionManager);
    const coreSteer = vi.spyOn(session.agent, "steerWithReceipt");
    const receipt = await session.steerWithReceipt("persistence must succeed");
    const message = getQueuedMessage(coreSteer.mock.calls);
    const handleAgentEvent = getEventHandler(session);
    await handleAgentEvent({ type: "message_start", message });
    const persistenceError = new Error("transcript write failed");
    vi.spyOn(sessionManager, "appendMessage").mockImplementationOnce(() => {
      throw persistenceError;
    });

    await expect(handleAgentEvent({ type: "message_end", message })).rejects.toBe(persistenceError);
    await expect(receipt.committed).rejects.toBe(persistenceError);
    session.dispose();
  });

  it("clears every pending receipt from a stable snapshot", async () => {
    const session = await createSession();
    const receipts = await Promise.all([
      session.steerWithReceipt("clear one"),
      session.steerWithReceipt("clear two"),
      session.steerWithReceipt("clear three"),
    ]);

    expect(session.clearQueue().steering).toEqual(["clear one", "clear two", "clear three"]);
    expect(session.pendingMessageCount).toBe(0);
    await Promise.all(
      receipts.map(async (receipt) => await expect(receipt.committed).rejects.toThrow("cleared")),
    );
    session.dispose();
  });

  it("rejects every unsettled receipt during disposal", async () => {
    const session = await createSession();
    const receipts = await Promise.all([
      session.steerWithReceipt("dispose one"),
      session.steerWithReceipt("dispose two"),
      session.steerWithReceipt("dispose three"),
    ]);

    session.dispose();

    await Promise.all(
      receipts.map(async (receipt) => await expect(receipt.committed).rejects.toThrow("disposed")),
    );
  });
});
