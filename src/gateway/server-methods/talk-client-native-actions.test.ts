import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { extractText } from "../../../ui/src/lib/chat/message-extract.ts";
import {
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS,
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID,
} from "../../agents/embedded-agent-runner/run-state.js";
import { guardSessionManager } from "../../agents/session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  loadTranscriptEventsSync,
  readSessionTranscriptMessageEvents,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  flushClientVoiceSessionWrites,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "../../talk/client-voice-session.js";
import { projectChatDisplayMessages } from "../chat-display-projection.js";
import { createTranscriptUpdateBroadcastHandler } from "../server-session-events.js";
import {
  readSessionMessagesAsync,
  readSessionPreviewItemsFromTranscript,
} from "../session-transcript-readers.js";
import { closeTalkClientGatewayControlSession } from "../talk-client-gateway-control.js";
import {
  AGENT_ID,
  CONNECTION_ID,
  SESSION_ID,
  SESSION_KEY,
  connectNativeSession,
  installNativePluginTestHooks,
  nativeDelegation,
  requireString,
  talkEventTypes,
  upstream,
  withParkedNativeTask,
  withNativePlugin,
} from "./talk-client-native-control.test-support.js";

function rawTranscriptRows() {
  return readTranscriptEventRows(openOpenClawAgentDatabase({ agentId: AGENT_ID }), SESSION_ID);
}

function nativeTranscript(text: string) {
  return { type: "turn.done", turn: { role: "user", transcript: text } };
}

function nativeBackgroundItems(session: {
  instructions: string;
  initial_items?: unknown;
}): unknown {
  expect(session).not.toHaveProperty("initial_items");
  const records = session.instructions.match(
    /<shared_session_history>\n(.*)\n<\/shared_session_history>$/s,
  )?.[1];
  expect(records).toBeDefined();
  return JSON.parse(records!);
}

function spokenMessages(frames: string[]): string[] {
  return frames.flatMap((frame) => {
    const event: unknown = JSON.parse(frame);
    if (!isRecord(event) || event.channel !== "speakable" || !Array.isArray(event.content)) {
      return [];
    }
    return event.content.flatMap((content: unknown) =>
      isRecord(content) && content.type === "input_text" && typeof content.text === "string"
        ? [content.text]
        : [],
    );
  });
}

async function flushNativeTranscript(result: Record<string, unknown>) {
  await flushClientVoiceSessionWrites({
    agentId: AGENT_ID,
    voiceSessionId: requireString(result, "voiceSessionId"),
  });
  await nextEventLoopTurn();
}

function expectOriginalResult(frames: string[]) {
  expect(frames.map((frame): unknown => JSON.parse(frame))).toContainEqual({
    type: "delegation.context.append",
    delegation_item_id: "original-task",
    channel: "speakable",
    content: [{ type: "input_text", text: "Original task completed normally." }],
  });
}

const activeControls = [
  {
    mode: "steering",
    text: "use the release branch instead",
    acknowledgment: "Got it. I steered the active run.",
  },
  {
    mode: "followup",
    text: "after that check tests",
    acknowledgment: "Queued that follow-up for the active OpenClaw run.",
  },
] as const;

