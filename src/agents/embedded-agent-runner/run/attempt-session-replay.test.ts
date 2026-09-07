import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFailureMessage,
  createInterruptedTurnMessage,
} from "../../../../packages/agent-core/src/turn-interruption.js";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import type { ImageContent } from "../../../llm/types.js";
import { finalizeRuntimePromptImages } from "../../../media/runtime-prompt-image-provenance.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createAgentRunRestartAbortError } from "../../run-termination.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createOverflowAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "../../sessions/agent-session-loop-resource-loader.test-support.js";
import { agentSessionSetPromptPreparation } from "../../sessions/agent-session-prompting.js";
import type { AgentSession } from "../../sessions/agent-session.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { SettingsManager } from "../../sessions/settings-manager.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import {
  prepareEmbeddedAttemptSessionBoundary,
  prepareEmbeddedAttemptSessionManager,
} from "./attempt-session-prepare.js";
import { cleanupEmbeddedAttemptResources } from "./attempt-subscription-cleanup.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

registerAgentSessionLoopTestLifecycle();

async function withInterruptedTurn(
  appendOnlyRuntimeContext: boolean,
  run: (fixture: {
    attempt: EmbeddedRunAttemptParams;
    prepare: (
      onCreated?: (manager: SessionManager) => void,
    ) => ReturnType<typeof prepareEmbeddedAttemptSessionManager>;
    target: NonNullable<ReturnType<SessionManager["getSessionTarget"]>>;
    revoke: () => void;
  }) => Promise<void>,
  interruptedTurn = true,
) {
  await withOpenClawTestState({ label: "interrupted-keyed-replay" }, async (state) => {
    const runId = "interrupted-keyed-replay";
    const target = {
      agentId: "main",
      sessionId: runId,
      sessionKey: `agent:main:${runId}`,
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
      lifecycleRevision: "current-generation",
      activeWriterRunId: runId,
    });
    const makeRecorder = () =>
      createUserTurnTranscriptRecorder({
        target: { ...target, sessionEntry: undefined },
        input: { text: "Finish this exact turn", timestamp: 1, idempotencyKey: `${runId}:user` },
      });
    const previous = makeRecorder();
    await previous.stageApproved!({ runId, assertCurrent: () => {} });
    const original = guardSessionManager(SessionManager.open(target, state.workspaceDir), {
      runId,
      preparedUserTurnMessage: await previous.resolveMessage(),
      preparedUserTurnTranscriptRecorder: previous,
    });
    previous.withPendingInput!(() =>
      original.appendMessage({ role: "user", content: "Finish this exact turn", timestamp: 1 }),
    );
    if (appendOnlyRuntimeContext) {
      const carrier = buildRuntimeContextCustomMessage("Original runtime context")!;
      original.appendCustomMessageEntry(
        carrier.customType,
        carrier.content,
        carrier.display,
        carrier.details,
      );
    }
    if (interruptedTurn) {
      original.appendMessage(
        createFailureMessage(testModel, createAgentRunRestartAbortError(), true),
      );
      const interrupted = createInterruptedTurnMessage();
      if (interrupted.role !== "custom") {
        throw new Error("expected interruption context");
      }
      original.appendCustomMessageEntry(
        interrupted.customType,
        interrupted.content,
        interrupted.display,
      );
    }
    previous.finishPendingInput!("interrupted");
    rotateAgentEventLifecycleGeneration();
    closeOpenClawAgentDatabasesForTest();
    const recorder = makeRecorder();
    await recorder.stageApproved!({ runId, assertCurrent: () => {} });
    const attempt = {
      config: {},
      contextTokenBudget: 8000,
      model: testModel,
      modelId: testModel.id,
      provider: testModel.provider,
      runId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      sessionFile: target.sessionKey,
      workspaceDir: state.workspaceDir,
      prompt: "Finish this exact turn",
      userTurnTranscriptRecorder: recorder,
    } as EmbeddedRunAttemptParams;
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle(attempt);
    let active = true;
    const withOwnedTranscriptWrite = <T>(operation: () => Promise<T> | T) =>
      withOwnedSessionTranscriptWrites(
        {
          sessionTarget: {
            ...target,
            expectedLifecycleRevision: "current-generation",
            expectedWriterRunId: runId,
          },
          assertCommitAllowed: () => {
            if (!active) {
              throw new Error("original writer closed");
            }
          },
          withTranscriptWrite: (write) => lifecycle.withTranscriptWrite(write),
        },
        async () => await lifecycle.withTranscriptWrite(operation),
      );
    try {
      await run({
        attempt,
        target,
        revoke: () => {
          active = false;
        },
        prepare: (onCreated) =>
          prepareEmbeddedAttemptSessionManager({
            attempt,
            agentDir: state.agentDir("main"),
            effectiveCwd: state.workspaceDir,
            effectiveWorkspace: state.workspaceDir,
            onSessionManagerCreated: onCreated ?? (() => {}),
            replayAllowedToolNames: new Set(),
            resolveActiveContextEnginePluginId: () => undefined,
            sessionAgentId: "main",
            transcriptLifecycle: lifecycle,
            withOwnedTranscriptWrite,
          }),
      });
    } finally {
      recorder.finishPendingInput!("interrupted");
      await lifecycle.dispose();
      clearEmbeddedSessionPromptStates([target.sessionId]);
    }
  });
}

