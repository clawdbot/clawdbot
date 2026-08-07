import { describe, expect, it, vi } from "vitest";
import type { Model } from "../../llm/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
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

function getMessageText(message: AgentMessage | undefined): string | undefined {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content) && content[0] && typeof content[0] === "object"
    ? (content[0] as { text?: string }).text
    : undefined;
}

function getEventHandler(session: Awaited<ReturnType<typeof createSession>>) {
  const eventTarget = session as unknown as {
    handleAgentEvent(event: AgentEvent): Promise<void>;
  };
  return async (event: AgentEvent) => await eventTarget.handleAgentEvent(event);
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("AgentSession steering receipts", () => {
  it("cancels identical queued text by exact receipt", async () => {
    const session = await createSession();
    const coreSteer = vi.spyOn(session.agent, "steerWithReceipt");
    const first = session.steerWithReceipt("same delegated prompt");
    const second = session.steerWithReceipt("same delegated prompt");

    expect(session.getSteeringMessages()).toEqual([
      "same delegated prompt",
      "same delegated prompt",
    ]);
    await vi.waitFor(() => expect(coreSteer).toHaveBeenCalledTimes(2));
    expect(second.cancel()).toBe(true);
    expect(second.cancel()).toBe(false);
    expect(session.getSteeringMessages()).toEqual(["same delegated prompt"]);
    expect(first.cancel()).toBe(true);
    expect(session.getSteeringMessages()).toEqual([]);
    await expect(first.committed).rejects.toThrow("cancelled");
    await expect(second.committed).rejects.toThrow("cancelled");
    session.dispose();
  });

  it("cancels an unresolved preparation and prevents late queue admission", async () => {
    const session = await createSession();
    const coreSteer = vi.spyOn(session.agent, "steerWithReceipt");
    const input = createDeferred<{ text: string }>();
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "fallback transcript" },
      resolveInput: () => input.promise,
      target: createTestUserTurnTranscriptTarget(),
    });
    const resolveMessage = vi.spyOn(recorder, "resolveMessage");

    const receipt = session.steerWithReceipt("slow delegated prompt", undefined, recorder);

    expect(session.getSteeringMessages()).toEqual(["slow delegated prompt"]);
    expect(coreSteer).not.toHaveBeenCalled();
    expect(receipt.cancel()).toBe(true);
    await expect(receipt.committed).rejects.toThrow("cancelled");

    input.resolve({ text: "resolved transcript" });
    await vi.waitFor(() => expect(resolveMessage).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(coreSteer).not.toHaveBeenCalled();
    expect(session.pendingMessageCount).toBe(0);
    session.dispose();
  });

  it("preserves reservation order across asynchronous preparation", async () => {
    const session = await createSession();
    const coreSteer = vi.spyOn(session.agent, "steerWithReceipt");
    const input = createDeferred<{ text: string }>();
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "first transcript" },
      resolveInput: () => input.promise,
      target: createTestUserTurnTranscriptTarget(),
    });

    const first = session.steerWithReceipt("first delegated prompt", undefined, recorder);
    const second = session.steerWithReceipt("second delegated prompt");

    await Promise.resolve();
    expect(coreSteer).not.toHaveBeenCalled();

    input.resolve({ text: "resolved first transcript" });
    await vi.waitFor(() => expect(coreSteer).toHaveBeenCalledTimes(2));
    expect(coreSteer.mock.calls.map((call) => getMessageText(call[0]))).toEqual([
      "first delegated prompt",
      "second delegated prompt",
    ]);

    expect(first.cancel()).toBe(true);
    expect(second.cancel()).toBe(true);
    await expect(first.committed).rejects.toThrow("cancelled");
    await expect(second.committed).rejects.toThrow("cancelled");
    session.dispose();
  });

  it("admits a ready follower when an earlier preparation is cancelled", async () => {
    const session = await createSession();
    const coreSteer = vi.spyOn(session.agent, "steerWithReceipt");
    const input = createDeferred<{ text: string }>();
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "first transcript" },
      resolveInput: () => input.promise,
      target: createTestUserTurnTranscriptTarget(),
    });

    const first = session.steerWithReceipt("blocked delegated prompt", undefined, recorder);
    const second = session.steerWithReceipt("ready delegated prompt");

    await Promise.resolve();
    expect(coreSteer).not.toHaveBeenCalled();
    expect(first.cancel()).toBe(true);
    await expect(first.committed).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(coreSteer).toHaveBeenCalledOnce());
    expect(getMessageText(coreSteer.mock.calls[0]?.[0])).toBe("ready delegated prompt");

    input.resolve({ text: "late first transcript" });
    await Promise.resolve();
    expect(coreSteer).toHaveBeenCalledOnce();

    expect(second.cancel()).toBe(true);
    await expect(second.committed).rejects.toThrow("cancelled");
    session.dispose();
  });

  it("rejects failed preparation and admits the next steering message", async () => {
    const session = await createSession();
    const prepareError = new Error("transcript preparation failed");
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "visible prompt" },
      target: createTestUserTurnTranscriptTarget(),
    });
    recorder.resolveMessage = vi.fn(async () => {
      throw prepareError;
    });
    const coreSteer = vi.spyOn(session.agent, "steerWithReceipt");

    const failed = session.steerWithReceipt("failed delegated prompt", undefined, recorder);

    await expect(failed.committed).rejects.toBe(prepareError);
    expect(session.pendingMessageCount).toBe(0);
    expect(coreSteer).not.toHaveBeenCalled();

    const recovered = session.steerWithReceipt("recovered delegated prompt");
    await vi.waitFor(() => expect(coreSteer).toHaveBeenCalledOnce());
    expect(recovered.cancel()).toBe(true);
    await expect(recovered.committed).rejects.toThrow("cancelled");
    session.dispose();
  });

  it("settles only after the queued user message is persisted", async () => {
    const sessionManager = SessionManager.inMemory();
    const session = await createSession(sessionManager);
    const coreSteer = vi.spyOn(session.agent, "steerWithReceipt");
    const receipt = session.steerWithReceipt("durable delegated prompt");
    await vi.waitFor(() => expect(coreSteer).toHaveBeenCalledOnce());
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
    const receipt = session.steerWithReceipt("persistence must succeed");
    await vi.waitFor(() => expect(coreSteer).toHaveBeenCalledOnce());
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

  it("keeps a drained receipt until persistence owns its settlement", async () => {
    const session = await createSession();
    const coreSteer = vi
      .spyOn(session.agent, "steerWithReceipt")
      .mockImplementation(() => ({ cancel: () => false }));
    const receipt = session.steerWithReceipt("already drained");
    await vi.waitFor(() => expect(coreSteer).toHaveBeenCalledOnce());
    const message = getQueuedMessage(coreSteer.mock.calls);

    expect(session.clearQueue().steering).toEqual([]);
    expect(session.pendingMessageCount).toBe(0);
    let settled = false;
    void receipt.committed.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await getEventHandler(session)({ type: "message_end", message });
    await receipt.committed;
    expect(settled).toBe(true);
    session.dispose();
  });

  it("clears preparing and queued receipts from a stable snapshot", async () => {
    const session = await createSession();
    const input = createDeferred<{ text: string }>();
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "fallback transcript" },
      resolveInput: () => input.promise,
      target: createTestUserTurnTranscriptTarget(),
    });
    const coreSteer = vi.spyOn(session.agent, "steerWithReceipt");
    const receipts = [
      session.steerWithReceipt("clear queued one"),
      session.steerWithReceipt("clear queued two"),
      session.steerWithReceipt("clear preparing", undefined, recorder),
    ];
    await vi.waitFor(() => expect(coreSteer).toHaveBeenCalledTimes(2));

    expect(session.clearQueue().steering).toEqual([
      "clear queued one",
      "clear queued two",
      "clear preparing",
    ]);
    expect(session.pendingMessageCount).toBe(0);
    await Promise.all(
      receipts.map(async (receipt) => await expect(receipt.committed).rejects.toThrow("cleared")),
    );

    input.resolve({ text: "late transcript" });
    await Promise.resolve();
    await Promise.resolve();
    expect(coreSteer).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it("rejects preparing and started receipts during disposal", async () => {
    const session = await createSession();
    const input = createDeferred<{ text: string }>();
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "fallback transcript" },
      resolveInput: () => input.promise,
      target: createTestUserTurnTranscriptTarget(),
    });
    const coreSteer = vi.spyOn(session.agent, "steerWithReceipt");
    const started = session.steerWithReceipt("dispose started");
    await vi.waitFor(() => expect(coreSteer).toHaveBeenCalledOnce());
    const message = getQueuedMessage(coreSteer.mock.calls);
    await getEventHandler(session)({ type: "message_start", message });
    const preparing = session.steerWithReceipt("dispose preparing", undefined, recorder);

    session.dispose();

    await expect(preparing.committed).rejects.toThrow("disposed");
    await expect(started.committed).rejects.toThrow("disposed");
    input.resolve({ text: "late transcript" });
    await Promise.resolve();
    expect(coreSteer).toHaveBeenCalledOnce();
  });
});
