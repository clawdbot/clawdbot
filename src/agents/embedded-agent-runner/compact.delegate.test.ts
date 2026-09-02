import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createAssistant,
  createAssistantResultStream,
  testModel,
} from "../sessions/agent-session-loop-correctness.test-support.js";
import type { ProviderConfigInput } from "../sessions/model-registry.js";
import {
  applyExtraParamsToAgentMock,
  hookRunner,
  limitHistoryTurnsMock,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
  resolveModelMock,
} from "./compact.hooks.harness.js";

const { requestPreparedCompaction } = vi.hoisted(() => ({
  requestPreparedCompaction:
    vi.fn<typeof import("@openclaw/ai/transports").requestPreparedOpenAIResponsesCompaction>(),
}));
vi.mock("@openclaw/ai/transports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/ai/transports")>()),
  requestPreparedOpenAIResponsesCompaction: requestPreparedCompaction,
}));

let delegate: typeof import("../../context-engine/delegate.js").delegateCompactionToRuntime;
let sessions: typeof import("../sessions/index.js");
let accessor: typeof import("../../config/sessions/session-accessor.js");
let databases: typeof import("../../state/openclaw-agent-db.js");
let streamResolution: typeof import("./stream-resolution.js");
let replay: typeof import("../openai-transport-stream.test-support.js").testing;
let accounting: typeof import("./run/compaction-accounting-bridge.js");
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    databases.closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);
let workspaceDir: string;
const model = {
  ...testModel,
  id: "compaction-fixture",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 128_000,
  maxTokens: 1_024,
};
const summary = "The deployment checklist was reviewed. Compare the remaining options.";

beforeAll(async () => {
  // Reuse the hook harness's provider setup with the real constructor, SQLite
  // manager, transcript guard, and both compaction owners left intact.
  await loadCompactHooksHarness({ durableSession: true });
  [
    { delegateCompactionToRuntime: delegate },
    sessions,
    accessor,
    databases,
    streamResolution,
    { testing: replay },
    accounting,
  ] = await Promise.all([
    import("../../context-engine/delegate.js"),
    import("../sessions/index.js"),
    import("../../config/sessions/session-accessor.js"),
    import("../../state/openclaw-agent-db.js"),
    import("./stream-resolution.js"),
    import("../openai-transport-stream.test-support.js"),
    import("./run/compaction-accounting-bridge.js"),
  ]);
});

beforeEach(async () => {
  workspaceDir = tempDirs.make("openclaw-compaction-delegate-");
  resetCompactHooksHarnessMocks(workspaceDir);
  const actualScope =
    await vi.importActual<typeof import("../agent-scope.js")>("../agent-scope.js");
  const scope = await import("../agent-scope.js");
  vi.mocked(scope.listAgentEntries).mockImplementation(actualScope.listAgentEntries);
  vi.mocked(scope.resolveSessionAgentId).mockImplementation(actualScope.resolveSessionAgentId);
  vi.mocked(scope.resolveSessionAgentIds).mockImplementation(actualScope.resolveSessionAgentIds);
  requestPreparedCompaction.mockReset();
  limitHistoryTurnsMock.mockImplementation((messages) => messages);
  hookRunner.hasHooks.mockImplementation(
    (name) => name === "before_compaction" || name === "after_compaction",
  );
});