async function withReplaySession(
  fixture: Parameters<Parameters<typeof withInterruptedTurn>[1]>[0],
  appendOnlyRuntimeContext: boolean,
  run: (session: AgentSession, submit: () => Promise<void>) => Promise<void>,
  options: {
    beforeStart?: () => Promise<unknown>;
    recovery?: "retry" | "compaction";
    images?: ImageContent[];
  } = {},
) {
  const { attempt, target, prepare } = fixture;
  const prepared = await prepare();
  const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();
  if (options.beforeStart) {
    handlers.set("before_agent_start", [options.beforeStart]);
  }
  if (options.recovery === "compaction") {
    handlers.set("session_before_compact", [
      async (event) => {
        const { preparation } = event as {
          preparation: { firstKeptEntryId: string; tokensBefore: number };
        };
        return {
          compaction: {
            summary: "Continue the current request",
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
          },
        };
      },
    ]);
  }
  const { session } = await createTestSession({
    sessionManager: prepared.sessionManager,
    resourceLoader: createResourceLoader(handlers),
    settingsManager: SettingsManager.inMemory({
      compaction: {
        enabled: options.recovery === "compaction",
        reserveTokens: 0,
        keepRecentTokens: 1,
      },
      retry: { enabled: options.recovery === "retry", baseDelayMs: 1 },
    }),
  });
  session[agentSessionSetPromptPreparation](async () => prepared.assertInitialUserTurnReplay);
  try {
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession: session,
      appendOnlyRuntimeContext,
      attempt,
      ...prepared.userMessageBoundary,
      isRawModelRun: false,
      sessionManager: prepared.sessionManager,
      setActiveSessionSystemPrompt: () => {},
    });
    const promptState = getEmbeddedSessionPromptState(target.sessionId);
    const submit = () =>
      submitEmbeddedAttemptPrompt({
        attempt,
        activeSession: session,
        appendOnlyRuntimeContext,
        contextTokenBudget: 8000,
        images: options.images ?? [],
        modelPrompt: attempt.prompt,
        onFinalPromptText: () => {},
        onSteeringAcknowledged: () => {},
        runtimeOnly: false,
        sessionPromptState: promptState,
        systemPrompt: "",
        toolResultAggregateMaxChars: 8000,
        toolResultMaxChars: 4000,
        toolResultPromptProjectionState: promptState.toolResults,
        trajectoryRecorder: null,
        transcriptLeafId: prepared.sessionManager.getLeafId(),
        transcriptPrompt: attempt.prompt,
        runtimeContextMessage: buildRuntimeContextCustomMessage("Current runtime context"),
        promptActiveSession: (text, opts) =>
          attempt.userTurnTranscriptRecorder!.withPendingInput!(() =>
            session.prompt(text, { ...opts, expandPromptTemplates: false }),
          ),
      });
    await run(session, submit);
  } finally {
    session.dispose();
  }
}

