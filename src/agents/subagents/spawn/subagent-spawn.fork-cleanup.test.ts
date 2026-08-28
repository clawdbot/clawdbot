import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionDecisionWork } from "../../../audit/execution-decision-work.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { loadSubagentSpawnModuleForTest } from "./subagent-spawn.test-helpers.js";

type ForkSession =
  typeof import("../../../auto-reply/reply/session-fork.js").forkSessionEntryFromParent;
type SpawnSubagent = typeof import("./subagent-spawn.js").spawnSubagentDirect;
type SpawnFailure = "thread binding" | "context engine" | "launch" | "registration" | "collector";

describe("subagent fork context through SQLite and tool boundaries", () => {
  const parentKey = "agent:main:main";
  const parentId = "parent-session";
  let tempDir: string;
  let storePath: string;
  let config: OpenClawConfig;
  let threadBindingAvailable: boolean;
  let sessions: typeof import("../../../config/sessions/session-accessor.js");
  let forkSession: ForkSession;
  let spawnSubagentDirect: SpawnSubagent;
  let createSessionsSpawnTool: typeof import("../../tools/sessions-spawn-tool.js").createSessionsSpawnTool;
  let decisionWork: typeof import("../../../audit/execution-decision-work.js");
  let identityAdmission: typeof import("../../../audit/execution-identity-admission.js");
  let callerContext: typeof import("../../tools/gateway-caller-context.js");
  let closeAgentDatabases: () => void;
  let closeStateDatabase: () => void;
  let resetScheduler: () => void;
  let swarmScheduler: typeof import("../swarm/swarm-scheduler.js");
  let restoreActivation: (() => void) | undefined;
  let restoreUpsert: () => void;
  let failure: SpawnFailure;
  let forkedEntry: SessionEntry | undefined;
  const registerSubagentRun = vi.fn();
  const startQueuedSubagentRun = vi.fn();
  const settleFailedQueuedSubagentLaunch = vi.fn();
  const completeCollectorLaunchCleanup = vi.fn();
  const prepareSubagentSpawn = vi.fn();
  const dispatch = vi.fn();
  const fork = vi.fn(async (input: unknown) => {
    const params = input as Parameters<ForkSession>[0];
    const result = await forkSession(params);
    if (result.status === "forked") {
      forkedEntry = result.sessionEntry;
      // Establish that the real fork copied history before any injected failure.
      expect(
        await sessions.loadTranscriptEvents({
          agentId: "main",
          sessionId: result.sessionEntry.sessionId,
          sessionKey: params.sessionKey,
          storePath,
        }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({ content: "parent history" }),
          }),
        ]),
      );
    }
    return result;
  });

  beforeAll(async () => {
    ({ spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: vi.fn(() => {
        throw new Error("unexpected external Gateway call");
      }),
      hasInProcessGatewayContextMock: () => true,
      dispatchGatewayMethodInProcessMock: dispatch,
      forkSessionEntryFromParentMock: fork,
      registerSubagentRunMock: registerSubagentRun,
      startQueuedSubagentRunMock: startQueuedSubagentRun,
      settleFailedQueuedSubagentLaunchMock: settleFailedQueuedSubagentLaunch,
      completeCollectorLaunchCleanupMock: completeCollectorLaunchCleanup,
      resolveContextEngineMock: async () => ({ prepareSubagentSpawn }),
      resolveSubagentSpawnModelSelection: () => "openai/gpt-5.6-luna",
      getRuntimeConfig: () => config,
      getSessionBindingService: () => ({
        getCapabilities: () => ({
          adapterAvailable: threadBindingAvailable,
          bindSupported: threadBindingAvailable,
          placements: ["child"],
        }),
        bind: async (request) => ({
          targetSessionKey: request.targetSessionKey,
          status: "active",
          conversation: {
            channel: request.conversation.channel,
            accountId: request.conversation.accountId,
            conversationId: "fork-receipt-thread",
          },
        }),
        listBySession: () => [],
      }),
      loadSessionStoreMock: () =>
        Object.fromEntries(
          sessions
            .listSessionEntriesCore({ agentId: "main", storePath })
            .map(({ sessionKey, entry }) => [sessionKey, entry]),
        ),
      get sessionStorePath() {
        return storePath;
      },
    }));
    sessions = await import("../../../config/sessions/session-accessor.js");
    ({ forkSessionEntryFromParent: forkSession } =
      await import("../../../auto-reply/reply/session-fork.js"));
    ({ closeOpenClawAgentDatabasesForTest: closeAgentDatabases } =
      await import("../../../state/openclaw-agent-db.js"));
    ({ closeOpenClawStateDatabaseForTest: closeStateDatabase } =
      await import("../../../state/openclaw-state-db.js"));
    swarmScheduler = await import("../swarm/swarm-scheduler.js");
    const { testing } = await import("../swarm/swarm-scheduler.test-support.js");
    resetScheduler = testing.reset;
    const runtime = await import("./subagent-spawn.runtime.js");
    const upsert = vi
      .spyOn(runtime, "upsertSessionEntryCore")
      .mockImplementation(sessions.upsertSessionEntryCore);
    restoreUpsert = () => upsert.mockRestore();
    ({ createSessionsSpawnTool } = await import("../../tools/sessions-spawn-tool.js"));
    decisionWork = await import("../../../audit/execution-decision-work.js");
    identityAdmission = await import("../../../audit/execution-identity-admission.js");
    callerContext = await import("../../tools/gateway-caller-context.js");
  });

  beforeEach(async () => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fork-cleanup-")));
    storePath = path.join(tempDir, "sessions.json");
    config = {
      session: { store: storePath, mainKey: "main", scope: "per-sender" },
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      agents: {
        defaults: { workspace: tempDir, model: { primary: "openai/gpt-5.6-luna" } },
      },
    };
    threadBindingAvailable = false;
    failure = "context engine";
    forkedEntry = undefined;
    fork.mockClear();
    resetScheduler();
    registerSubagentRun.mockReset().mockImplementation(() => {
      if (failure === "registration") {
        throw new Error("registration failed");
      }
    });
    startQueuedSubagentRun.mockReset().mockReturnValue(false);
    settleFailedQueuedSubagentLaunch.mockReset().mockReturnValue(true);
    completeCollectorLaunchCleanup.mockReset();
    prepareSubagentSpawn.mockReset().mockImplementation(async () => {
      if (failure === "context engine") {
        throw new Error("context engine failed");
      }
    });
    dispatch
      .mockReset()
      .mockImplementation(async (method: string, params: Record<string, unknown>) => {
        if (method === "agent") {
          if (failure === "launch") {
            throw new Error("launch failed");
          }
          return { runId: "accepted-child-run", status: "accepted" };
        }
        if (method === "chat.abort") {
          throw new Error("abort unavailable");
        }
        if (method !== "sessions.delete") {
          throw new Error(`unexpected Gateway method ${method}`);
        }
        const { key, expectedSessionId, expectedLifecycleRevision, deleteTranscript } = params as {
          key: string;
          expectedSessionId: string;
          expectedLifecycleRevision: string;
          deleteTranscript: boolean;
        };
        expect(expectedSessionId).toEqual(expect.any(String));
        expect(expectedLifecycleRevision).toEqual(expect.any(String));
        // Deletion transport is replaced: the same guard used by sessions.delete
        // decides whether the stored row and its transcript can actually be removed.
        const result = await sessions.deleteSessionEntryLifecycle({
          agentId: "main",
          storePath,
          target: { canonicalKey: key, storeKeys: [key] },
          expectedSessionId,
          expectedLifecycleRevision,
          archiveTranscript: deleteTranscript,
        });
        if (result.expectedEntryMismatch) {
          throw Object.assign(new Error("session changed"), {
            name: "GatewayClientRequestError",
            gatewayCode: "INVALID_REQUEST",
            details: { reason: "session-changed" },
          });
        }
        return result;
      });
    await sessions.replaceSessionEntry(
      { agentId: "main", sessionKey: parentKey, storePath },
      {
        sessionId: parentId,
        lifecycleRevision: "parent-revision",
        updatedAt: Date.now(),
      },
    );
    // Seed a completed exchange so injected failures happen after a real history fork.
    for (const message of [
      { role: "user", content: "parent history" },
      { role: "assistant", content: "parent answer", stopReason: "stop" },
    ]) {
      await sessions.appendTranscriptMessage(
        { agentId: "main", sessionId: parentId, sessionKey: parentKey, storePath },
        { message },
      );
    }
  });

  afterEach(() => {
    restoreActivation?.();
    restoreActivation = undefined;
    resetScheduler();
    closeAgentDatabases();
    closeStateDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    restoreUpsert();
    vi.doUnmock("./subagent-spawn.runtime.js");
    vi.doUnmock("./subagent-depth.js");
    vi.doUnmock("../registry/subagent-registry.js");
    vi.doUnmock("../../provider-model-normalization.runtime.js");
  });

  it.each(["fork", "isolated"] as const)(
    "protects locked parent transcript ownership with context=%s",
    async (context) => {
      prepareSubagentSpawn.mockResolvedValue(undefined);
      const parentScope = {
        agentId: "main",
        sessionId: parentId,
        sessionKey: parentKey,
        storePath,
      };
      await sessions.upsertSessionEntryCore(parentScope, { modelSelectionLocked: true });
      const parentBefore = sessions.loadSessionEntry(parentScope);
      const parentHistory = await sessions.loadTranscriptEvents(parentScope);

      const result = await spawnSubagentDirect(
        { task: "do independent work", context },
        { agentSessionKey: parentKey },
      );

      if (context === "fork") {
        // The locked harness owns both model and transcript lineage; hidden children
        // must obey the same no-copy contract as whole-session creation.
        expect(result).toMatchObject({
          status: "error",
          error:
            "Model-selection-locked sessions cannot create child sessions from parent context.",
        });
        expect(forkedEntry).toBeUndefined();
        expect(prepareSubagentSpawn).not.toHaveBeenCalled();
        expect(dispatch.mock.calls.some(([method]) => method === "agent")).toBe(false);
        expect(
          sessions
            .listSessionEntriesCore({ agentId: "main", storePath })
            .map(({ sessionKey }) => sessionKey),
        ).toEqual([parentKey]);
      } else {
        expect(result.status).toBe("accepted");
        expect(fork).not.toHaveBeenCalled();
        const childSessionKey = expectDefined(result.childSessionKey, "isolated child key");
        const child = expectDefined(
          sessions.loadSessionEntry({ agentId: "main", sessionKey: childSessionKey, storePath }),
          "isolated child entry",
        );
        expect(child.sessionId).not.toBe(parentId);
        expect(child.modelSelectionLocked).not.toBe(true);
        expect(
          await sessions.loadTranscriptEvents({
            agentId: "main",
            sessionId: child.sessionId,
            sessionKey: childSessionKey,
            storePath,
          }),
        ).toEqual([]);
      }
      expect(sessions.loadSessionEntry(parentScope)).toEqual(parentBefore);
      expect(await sessions.loadTranscriptEvents(parentScope)).toEqual(parentHistory);
    },
  );

  it.each([
    {
      scenario: "omitted context uses the thread-default fork",
      args: { thread: true },
      parentTokens: undefined,
      preparedMode: "fork",
      operation: "fork",
    },
    {
      scenario: "an oversized explicit fork starts isolated",
      args: { context: "fork" },
      parentTokens: 150_000,
      preparedMode: "isolated",
      operation: "create",
    },
    {
      scenario: "a queued oversized fork starts isolated",
      args: { context: "fork", collect: true, groupId: "receipt-collectors" },
      parentTokens: 150_000,
      preparedMode: "isolated",
      operation: "create",
    },
  ] as const)(
    "records the committed context when $scenario",
    async ({ args, parentTokens, preparedMode, operation }) => {
      prepareSubagentSpawn.mockResolvedValue(undefined);
      startQueuedSubagentRun.mockReturnValue(true);
      threadBindingAvailable = true;
      config.logging = { audit: { enabled: true, executionIdentity: true } };
      const parentScope = {
        agentId: "main",
        sessionId: parentId,
        sessionKey: parentKey,
        storePath,
      };
      if (parentTokens !== undefined) {
        await sessions.upsertSessionEntryCore(parentScope, {
          totalTokens: parentTokens,
          totalTokensFresh: true,
          totalTokensVersion: 1,
        });
      }
      const parentBefore = sessions.loadSessionEntry(parentScope);
      const parentHistory = await sessions.loadTranscriptEvents(parentScope);
      const work: ExecutionDecisionWork[] = [];
      const token = identityAdmission.createExecutionIdentityAdmissionToken("receipt-parent-run", {
        contextId: "receipt-parent-context",
        executionId: "receipt-parent-execution",
      });
      const tool = createSessionsSpawnTool({
        config,
        agentSessionKey: parentKey,
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:123",
      });
      const clearSink = decisionWork.configureExecutionDecisionWorkSink((item) => {
        work.push(decisionWork.parseExecutionDecisionWork(item));
        return true;
      });
      try {
        const result = await callerContext.withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: parentKey,
            executionIdentityToken: token,
            receiptAuthority: () => true,
          },
          () => tool.execute("spawn-context-receipt", { task: "inspect parent history", ...args }),
        );

        expect(result.details).toMatchObject({ status: "accepted", context: preparedMode });
        if ("collect" in args) {
          await vi.waitFor(() => expect(startQueuedSubagentRun).toHaveBeenCalled());
        }
        const childSessionKey = expectDefined(
          (result.details as { childSessionKey?: string }).childSessionKey,
          "accepted child key",
        );
        const child = expectDefined(
          sessions.loadSessionEntry({ agentId: "main", sessionKey: childSessionKey, storePath }),
          "accepted child entry",
        );
        expect(prepareSubagentSpawn).toHaveBeenCalledWith(
          expect.objectContaining({
            contextMode: preparedMode,
            childSessionKey,
          }),
        );
        const childHistory = await sessions.loadTranscriptEvents({
          agentId: "main",
          sessionId: child.sessionId,
          sessionKey: childSessionKey,
          storePath,
        });
        if (preparedMode === "fork") {
          expect(child.forkedFromParent).toBe(true);
          expect(childHistory).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                message: expect.objectContaining({ content: "parent history" }),
              }),
            ]),
          );
        } else {
          expect(forkedEntry).toBeUndefined();
          expect(childHistory).toEqual([]);
          expect(result.details).toMatchObject({
            note: expect.stringContaining("Parent context is too large to fork"),
          });
        }
        expect(sessions.loadSessionEntry(parentScope)).toEqual(parentBefore);
        expect(await sessions.loadTranscriptEvents(parentScope)).toEqual(parentHistory);
        expect(JSON.stringify(result.details)).not.toContain("receipt-parent-context");
        expect(work).toHaveLength(1);
        expect(work[0]).toMatchObject({
          token,
          receipt: {
            action: { family: "session", operation },
            decision: { outcome: "allowed", reasonCode: `session_${operation}_committed` },
            enforcement: { coverageState: "attribution-only" },
            source: { owner: "session-action", decisionBoundary: "session-tool.result" },
          },
          refs: {
            target: { namespace: "session", value: JSON.stringify(["main", childSessionKey]) },
          },
        });
      } finally {
        clearSink();
      }
    },
  );

  it.each([
    { stage: "thread binding", context: undefined },
    { stage: "context engine", context: "fork" },
    { stage: "launch", context: "fork" },
    { stage: "registration", context: "fork" },
    { stage: "collector", context: "fork" },
    { stage: "context engine", context: "isolated" },
  ] as const)(
    "removes the failed child after $stage with context=$context and preserves the parent",
    async ({ stage, context }) => {
      failure = stage;
      const collectorSettled = createDeferredCore();
      const activateSwarmRun = swarmScheduler.activateSwarmRun;
      const activation =
        stage === "collector"
          ? vi.spyOn(swarmScheduler, "activateSwarmRun").mockImplementation((params) =>
              activateSwarmRun({
                ...params,
                onStartFailure: async (error) => {
                  try {
                    return await params.onStartFailure(error);
                  } finally {
                    collectorSettled.resolve();
                  }
                },
              }),
            )
          : undefined;
      restoreActivation = () => activation?.mockRestore();
      const parentScope = {
        agentId: "main",
        sessionId: parentId,
        sessionKey: parentKey,
        storePath,
      };
      const parentBefore = sessions.loadSessionEntry(parentScope);
      const parentHistory = await sessions.loadTranscriptEvents(parentScope);
      const result = await spawnSubagentDirect(
        {
          task: "inspect parent history",
          context,
          ...(stage === "thread binding" ? { thread: true } : {}),
          ...(stage === "collector" ? { collect: true } : {}),
        },
        {
          agentSessionKey: parentKey,
          requesterRunId: "parent-run",
          ...(stage === "thread binding"
            ? { agentChannel: "discord", agentTo: "channel:123" }
            : {}),
        },
      );

      expect(result.status).toBe(stage === "collector" ? "accepted" : "error");
      if (stage === "collector") {
        // Wait for the real cleanup callback, not a one-second guess at SQLite deletion.
        await collectorSettled.promise;
        expect(settleFailedQueuedSubagentLaunch).toHaveBeenCalled();
      } else if (stage !== "thread binding") {
        expect(result.error).toContain(`${stage} failed`);
      }
      const childSessionKey = expectDefined(result.childSessionKey, "spawned child key");
      if (context !== "isolated") {
        const entry = expectDefined(forkedEntry, "forked child entry");
        expect(entry.sessionId).not.toBe(parentId);
        expect(
          await sessions.loadTranscriptEvents({
            agentId: "main",
            sessionKey: childSessionKey,
            sessionId: entry.sessionId,
            storePath,
          }),
        ).toEqual([]);
      } else {
        expect(fork).not.toHaveBeenCalled();
      }
      expect(
        sessions.loadSessionEntry({ agentId: "main", sessionKey: childSessionKey, storePath }),
      ).toBeUndefined();
      expect(sessions.loadSessionEntry(parentScope)).toEqual(parentBefore);
      expect(await sessions.loadTranscriptEvents(parentScope)).toEqual(parentHistory);
      if (stage === "registration" || stage === "collector") {
        expect(dispatch).toHaveBeenCalledWith(
          "chat.abort",
          { sessionKey: childSessionKey, runId: "accepted-child-run" },
          expect.anything(),
        );
      }
      if (stage === "collector") {
        expect(completeCollectorLaunchCleanup).toHaveBeenCalledWith(result.runId);
      }
    },
  );

  it.each(["session id", "lifecycle revision"] as const)(
    "preserves a successor that changes the %s after forking",
    async (changedIdentity) => {
      let successor: SessionEntry | undefined;
      let successorHistory: Awaited<ReturnType<typeof sessions.loadTranscriptEvents>> = [];
      prepareSubagentSpawn.mockImplementation(
        async ({ childSessionKey }: { childSessionKey: string }) => {
          const entry = expectDefined(forkedEntry, "forked child entry");
          const scope = { agentId: "main", sessionKey: childSessionKey, storePath };
          await sessions.replaceSessionEntry(scope, {
            ...entry,
            ...(changedIdentity === "session id"
              ? { sessionId: "successor-session" }
              : { lifecycleRevision: "successor-revision" }),
          });
          const replacement = expectDefined(sessions.loadSessionEntry(scope), "successor entry");
          const successorScope = { ...scope, sessionId: replacement.sessionId };
          await sessions.appendTranscriptMessage(successorScope, {
            message: { role: "user", content: "successor work" },
          });
          successor = sessions.loadSessionEntry(scope);
          successorHistory = await sessions.loadTranscriptEvents(successorScope);
          throw new Error("context engine failed");
        },
      );

      const result = await spawnSubagentDirect(
        { task: "inspect parent history", context: "fork" },
        { agentSessionKey: parentKey },
      );

      expect(result.status).toBe("error");
      expect(result.error).toContain("context engine failed");
      const childSessionKey = expectDefined(result.childSessionKey, "spawned child key");
      const successorEntry = expectDefined(successor, "successor entry");
      expect(dispatch.mock.calls.some(([method]) => method === "sessions.delete")).toBe(true);
      expect(
        sessions.loadSessionEntry({ agentId: "main", sessionKey: childSessionKey, storePath }),
      ).toEqual(successorEntry);
      expect(
        await sessions.loadTranscriptEvents({
          agentId: "main",
          sessionKey: childSessionKey,
          sessionId: successorEntry.sessionId,
          storePath,
        }),
      ).toEqual(successorHistory);
      expect(
        sessions.loadSessionEntry({ agentId: "main", sessionKey: parentKey, storePath })?.sessionId,
      ).toBe(parentId);
    },
  );
});