async function createFixture(operation: "summary" | "endpoint", globalAlias = false) {
  const target = {
    agentId: globalAlias ? "marketing" : "main",
    sessionId: "compaction-session",
    sessionKey: globalAlias ? "global" : "agent:main:compaction-session",
    storePath: join(workspaceDir, "alternate", "openclaw-agent.sqlite"),
  };
  const configuredStore = join(workspaceDir, "configured", "openclaw-agent.sqlite");
  await accessor.upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  // The same physical id in another store must not redirect partial-target resolution.
  const decoy = { ...target, storePath: configuredStore };
  await accessor.upsertSessionEntryCore(decoy, { sessionId: target.sessionId, updatedAt: 1 });
  const decoyManager = sessions.SessionManager.open(decoy, workspaceDir);
  decoyManager.appendMessage({ role: "user", content: "Unrelated store history", timestamp: 1 });
  decoyManager.flushPendingPersistence();
  const sessionManager = sessions.SessionManager.open(target, workspaceDir);
  sessionManager.appendModelChange(model.provider, model.id);
  sessionManager.appendThinkingLevelChange("off");
  for (const content of [
    "Review the deployment checklist.",
    "Compare the remaining options.",
    "Keep the rollout notes.",
  ]) {
    sessionManager.appendMessage({ role: "user", content, timestamp: 1 });
    sessionManager.appendMessage(
      createAssistant(model, [{ type: "text", text: `Recorded: ${content}` }]),
    );
  }
  sessionManager.flushPendingPersistence();
  const originalMessages = sessionManager.buildSessionContext().messages;
  const originalEntries = sessionManager.getEntries();
  const stream = vi.fn<NonNullable<ProviderConfigInput["streamSimple"]>>((activeModel) =>
    createAssistantResultStream(createAssistant(activeModel, [{ type: "text", text: summary }])),
  );
  const authStorage = sessions.AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, "test-api-key");
  const modelRegistry = sessions.ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(model.provider, { api: model.api, streamSimple: stream });
  resolveModelMock.mockReturnValue({ model, error: null, authStorage, modelRegistry });
  vi.mocked(streamResolution.resolveEmbeddedAgentStream).mockReturnValue({
    streamFn: stream,
    strategy: "session-custom",
  });
  applyExtraParamsToAgentMock.mockReturnValue({
    effectiveExtraParams: { responsesCompactEndpoint: operation === "endpoint" },
  });
  requestPreparedCompaction.mockResolvedValue({
    item: { type: "compaction", id: "cmp_fixture", encrypted_content: "opaque-fixture" },
    output: [{ type: "compaction", id: "cmp_fixture", encrypted_content: "opaque-fixture" }],
    historyMode: "compacted-prefix",
    usage: { input_tokens: 1_000, output_tokens: 200 },
    model,
    replayMetadata: replay.buildOpenAIResponsesReasoningReplayMetadata(model, {
      sessionId: target.sessionId,
    }),
  });
  const runtimeContext = {
    workspaceDir,
    provider: model.provider,
    model: model.id,
    trigger: "manual",
    thinkLevel: "off",
    config: {
      session: { store: configuredStore },
      agents: {
        ownership: "explicit",
        list: [{ id: "main" }, { id: "marketing" }],
        defaults: { compaction: { mode: "default", keepRecentTokens: 1, postIndexSync: "off" } },
      },
    },
  };
  const recordUsage = vi.fn();
  const recordCompaction = vi.fn();
  accounting.attachCompactionAccountingRecorder(runtimeContext, { recordUsage, recordCompaction });
  return {
    target,
    decoy,
    originalEntries,
    originalMessages,
    runtimeContext,
    stream,
    recordUsage,
    recordCompaction,
  };
}