describe("interrupted canonical user replay", () => {
  it.each([
    { appendOnly: false, queue: "steer" },
    { appendOnly: true, queue: "steer" },
    { appendOnly: false, queue: "follow-up" },
    { appendOnly: true, queue: "follow-up" },
  ])(
    "persists the next $queue user after replay with append-only context $appendOnly",
    async ({ appendOnly, queue }) => {
      await withInterruptedTurn(appendOnly, async (fixture) => {
        const before = loadTranscriptEventsSync(fixture.target);
        await withReplaySession(fixture, appendOnly, async (session, submit) => {
          const queuedText = "A distinct queued user request";
          const recorder =
            queue === "steer"
              ? createUserTurnTranscriptRecorder({
                  target: { ...fixture.target, sessionEntry: undefined },
                  input: { text: queuedText, timestamp: 2, idempotencyKey: "queued-user:user" },
                })
              : undefined;
          streamMocks.streamSimple.mockImplementation((model) =>
            createAssistantResultStream(
              createAssistant(model, [{ type: "text", text: "Both requests handled" }]),
            ),
          );
          try {
            if (recorder) {
              await recorder.stageApproved!({
                runId: fixture.attempt.runId,
                assertCurrent: () => {},
              });
              await session.steer(queuedText, undefined, recorder);
            } else {
              await session.followUp(queuedText);
            }
            await submit();
            expect(
              streamMocks.streamSimple.mock.calls.some(([, context]) =>
                JSON.stringify(context.messages).includes(queuedText),
              ),
            ).toBe(true);
            expect(loadTranscriptEventsSync(fixture.target).slice(0, before.length)).toEqual(
              before,
            );
            for (const [, context] of streamMocks.streamSimple.mock.calls) {
              expect(
                context.messages.filter(
                  (message: { role: string; content: unknown }) =>
                    message.role === "user" &&
                    JSON.stringify(message.content).includes(fixture.attempt.prompt),
                ),
              ).toHaveLength(1);
            }
            expect(
              SessionManager.open(fixture.target)
                .getBranch()
                .filter(
                  (entry) =>
                    entry.type === "message" &&
                    entry.message.role === "user" &&
                    JSON.stringify(entry.message.content).includes(queuedText),
                ),
            ).toHaveLength(1);
            if (recorder) {
              expect(recorder.hasPersisted()).toBe(true);
            }
          } finally {
            recorder?.finishPendingInput!("interrupted");
          }
        });
      });
    },
  );

  it("preserves current prompt images while reusing its durable user", async () => {
    const manager = SessionManager.inMemory();
    const user = {
      role: "user" as const,
      content: "Describe the current image",
      timestamp: 1,
      idempotencyKey: "image-turn:user",
      __openclaw: {
        senderName: "Synthetic sender",
        media: [{ path: "/synthetic/image.png", contentType: "image/png" }],
      },
    };
    manager.appendMessage(user);
    const { session } = await createTestSession({ sessionManager: manager });
    const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
    streamMocks.streamSimple.mockImplementation((model) =>
      createAssistantResultStream(
        createAssistant(model, [{ type: "text", text: "Image described" }]),
      ),
    );
    try {
      await session.prompt(user.content, {
        persistedUserIdempotencyKey: user.idempotencyKey,
        images: finalizeRuntimePromptImages([{ image, factIndex: 0 }]).images,
      });
      expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
      const runtimeUser = session.messages.find(
        (message) => Reflect.get(message, "idempotencyKey") === user.idempotencyKey,
      );
      expect(runtimeUser).toMatchObject({
        timestamp: user.timestamp,
        __openclaw: { ...user["__openclaw"], mediaImageBlockFactIndexes: [0] },
      });
      expect(manager.getBranch()[0]).toMatchObject({ message: user });
      const messages = streamMocks.streamSimple.mock.calls[0]![1].messages;
      expect(messages.filter((message: { role: string }) => message.role === "user")).toHaveLength(
        1,
      );
      expect(
        messages.flatMap((message: { content: unknown }) =>
          Array.isArray(message.content) ? message.content : [],
        ),
      ).toContainEqual(image);
    } finally {
      session.dispose();
    }
  });

  it.each([false, true])(
    "hydrates one current user through the built-in owner with interruption %s",
    async (interrupted) => {
      await withInterruptedTurn(
        false,
        async (fixture) => {
          const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
          const before = loadTranscriptEventsSync(fixture.target);
          await withReplaySession(
            fixture,
            false,
            async (session, submit) => {
              streamMocks.streamSimple.mockImplementation((model) =>
                createAssistantResultStream(
                  createAssistant(model, [{ type: "text", text: "Image turn recovered" }]),
                ),
              );
              await submit();
              expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
              const messages = streamMocks.streamSimple.mock.calls[0]![1].messages;
              const users = messages.filter(
                (message: { role: string; content: unknown }) =>
                  message.role === "user" &&
                  JSON.stringify(message.content).includes(fixture.attempt.prompt),
              );
              expect(users).toHaveLength(1);
              expect(users[0].content).toContainEqual(image);
              expect(loadTranscriptEventsSync(fixture.target).slice(0, before.length)).toEqual(
                before,
              );
              expect(
                SessionManager.open(fixture.target)
                  .getBranch()
                  .filter((entry) => entry.type === "message" && entry.message.role === "user"),
              ).toHaveLength(1);
              expect(session.getLastAssistantText()).toBe("Image turn recovered");
            },
            { images: finalizeRuntimePromptImages([{ image, factIndex: 0 }]).images },
          );
        },
        interrupted,
      );
    },
  );

  it("preserves an existing user/carrier reasoning prefix during SDK replay", async () => {
    const manager = SessionManager.inMemory();
    const user = {
      role: "user" as const,
      content: "Original request",
      timestamp: 1,
      idempotencyKey: "carrier-turn:user",
    };
    manager.appendMessage(user);
    const carrier = buildRuntimeContextCustomMessage("Original runtime context")!;
    manager.appendCustomMessageEntry(
      carrier.customType,
      carrier.content,
      carrier.display,
      carrier.details,
    );
    manager.appendMessage(
      createAssistant(
        testModel,
        [
          {
            type: "thinking",
            thinking: "Original reasoning",
            thinkingSignature: "synthetic-signature",
          },
        ],
        "aborted",
      ),
    );
    const { session } = await createTestSession({ sessionManager: manager });
    const before = structuredClone(session.messages);
    const providerPrefix = await session.agent.convertToLlm(before);
    streamMocks.streamSimple.mockImplementation((model) =>
      createAssistantResultStream(createAssistant(model, [{ type: "text", text: "Continued" }])),
    );
    try {
      await session.prompt("Rebuilt prompt", {
        persistedUserIdempotencyKey: user.idempotencyKey,
        images: [{ type: "image", data: "bmV3", mimeType: "image/png" }],
      });
      expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
      expect(
        streamMocks.streamSimple.mock.calls[0]![1].messages.slice(0, providerPrefix.length),
      ).toEqual(providerPrefix);
      expect(session.messages.slice(0, before.length)).toEqual(before);
    } finally {
      session.dispose();
    }
  });

  it("hands the opened manager to cleanup when replay preparation loses its writer", async () => {
    await withInterruptedTurn(false, async (fixture) => {
      let owner: SessionManager | undefined;
      let cleanupOwner: unknown;
      fixture.revoke();
      try {
        await expect(
          fixture.prepare((manager) => {
            owner = manager;
          }),
        ).rejects.toThrow("original writer closed");
      } finally {
        await cleanupEmbeddedAttemptResources({
          sessionManager: owner,
          flushPendingToolResultsAfterIdle: async ({ sessionManager }) => {
            cleanupOwner = sessionManager;
          },
        });
      }
      expect(cleanupOwner).toBeInstanceOf(SessionManager);
      expect(owner?.getSessionId()).toBe(fixture.target.sessionId);
    });
  });

  it.each(["partial", "final", "other-run", "coded-abort"] as const)(
    "does not promote a %s tail into replay authority",
    async (tail) => {
      await withInterruptedTurn(false, async (fixture) => {
        const original = guardSessionManager(SessionManager.open(fixture.target), {
          runId: tail === "other-run" ? "unrelated-run" : fixture.attempt.runId,
        });
        const message = createFailureMessage(testModel, createAgentRunRestartAbortError(), true);
        if (tail === "partial") {
          message.content = [{ type: "text", text: "partial response" }];
        } else if (tail === "final") {
          message.stopReason = "stop";
          message.content = [{ type: "text", text: "NO_REPLY" }];
        } else if (tail === "coded-abort") {
          Object.assign(message, { errorCode: "OPENCLAW_DIRECT_ABORT" });
        }
        original.appendMessage(message);
        await withReplaySession(fixture, false, async (_session, submit) => {
          await submit();
          expect(streamMocks.streamSimple).not.toHaveBeenCalled();
          expect(fixture.attempt.userTurnTranscriptRecorder!.hasPersisted()).toBe(false);
        });
      });
    },
  );

  it.each([
    { ordering: "repeated-restart", appendOnly: false },
    { ordering: "repeated-restart", appendOnly: true },
    { ordering: "pre-core-compaction", appendOnly: false },
    { ordering: "pre-core-compaction", appendOnly: true },
  ])(
    "replays the same interrupted turn after $ordering with append-only context $appendOnly",
    async ({ ordering, appendOnly }) => {
      await withInterruptedTurn(appendOnly, async (fixture) => {
        if (ordering === "repeated-restart") {
          const previous = guardSessionManager(SessionManager.open(fixture.target), {
            runId: fixture.attempt.runId,
          });
          previous.appendMessage(
            createFailureMessage(testModel, createAgentRunRestartAbortError(), true),
          );
        }
        let activeSession: AgentSession;
        await withReplaySession(
          fixture,
          appendOnly,
          async (session, submit) => {
            activeSession = session;
            streamMocks.streamSimple.mockImplementation((model) =>
              createAssistantResultStream(
                createAssistant(model, [{ type: "text", text: "Recovered same turn" }]),
              ),
            );
            await submit();
            expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
            expect(session.getLastAssistantText()).toBe("Recovered same turn");
          },
          ordering === "pre-core-compaction"
            ? {
                recovery: "compaction",
                beforeStart: async () => {
                  await activeSession.compact();
                },
              }
            : {},
        );
      });
    },
  );

  it.each([false, true])(
    "sends the recovered user once with append-only context %s",
    async (appendOnlyRuntimeContext) => {
      await withInterruptedTurn(appendOnlyRuntimeContext, async (fixture) => {
        const before = loadTranscriptEventsSync(fixture.target);
        await withReplaySession(fixture, appendOnlyRuntimeContext, async (session, submit) => {
          streamMocks.streamSimple.mockImplementation((model) =>
            createAssistantResultStream(
              createAssistant(model, [{ type: "text", text: "Recovered final" }]),
            ),
          );
          await submit();
          expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
          const messages = streamMocks.streamSimple.mock.calls[0]![1].messages;
          expect(
            messages.filter(
              (message: { role: string; content: unknown }) =>
                message.role === "user" &&
                JSON.stringify(message.content).includes(fixture.attempt.prompt),
            ),
          ).toHaveLength(1);
          expect(session.getLastAssistantText()).toBe("Recovered final");
          expect(loadTranscriptEventsSync(fixture.target).slice(0, before.length)).toEqual(before);
          expect(
            loadTranscriptEventsSync(fixture.target).filter(
              (entry) => (entry as { message?: { role?: string } }).message?.role === "user",
            ),
          ).toHaveLength(1);
        });
      });
    },
  );

  it.each([
    "later-user",
    "excluded-user",
    "excluded-user-with-tail",
    "final",
    "reset",
    "branch",
    "writer",
    "session",
    "closed",
  ] as const)("refuses a replay after %s changes during SDK hooks", async (change) => {
    await withInterruptedTurn(false, async (fixture) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      await withReplaySession(
        fixture,
        false,
        async (_session, submit) => {
          const settled = Promise.allSettled([submit()]);
          await entered.promise;
          const other = SessionManager.open(fixture.target);
          if (change === "later-user" || change.startsWith("excluded-user")) {
            const laterUser = {
              role: "user" as const,
              content: "new request",
              timestamp: 2,
              ...(change.startsWith("excluded-user") ? { excludeFromContext: true as const } : {}),
            };
            other.appendMessage(laterUser);
            if (change === "excluded-user-with-tail") {
              guardSessionManager(other, { runId: fixture.attempt.runId }).appendMessage(
                createFailureMessage(testModel, createAgentRunRestartAbortError(), true),
              );
            }
          }
          if (change === "final") {
            other.appendMessage(
              createAssistant(testModel, [{ type: "text", text: "already done" }]),
            );
          }
          if (change === "reset") {
            other.appendResetBoundary("reset");
          }
          if (change === "branch") {
            other.appendLeafControl({ targetId: null, appendParentId: null });
          }
          if (change === "writer" || change === "session") {
            await upsertSessionEntryCore(fixture.target, {
              sessionId: change === "session" ? "replacement-session" : fixture.target.sessionId,
              updatedAt: 2,
              activeWriterRunId: "replacement-writer",
            });
          }
          if (change === "closed") {
            fixture.revoke();
          }
          const before = loadTranscriptEventsSync(fixture.target);
          release.resolve();
          expect((await settled)[0]?.status).toBe("rejected");
          expect(streamMocks.streamSimple).not.toHaveBeenCalled();
          expect(loadTranscriptEventsSync(fixture.target)).toEqual(before);
        },
        {
          beforeStart: async () => {
            entered.resolve();
            await release.promise;
          },
        },
      );
    });
  });

  it.each(["retry", "compaction"] as const)(
    "consumes replay validation before this run writes and internally resumes after %s",
    async (recovery) => {
      await withInterruptedTurn(false, async (fixture) => {
        await withReplaySession(
          fixture,
          false,
          async (session, submit) => {
            streamMocks.streamSimple.mockImplementationOnce((model) =>
              createAssistantResultStream(
                recovery === "compaction"
                  ? createOverflowAssistant(model)
                  : {
                      ...createAssistant(model, [], "error"),
                      errorMessage: "503 overloaded",
                    },
              ),
            );
            streamMocks.streamSimple.mockImplementation((model) =>
              createAssistantResultStream(
                createAssistant(model, [{ type: "text", text: "Recovered after retry" }]),
              ),
            );
            await submit();
            expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
            expect(session.getLastAssistantText()).toBe("Recovered after retry");
          },
          { recovery },
        );
      });
    },
  );
});