describe("native Talk action ownership through public plugin registration", () => {
  installNativePluginTestHooks();
  registerAgentSessionLoopTestLifecycle();

  it("keeps native generated input in current-turn custody but out of display and future calls", async () => {
    const spoken = "Keep the literal labels Context: and Spoken style: in my note.";
    const delegated =
      "Check the note requested by the speaker. Context: preserve both labels. Spoken style: one sentence.";
    const answer = createAssistant(testModel, [
      { type: "text", text: "Both labels are preserved." },
    ]);
    const providerStream = createAssistantMessageEventStream();
    streamMocks.streamSimple.mockImplementation(() => providerStream);
    await withNativePlugin(async (fixture) => {
      const scope = {
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        storePath: resolveOpenClawAgentSqlitePath({ agentId: AGENT_ID }),
      };
      const publications: Promise<void>[] = [];
      const published = vi.fn();
      const publish = createTranscriptUpdateBroadcastHandler({
        broadcastToConnIds: published,
        sessionEventSubscribers: { getAll: () => new Set([CONNECTION_ID]) },
        sessionMessageSubscribers: { get: () => new Set([CONNECTION_ID]) },
        chatAbortControllers: fixture.chatAbortControllers,
      });
      const unsubscribe = onInternalSessionTranscriptUpdate((update) => {
        if ((update.target?.sessionId ?? update.sessionId) === SESSION_ID) {
          publications.push(publish(update));
        }
      });
      let modelRun: Promise<void> | undefined;
      upstream.runEmbeddedAgent.mockImplementationOnce(async (params) => {
        const { agentId, sessionId, sessionKey, storePath } = params.sessionTarget ?? {};
        if (!agentId || !sessionId || !sessionKey || !storePath || !params.preparedRunAdmission) {
          throw new Error("Missing native target/admission");
        }
        await params.preparedRunAdmission.admit("embedded", "native-history-backend");
        const recorder = params.userTurnTranscriptRecorder;
        const manager = guardSessionManager(
          SessionManager.open({ agentId, sessionId, sessionKey, storePath }),
          {
            agentId: AGENT_ID,
            sessionKey: SESSION_KEY,
            runId: params.runId,
            preparedUserTurnMessage: await recorder?.resolveMessage(),
            preparedUserTurnTranscriptRecorder: recorder,
          },
        );
        const { session } = await createTestSession({ sessionManager: manager });
        modelRun = session.prompt(params.prompt);
        await modelRun;
        await recorder?.waitForRuntimePersistence();
        return { payloads: [{ text: "Both labels are preserved." }], meta: { durationMs: 0 } };
      });
      try {
        const { socket, result } = await connectNativeSession(fixture);
        socket.serverEvent(nativeTranscript(spoken));
        await flushNativeTranscript(result);
        socket.serverEvent(nativeDelegation("custody-request", delegated));
        await vi.waitFor(() => expect(streamMocks.streamSimple).toHaveBeenCalledOnce());
        const run = upstream.runEmbeddedAgent.mock.calls[0]![0];
        expect(run.prompt).toContain(delegated);
        const modelMessages = streamMocks.streamSimple.mock.calls[0]![1].messages;
        expect(
          modelMessages.filter((message: unknown) => JSON.stringify(message).includes(delegated)),
        ).toHaveLength(1);
        expect(modelMessages.map(extractText)).toContain(run.prompt);
        await Promise.all(publications);
        const raw = loadTranscriptEventsSync(scope);
        const generated = raw.filter(
          (event) =>
            isRecord(event) &&
            isRecord(event.message) &&
            JSON.stringify(event.message).includes(delegated),
        );
        expect(generated).toHaveLength(1);
        expect.soft(generated[0]).toMatchObject({
          message: {
            role: "user",
            display: false,
            excludeFromContext: true,
          },
        });
        expect(extractText((generated[0] as { message: unknown }).message)).toBe(run.prompt);
        const history = await readSessionMessagesAsync(scope, {
          mode: "full",
          reason: "native custody",
        });
        expect.soft(JSON.stringify(projectChatDisplayMessages(history))).not.toContain(delegated);
        expect(JSON.stringify(projectChatDisplayMessages(history))).toContain(spoken);
        const live = published.mock.calls.flatMap(([event, payload]) =>
          event === "session.message" ? [payload.message] : [],
        );
        expect.soft(JSON.stringify(live)).not.toContain(delegated);
        const spokenFrames = fixture.broadcast.mock.calls.flatMap(([event, payload]) =>
          event === "talk.event" && payload.talkEvent?.type === "transcript.done"
            ? [payload.talkEvent.payload.text]
            : [],
        );
        expect(spokenFrames).toEqual([spoken]);
        expect(JSON.stringify(fixture.broadcast.mock.calls)).not.toContain(delegated);
        providerStream.push({ type: "done", reason: "stop", message: answer });
        providerStream.end();
        await modelRun;
        await vi.waitFor(() =>
          expect(spokenMessages(socket.sent)).toContain("Both labels are preserved."),
        );
        // A returned readback is a distinct voice record, not a deduplication signal.
        const readback = "Both labels are preserved.";
        const dialogue = "OpenClaw is waiting on the model.";
        for (const text of [readback, dialogue]) {
          socket.serverEvent({ type: "turn.done", turn: { role: "assistant", transcript: text } });
          await flushNativeTranscript(result);
        }
        await Promise.all(publications);
        const retained = [
          { role: "user", text: spoken },
          { role: "assistant", text: readback },
          { role: "assistant", text: readback },
          { role: "assistant", text: dialogue },
        ];
        const completed = await readSessionMessagesAsync(scope, {
          mode: "full",
          reason: "native history",
        });
        expect(projectChatDisplayMessages(completed).map(extractText)).toEqual(
          retained.map((item) => item.text),
        );
        const assistantRecords = readSessionTranscriptMessageEvents(scope).flatMap(({ event }) =>
          isRecord(event) && isRecord(event.message) && event.message.role === "assistant"
            ? [event.message]
            : [],
        );
        expect(assistantRecords).toHaveLength(3);
        expect(assistantRecords.slice(1)).toEqual([
          expect.objectContaining({ api: "realtime", content: [{ type: "text", text: readback }] }),
          expect.objectContaining({ api: "realtime", content: [{ type: "text", text: dialogue }] }),
        ]);
        await fixture.invoke("talk.client.close", { voiceSessionId: result.voiceSessionId });
        const rawCompleted = rawTranscriptRows();
        expect(
          closeOpenClawAgentDatabaseByPath(resolveOpenClawAgentSqlitePath({ agentId: AGENT_ID })),
        ).toBe(true);
        await connectNativeSession(fixture);
        const body = upstream.fetch.mock.calls.at(-1)?.[1]?.body;
        expect(typeof body).toBe("string");
        const request = JSON.parse(body as string);
        expect.soft(request.session.instructions).not.toContain(delegated);
        expect(nativeBackgroundItems(request.session)).toEqual(retained);
        expect(request.session.delegation.ack_filler).toBe(false);
        expect(rawTranscriptRows()).toEqual(rawCompleted);
      } finally {
        providerStream.push({ type: "done", reason: "stop", message: answer });
        providerStream.end();
        await modelRun;
        await Promise.all(publications);
        unsubscribe();
      }
    });
  });

  it("selects eligible native history before projection and the item cap", async () => {
    await withNativePlugin(async (fixture) => {
      const scope = {
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        storePath: resolveOpenClawAgentSqlitePath({ agentId: AGENT_ID }),
      };
      const manager = SessionManager.open(scope);
      const append = (
        content: string,
        flags: { display?: false; excludeFromContext?: true } = {},
      ) => manager.appendMessage({ role: "user", content, timestamp: 1, ...flags });
      append("ordinary");
      append("context only", { display: false });
      append("display only", { excludeFromContext: true });
      for (let index = 0; index < 70; index++) {
        append(`excluded sentinel ${index}`, { display: false, excludeFromContext: true });
      }
      const raw = rawTranscriptRows();
      const display = readSessionPreviewItemsFromTranscript(scope, 16, 800);
      expect.soft(display.map((item) => item.text)).toEqual(["ordinary", "display only"]);
      const context = readSessionPreviewItemsFromTranscript(scope, 16, 800, "model-context");
      expect.soft(context.map((item) => item.text)).toEqual(["ordinary", "context only"]);
      await connectNativeSession(fixture);
      const body = upstream.fetch.mock.calls.at(-1)?.[1]?.body;
      expect(typeof body).toBe("string");
      const request = JSON.parse(body as string);
      expect(nativeBackgroundItems(request.session)).toEqual([
        { role: "user", text: "ordinary" },
        { role: "user", text: "context only" },
      ]);
      expect(rawTranscriptRows()).toEqual(raw);
      // Reset retention is intentional model context, even for a hidden/excluded user row.
      const kept = append("reset-kept", { display: false, excludeFromContext: true });
      manager.appendResetBoundary("new", kept);
      append("post-reset excluded", { display: false, excludeFromContext: true });
      const resetRaw = rawTranscriptRows();
      expect(
        readSessionPreviewItemsFromTranscript(scope, 16, 800, "model-context").map(
          (item) => item.text,
        ),
      ).toEqual(["reset-kept"]);
      expect(readSessionPreviewItemsFromTranscript(scope, 16, 800)).toEqual([]);
      await connectNativeSession(fixture);
      const resetRequest = JSON.parse(upstream.fetch.mock.calls.at(-1)![1]!.body as string);
      expect(nativeBackgroundItems(resetRequest.session)).toEqual([
        { role: "user", text: "reset-kept" },
      ]);
      expect(rawTranscriptRows()).toEqual(resetRaw);
      for (let index = 0; index < 20; index++) {
        append(`${index}:` + "x".repeat(30));
      }
      const bounded = readSessionPreviewItemsFromTranscript(scope, 3, 20, "model-context");
      expect(bounded).toEqual(
        [17, 18, 19].map((index) => ({ role: "user", text: `${index}:` + "x".repeat(14) + "..." })),
      );
    });
  });

  it.each([
    ["open", "open"],
    ["closed", "closed"],
    ["reassigned", "reassigned"],
    ["returned A-to-B-to-A", "reassigned"],
    ["identical registration replay", "open"],
  ] as const)(
    "checks the controlling call at real final insertion while the backend stays live (%s)",
    async (scenario, transition) => {
      const { session } = await createTestSession();
      const providerStream = createAssistantMessageEventStream();
      const answer = createAssistant(testModel, [{ type: "text", text: "Task finished." }]);
      streamMocks.streamSimple
        .mockImplementationOnce(() => providerStream)
        .mockImplementation(() => createAssistantResultStream(answer));
      await withParkedNativeTask(
        async ({ create, result, socket, activeRun, chatAbortControllers, abortOwned }) => {
          let closing: Promise<boolean> | undefined;
          try {
            await vi.waitFor(() => expect(streamMocks.streamSimple).toHaveBeenCalledOnce());
            const voiceSessionId = requireString(result, "voiceSessionId");
            const replacementVoiceSessionId =
              transition === "reassigned"
                ? requireString(await create(true), "voiceSessionId")
                : undefined;
            const handle = ACTIVE_EMBEDDED_RUNS.get(activeRun.sessionId);
            const registration = handle && ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
            const chatRegistration = chatAbortControllers.get(activeRun.runId);
            if (!handle || !registration?.toolAuthority || !chatRegistration) {
              throw new Error("Expected the real admitted backend and control registration");
            }
            expect(resolveClientVoiceRunBinding(activeRun.runId)?.voiceSessionId).toBe(
              voiceSessionId,
            );
            expect(session.isStreaming).toBe(true);
            const inserted = vi.spyOn(session.agent, "steer");
            const realSteer = session.steer.bind(session);
            const delivered = createDeferredCore();
            let insertionsBeforeTransition: number | undefined;
            const steering = vi.spyOn(session, "steer").mockImplementation((...args) => {
              // Enter the real transcript-preparation await before closing only the call.
              // Awaiting close here would deadlock on this control's own FIFO drain.
              const pending = realSteer(...args);
              insertionsBeforeTransition = inserted.mock.calls.length;
              if (transition === "closed") {
                closing = closeTalkClientGatewayControlSession({
                  voiceSessionId,
                  sessionKey: SESSION_KEY,
                  connId: CONNECTION_ID,
                });
              } else if (replacementVoiceSessionId) {
                registerClientVoiceConsultRun({
                  agentId: AGENT_ID,
                  sessionKey: SESSION_KEY,
                  voiceSessionId: replacementVoiceSessionId,
                  runId: activeRun.runId,
                });
              }
              if (
                scenario === "returned A-to-B-to-A" ||
                scenario === "identical registration replay"
              ) {
                registerClientVoiceConsultRun({
                  agentId: AGENT_ID,
                  sessionKey: SESSION_KEY,
                  voiceSessionId,
                  runId: activeRun.runId,
                });
              }
              void pending.then(
                () => delivered.resolve(),
                () => delivered.resolve(),
              );
              return pending;
            });
            const text = "use the release branch instead";
            socket.serverEvent(nativeDelegation("final-insertion-control", text));
            await delivered.promise;
            if (transition === "closed") {
              expect(await closing).toBe(true);
              expect(socket.readyState).toBe(upstream.NativeSocket.CLOSED);
            } else if (replacementVoiceSessionId) {
              expect(resolveClientVoiceRunBinding(activeRun.runId)?.voiceSessionId).toBe(
                scenario === "returned A-to-B-to-A" ? voiceSessionId : replacementVoiceSessionId,
              );
            } else {
              await vi.waitFor(() =>
                expect(spokenMessages(socket.sent)).toContainEqual(
                  expect.stringContaining("Got it. I steered the active run."),
                ),
              );
            }
            expect(steering).toHaveBeenCalledOnce();
            expect(insertionsBeforeTransition).toBe(0);
            expect(ACTIVE_EMBEDDED_RUNS.get(activeRun.sessionId)).toBe(handle);
            expect(ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(activeRun.runId)).toBe(handle);
            expect(ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle)).toBe(registration);
            expect(chatAbortControllers.get(activeRun.runId)).toBe(chatRegistration);
            expect(() => registration.toolAuthority?.assertActive()).not.toThrow();
            expect(activeRun.abortSignal.aborted).toBe(false);
            expect(session.agent.signal?.aborted).toBe(false);
            expect(session.isStreaming).toBe(true);
            expect(abortOwned).not.toHaveBeenCalled();
            expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
            expect.soft(inserted).toHaveBeenCalledTimes(transition === "open" ? 1 : 0);
            expect.soft(session.getSteeringMessages()).toEqual(transition === "open" ? [text] : []);
            expect(session.agent.hasQueuedMessages()).toBe(transition === "open");
          } finally {
            providerStream.push({ type: "done", reason: "stop", message: answer });
            providerStream.end();
            await closing;
          }
        },
        "Keep working until I cancel.",
        session,
      );
    },
  );

  it.each([
    ["replacement", "cancel"],
    ["idle", "cancel"],
    ["queued replacement", "steer"],
  ] as const)(
    "does not retarget %s during control readiness or FIFO wait (%s)",
    async (transition, mode) => {
      await withParkedNativeTask(
        async ({ socket, activeRun, chatAbortControllers, abortOwned, queueMessage }) => {
          const entry = chatAbortControllers.get(activeRun.runId);
          if (!entry) {
            throw new Error("Missing original registration");
          }
          if (transition === "idle") {
            chatAbortControllers.delete(activeRun.runId);
          }
          const before = socket.sent.length;
          const queued = transition === "queued replacement";
          if (queued) {
            socket.serverEvent(nativeDelegation("prefix-control", "cancel"));
          }
          socket.serverEvent(
            nativeDelegation(
              "captured-control",
              mode === "cancel" ? "cancel" : "use the release branch instead",
            ),
          );
          // Same call and even the same correlation ID cannot adopt a new registration.
          chatAbortControllers.set(activeRun.runId, { ...entry });
          await vi.waitFor(() =>
            expect(spokenMessages(socket.sent.slice(before))).toEqual([
              ...(queued
                ? [expect.stringContaining("There is no active OpenClaw run to cancel.")]
                : []),
              expect.stringContaining(`There is no active OpenClaw run to ${mode}.`),
            ]),
          );
          expect(abortOwned).not.toHaveBeenCalled();
          expect(queueMessage).not.toHaveBeenCalled();
          expect(activeRun.abortSignal.aborted).toBe(false);
          expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
        },
      );
    },
  );

  it("consumes a startup control with a visible refusal before any backend publishes", async () => {
    const release = createDeferredCore();
    let signal: AbortSignal | undefined;
    upstream.runEmbeddedAgent.mockImplementationOnce(async (params) => {
      signal = params.abortSignal;
      await release.promise;
      return { payloads: [{ text: "Original task completed normally." }], meta: { durationMs: 0 } };
    });
    await withNativePlugin(async (fixture) => {
      const { socket } = await connectNativeSession(fixture);
      try {
        socket.serverEvent(nativeDelegation("original-task", "Keep working."));
        await vi.waitFor(() => expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce());
        const before = socket.sent.length;
        socket.serverEvent(nativeDelegation("startup-control", "use the release branch instead"));
        await vi.waitFor(() =>
          expect(spokenMessages(socket.sent.slice(before))).toEqual([
            expect.stringContaining("There is no active OpenClaw run to steer."),
          ]),
        );
        expect(signal?.aborted).toBe(false);
        expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
        release.resolve();
        await vi.waitFor(() => expectOriginalResult(socket.sent));
        expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
      } finally {
        release.resolve();
        await Promise.allSettled(
          upstream.runEmbeddedAgent.mock.results.flatMap((result) =>
            result.type === "return" ? [result.value] : [],
          ),
        );
      }
    });
  });

  it("admits public steering with current authenticated caller authority", async () => {
    await withParkedNativeTask(
      async ({ invoke, socket, activeRun, queueMessage, abortOwned, settleBackend }) => {
        const result = await invoke("talk.client.steer", {
          sessionKey: SESSION_KEY,
          text: "use the release branch instead",
          mode: "steer",
        });
        expect(result).toMatchObject({ ok: true, queued: true });
        expect(queueMessage).toHaveBeenCalledOnce();
        expect(abortOwned).not.toHaveBeenCalled();
        expect(activeRun.abortSignal.aborted).toBe(false);
        await settleBackend();
        await vi.waitFor(() => expectOriginalResult(socket.sent));
        expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
      },
    );
  });

  it.each(activeControls)(
    "keeps $mode on retained work after same-call transport replacement",
    async ({ text, acknowledgment }) => {
      await withParkedNativeTask(
        async ({
          create,
          offer,
          result,
          socket,
          activeRun,
          queueMessage,
          abortOwned,
          settleBackend,
        }) => {
          const replacement = await connectNativeSession(
            { create, offer },
            true,
            requireString(result, "voiceSessionId"),
          );
          expect(replacement.result.voiceSessionId).toBe(result.voiceSessionId);
          await vi.waitFor(() => expect(socket.readyState).toBe(upstream.NativeSocket.CLOSED));
          replacement.socket.serverEvent(nativeDelegation("replacement-control", text));
          await vi.waitFor(() =>
            expect({
              deliveries: queueMessage.mock.calls.length,
              taskStarts: upstream.runEmbeddedAgent.mock.calls.length,
              originalRunAborted: activeRun.abortSignal.aborted,
            }).toEqual({ deliveries: 1, taskStarts: 1, originalRunAborted: false }),
          );
          replacement.socket.serverEvent(nativeTranscript(text));
          await flushNativeTranscript(replacement.result);
          expect(spokenMessages(replacement.socket.sent)).toEqual([
            expect.stringContaining(acknowledgment),
          ]);
          expect(abortOwned).not.toHaveBeenCalled();
          await settleBackend();
          expect(activeRun.abortSignal.aborted).toBe(false);
          expect(queueMessage).toHaveBeenCalledOnce();
          expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
        },
      );
    },
  );

  // Unlike classifier tests, these pairs reach the provider's replacement policy and real run queue.
  describe.each(activeControls)("active $mode", ({ text, acknowledgment }) => {
    it.each(["transcript-first", "delegation-first"] as const)(
      "delivers once without replacing the original task (%s)",
      async (order) => {
        await withParkedNativeTask(
          async ({ socket, result, activeRun, queueMessage, abortOwned, settleBackend }) => {
            const beforeControl = socket.sent.length;
            if (order === "transcript-first") {
              socket.serverEvent(nativeTranscript(text));
              // Persistence can finish before delegation; no control acknowledgment is required.
              await flushNativeTranscript(result);
              socket.serverEvent(nativeDelegation("active-control", text));
            } else {
              socket.serverEvent(nativeDelegation("active-control", text));
              socket.serverEvent(nativeTranscript(text));
            }
            await flushNativeTranscript(result);
            await vi.waitFor(() =>
              expect({
                deliveries: queueMessage.mock.calls.length,
                originalRunAborted: activeRun.abortSignal.aborted,
                taskStarts: upstream.runEmbeddedAgent.mock.calls.length,
              }).toEqual({ deliveries: 1, originalRunAborted: false, taskStarts: 1 }),
            );
            expect(queueMessage.mock.calls[0]?.[0]).toContain(text);
            expect(activeRun.abortSignal.aborted).toBe(false);
            expect(abortOwned).not.toHaveBeenCalled();
            expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
            await vi.waitFor(() =>
              expect(spokenMessages(socket.sent.slice(beforeControl))).toEqual([
                expect.stringContaining(acknowledgment),
              ]),
            );

            await settleBackend();
            await vi.waitFor(() => expectOriginalResult(socket.sent));
            expect(queueMessage).toHaveBeenCalledOnce();
            expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
            expect(activeRun.abortSignal.aborted).toBe(false);
            expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
          },
        );
      },
    );
  });

  // Both ordinary requests match the broad control classifier; neither may be suppressed or self-steered.
  it.each(["Check the weather.", "Also summarize the report."])(
    "admits idle task %s once without steering it when final ASR arrives later",
    async (text) => {
      await withParkedNativeTask(
        async ({ socket, result, activeRun, queueMessage, abortOwned, settleBackend }) => {
          expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
          expect(activeRun.prompt).toContain(text);
          const beforeTranscript = socket.sent.length;
          socket.serverEvent(nativeTranscript(text));
          await flushNativeTranscript(result);
          expect(
            spokenMessages(socket.sent.slice(beforeTranscript)),
            "persisting final ASR must not issue a steering result or refusal",
          ).toEqual([]);
          expect(queueMessage).not.toHaveBeenCalled();
          expect(abortOwned).not.toHaveBeenCalled();
          expect(activeRun.abortSignal.aborted).toBe(false);
          expect(
            readSessionTranscriptMessageEvents({ agentId: AGENT_ID, sessionId: SESSION_ID }),
          ).toMatchObject([
            {
              event: {
                message: {
                  role: "user",
                  content: [{ type: "text", text }],
                },
              },
            },
          ]);
          await settleBackend();
          await vi.waitFor(() => expectOriginalResult(socket.sent));
          expect(queueMessage).not.toHaveBeenCalled();
          expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
          expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
        },
        text,
      );
    },
  );

  // A same-turn test misses the state transition between a persisted transcript and its delegation.
  it.each(activeControls)(
    "makes one current-state decision for $mode delegated after original settlement",
    async ({ text }) => {
      await withParkedNativeTask(
        async ({ socket, result, activeRun, queueMessage, abortOwned, settleBackend }) => {
          const beforeTranscript = socket.sent.length;
          socket.serverEvent(nativeTranscript(text));
          await flushNativeTranscript(result);
          expect.soft(queueMessage, "final ASR must not steer the old task").not.toHaveBeenCalled();
          expect
            .soft(
              spokenMessages(socket.sent.slice(beforeTranscript)),
              "final ASR must not attempt control before delegation",
            )
            .toEqual([]);
          expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
          await settleBackend();
          await vi.waitFor(() => expectOriginalResult(socket.sent));
          expect(activeRun.abortSignal.aborted).toBe(false);

          socket.serverEvent(nativeDelegation("after-settlement", text));
          await vi.waitFor(() => expect(upstream.runEmbeddedAgent).toHaveBeenCalledTimes(2));
          await vi.waitFor(() =>
            expect(socket.sent.map((frame): unknown => JSON.parse(frame))).toContainEqual({
              type: "delegation.context.append",
              delegation_item_id: "after-settlement",
              channel: "speakable",
              content: [{ type: "input_text", text: "Subsequent task completed." }],
            }),
          );
          expect(upstream.runEmbeddedAgent.mock.calls[1]?.[0].prompt).toContain(text);
          expect(
            queueMessage,
            "one input must not both steer old work and start new work",
          ).not.toHaveBeenCalled();
          expect(abortOwned).not.toHaveBeenCalled();
          expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
        },
      );
    },
  );

  // The real queue yields on readiness: one synchronous burst fills it without a blocker seam.
  it("speaks a bounded refusal at control capacity and accepts a fresh cancel after draining", async () => {
    await withParkedNativeTask(
      async ({
        socket,
        result,
        activeRun,
        queueMessage,
        abortOwned,
        broadcast,
        chatAbortControllers,
      }) => {
        const beforeBurst = socket.sent.length;
        for (let index = 0; index < 9; index += 1) {
          socket.serverEvent(nativeTranscript("Status?"));
          socket.serverEvent(nativeDelegation(`status-${index}`, "Status?"));
        }
        socket.serverEvent(nativeTranscript("cancel"));
        socket.serverEvent(nativeDelegation("overflow-cancel", "cancel"));
        await flushNativeTranscript(result);
        const statusReply = "OpenClaw is working on the current voice request.";
        await vi.waitFor(() =>
          expect(
            spokenMessages(socket.sent.slice(beforeBurst)).filter((message) =>
              message.includes(statusReply),
            ),
          ).toHaveLength(9),
        );
        const refusals = spokenMessages(socket.sent.slice(beforeBurst)).filter(
          (message) => !message.includes(statusReply),
        );
        // Keep going after a missing refusal so recovery independently catches a permanently sealed queue.
        expect
          .soft(refusals, "the unaccepted cancel needs an explicit spoken refusal")
          .toEqual([
            expect.stringMatching(
              /(?:queue|control).*(?:full|busy|capacity)|(?:full|busy|capacity).*(?:queue|control)/i,
            ),
          ]);
        for (const refusal of refusals) {
          expect(Buffer.byteLength(refusal, "utf8")).toBeLessThanOrEqual(500);
        }
        expect(socket.sent.slice(beforeBurst).join("\n")).not.toContain(
          "Cancelled the active OpenClaw run.",
        );
        expect(queueMessage).not.toHaveBeenCalled();
        expect(abortOwned).not.toHaveBeenCalled();
        expect(activeRun.abortSignal.aborted).toBe(false);
        expect(chatAbortControllers.has(activeRun.runId)).toBe(true);
        expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
        expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
        expect(talkEventTypes(broadcast)).not.toContain("session.error");

        const beforeRecovery = socket.sent.length;
        socket.serverEvent(nativeTranscript("cancel"));
        socket.serverEvent(nativeDelegation("fresh-cancel", "cancel"));
        await vi.waitFor(() => expect(abortOwned).toHaveBeenCalledOnce());
        await vi.waitFor(() =>
          expect(spokenMessages(socket.sent.slice(beforeRecovery))).toEqual([
            expect.stringContaining("Cancelled the active OpenClaw run."),
          ]),
        );
        await flushNativeTranscript(result);
        expect(activeRun.abortSignal.aborted).toBe(true);
        expect(queueMessage).not.toHaveBeenCalled();
        expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
        expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
        expect(talkEventTypes(broadcast)).not.toContain("session.error");
      },
    );
  });
});