describe("direct compactor through the context-engine delegate", () => {
  it.each([
    { operation: "summary", partial: false, threadId: "thread-route" },
    { operation: "summary", partial: true, threadId: 0 },
    { operation: "endpoint", partial: false, threadId: 0 },
    { operation: "endpoint", partial: true, threadId: "thread-route" },
    { operation: "summary", partial: false, threadId: undefined },
  ] as const)(
    "returns durable $operation identity (partial=$partial, thread=$threadId)",
    async ({ operation, partial, threadId }) => {
      const fixture = await createFixture(operation, partial);
      const { target } = fixture;
      const sessionTarget = {
        ...(partial ? { agentId: target.agentId, storePath: target.storePath } : target),
        ...(threadId !== undefined ? { threadId } : {}),
        expectedWriterRunId: "caller-private-writer",
        expectedLifecycleRevision: "caller-private-revision",
        unrelatedCapability: "caller-private-capability",
      };
      const result = await delegate({
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget,
        runtimeContext: fixture.runtimeContext,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, compacted: true });
      const returned = result.result?.sessionTarget;
      expect(returned).toEqual({ ...target, ...(threadId !== undefined ? { threadId } : {}) });
      expect(result.result).not.toHaveProperty("sessionFile");
      if (
        !returned?.agentId ||
        !returned.sessionId ||
        !returned.sessionKey ||
        !returned.storePath
      ) {
        throw new Error("Compactor must return its complete resolved identity");
      }
      // Close the actual DB handles before observing the returned identity and history.
      databases.closeOpenClawAgentDatabasesForTest();
      const reopened = sessions.SessionManager.open({
        agentId: returned.agentId,
        sessionId: returned.sessionId,
        sessionKey: returned.sessionKey,
        storePath: returned.storePath,
      });
      expect(reopened.getSessionId()).toBe(target.sessionId);
      expect(accessor.loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
      const messages = reopened.buildSessionContext().messages;
      if (operation === "summary") {
        expect(result.result?.summary).toContain(summary);
        expect(reopened.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
        const firstKeptIndex = fixture.originalEntries.findIndex(
          (entry) => entry.id === result.result?.firstKeptEntryId,
        );
        expect(firstKeptIndex).toBeGreaterThan(0);
        const retained = fixture.originalEntries
          .slice(firstKeptIndex)
          .filter((entry) => entry.type === "message")
          .map((entry) => entry.message);
        expect(retained.length).toBeGreaterThan(0);
        expect(messages.slice(-retained.length)).toEqual(retained);
        for (const entry of fixture.originalEntries) {
          expect(reopened.getEntries()).toContainEqual(entry);
        }
        expect(fixture.stream).toHaveBeenCalled();
        expect(requestPreparedCompaction).not.toHaveBeenCalled();
      } else {
        expect(result.result?.summary).toBeUndefined();
        expect(result.result?.details).toMatchObject({ compactionKind: "server-endpoint" });
        expect(messages).toMatchObject(fixture.originalMessages);
        expect(messages.at(-1)).toMatchObject({
          providerReplay: { data: "opaque-fixture", compactedWindow: { state: "ready" } },
        });
        expect(requestPreparedCompaction).toHaveBeenCalledOnce();
        expect(fixture.stream).not.toHaveBeenCalled();
      }
      expect(fixture.recordUsage).toHaveBeenCalled();
      expect(fixture.recordCompaction).toHaveBeenCalledOnce();
      expect(hookRunner.runBeforeCompaction).toHaveBeenCalledOnce();
      expect(hookRunner.runAfterCompaction).toHaveBeenCalledOnce();
      expect(sessions.SessionManager.open(fixture.decoy).buildSessionContext().messages).toEqual([
        { role: "user", content: "Unrelated store history", timestamp: 1 },
      ]);
    },
  );

  it.each(["summary", "endpoint"] as const)(
    "cancels %s without publishing or rewriting history",
    async (operation) => {
      const fixture = await createFixture(operation);
      const started = createDeferred();
      const stopped = createDeferred();
      const controller = new AbortController();
      const abortReason = new Error("caller cancelled compaction");
      if (operation === "endpoint") {
        requestPreparedCompaction.mockImplementationOnce(
          async (_stream, _model, _context, options) => {
            started.resolve();
            return await new Promise<never>((_, reject) => {
              options.signal?.addEventListener(
                "abort",
                () => {
                  stopped.resolve();
                  reject(abortReason);
                },
                { once: true },
              );
            });
          },
        );
      } else {
        const { createAssistantMessageEventStream } = await import("openclaw/plugin-sdk/llm");
        fixture.stream.mockImplementationOnce((activeModel, _context, options) => {
          const stream = createAssistantMessageEventStream();
          started.resolve();
          options?.signal?.addEventListener(
            "abort",
            () => {
              stream.push({
                type: "error",
                reason: "aborted",
                error: createAssistant(activeModel, [], "aborted"),
              });
              stream.end();
              stopped.resolve();
            },
            { once: true },
          );
          return stream;
        });
      }
      const pending = delegate({
        sessionId: fixture.target.sessionId,
        sessionKey: fixture.target.sessionKey,
        sessionTarget: { ...fixture.target, threadId: 0 },
        runtimeContext: fixture.runtimeContext,
        abortSignal: controller.signal,
      });
      await started.promise;
      controller.abort(abortReason);
      const result = await pending;
      await stopped.promise;
      expect(result).toMatchObject({ ok: false, compacted: false });
      expect(result.result).toBeUndefined();
      databases.closeOpenClawAgentDatabasesForTest();
      const reopened = sessions.SessionManager.open(fixture.target);
      expect(reopened.getSessionId()).toBe(fixture.target.sessionId);
      expect(reopened.getEntries()).toEqual(fixture.originalEntries);
      expect(reopened.buildSessionContext().messages).toEqual(fixture.originalMessages);
      expect(fixture.recordCompaction).not.toHaveBeenCalled();
      expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
    },
  );

  it("rejects contradictory physical identity without touching either durable transcript", async () => {
    const fixture = await createFixture("summary");
    await expect(
      delegate({
        sessionId: "contradictory-session",
        sessionKey: fixture.target.sessionKey,
        sessionTarget: fixture.target,
        runtimeContext: fixture.runtimeContext,
      }),
    ).rejects.toThrow("conflicts with the caller session identity");
    expect(fixture.stream).not.toHaveBeenCalled();
    expect(resolveModelMock).not.toHaveBeenCalled();
    expect(hookRunner.runBeforeCompaction).not.toHaveBeenCalled();
    databases.closeOpenClawAgentDatabasesForTest();
    expect(sessions.SessionManager.open(fixture.target).getEntries()).toEqual(
      fixture.originalEntries,
    );
    expect(sessions.SessionManager.open(fixture.decoy).buildSessionContext().messages).toEqual([
      { role: "user", content: "Unrelated store history", timestamp: 1 },
    ]);
  });
});