it.each([
  { kind: "source snapshot", detached: true, fresh: false, explicit: undefined },
  { kind: "fresh helper", detached: true, fresh: true, explicit: undefined },
  { kind: "explicit override", detached: true, fresh: false, explicit: "caller-cache-key" },
  { kind: "durable sibling", detached: false, fresh: false, explicit: undefined },
])(
  "derives boundary cache affinity from the prompt owner ($kind)",
  async ({ detached, fresh, explicit }) => {
    await withInterruptedTurn(
      false,
      async ({ attempt, target, prepare }) => {
        const durable = SessionManager.open(target, attempt.workspaceDir);
        const manager = !detached
          ? durable
          : fresh
            ? SessionManager.inMemory(attempt.workspaceDir)
            : SessionManager.fromEntries(
                [durable.getHeader(), ...durable.getBranch()],
                attempt.workspaceDir,
              );
        attempt.sessionManager = manager;
        attempt.userTurnTranscriptRecorder = undefined;
        attempt.sessionPersistence = detached ? "detached" : "durable";
        attempt.promptCacheKey = explicit;
        if (detached) {
          attempt.sessionId = "private-helper-routing-identity";
          attempt.sessionKey = "agent:main:internal-session-effects:cache-fixture";
          attempt.sessionTarget = {
            ...target,
            sessionId: attempt.sessionId,
            sessionKey: attempt.sessionKey,
          };
          attempt.sessionFile = attempt.sessionKey;
        }
        const expected = explicit ?? `${manager.getSessionId()}:${manager.getBoundaryCount()}`;
        const before = loadTranscriptEventsSync(target);
        await prepare();
        expect(attempt.promptCacheKey).toBe(expected);
        expect(loadTranscriptEventsSync(target)).toEqual(before);
      },
      false,
    );
  },
);
