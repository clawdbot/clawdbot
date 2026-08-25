import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { readSessionTranscriptMessageEvents } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { flushClientVoiceSessionWrites } from "../../talk/client-voice-session.js";
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
  withNativePlugin,
  withParkedNativeTask,
  withRegisteredNativeEmbeddedRun,
} from "./talk-client-native-control.test-support.js";

describe("native Talk through the public OpenAI plugin registration", () => {
  installNativePluginTestHooks();

  it("negotiates Gateway control and persists native sideband speech without client control", async () => {
    await withNativePlugin(async ({ create, offer, invoke, broadcast }) => {
      const { result, socket } = await connectNativeSession({ create, offer });
      expect(talkEventTypes(broadcast).filter((type) => type === "session.ready")).toHaveLength(1);
      socket.serverEvent({ type: "turn.done", turn: { role: "user", transcript: "Hello voice" } });
      socket.serverEvent({
        type: "turn.done",
        turn: { role: "assistant", transcript: "Hello human" },
      });
      await flushClientVoiceSessionWrites({
        agentId: AGENT_ID,
        voiceSessionId: requireString(result, "voiceSessionId"),
      });
      const messages = readSessionTranscriptMessageEvents({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
      });
      expect(messages).toMatchObject([
        { event: { message: { role: "user", content: [{ type: "text", text: "Hello voice" }] } } },
        {
          event: {
            message: { role: "assistant", content: [{ type: "text", text: "Hello human" }] },
          },
        },
      ]);
      expect(talkEventTypes(broadcast)).not.toContain("turn.ended");
      await invoke("talk.client.close", {});
      expect(socket.readyState).toBe(upstream.NativeSocket.CLOSED);
    });
  });

  it.each([
    ["Status?", "transcript-first"],
    ["Status?", "delegation-first"],
    ["cancel", "transcript-first"],
    ["cancel", "delegation-first"],
  ] as const)(
    "handles native %s without a duplicate consult with %s provider events",
    async (text, eventOrder) => {
      await withParkedNativeTask(
        async ({ create, offer, result, socket, activeRun, abortOwned, chatAbortControllers }) => {
          const { runId, abortSignal } = activeRun;
          expect(chatAbortControllers.get(runId)).toMatchObject({
            agentId: AGENT_ID,
            sessionKey: SESSION_KEY,
            sessionId: SESSION_ID,
            ownerConnId: CONNECTION_ID,
          });
          const transcript = { type: "turn.done", turn: { role: "user", transcript: text } };
          const delegation = nativeDelegation("control-request", text);
          const idle = await connectNativeSession({ create, offer });
          expect(idle.result.voiceSessionId).not.toBe(result.voiceSessionId);
          idle.socket.serverEvent(delegation);
          idle.socket.serverEvent(transcript);
          const idleReply =
            text === "cancel"
              ? "There is no active OpenClaw run to cancel."
              : "I'm not working on an active request right now.";
          await vi.waitFor(() => expect(idle.socket.sent.join("\n")).toContain(idleReply));
          expect(abortSignal.aborted).toBe(false);
          expect(abortOwned).not.toHaveBeenCalled();
          expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
          const preControlSocketIndex = socket.sent.length;
          const reply =
            text === "cancel"
              ? "Cancelled the active OpenClaw run."
              : "OpenClaw is working on the current voice request.";
          const waitForControlReply = () =>
            vi.waitFor(() => {
              expect(socket.sent.slice(preControlSocketIndex).join("\n")).toContain(reply);
              expect(abortSignal.aborted).toBe(text === "cancel");
            });
          if (eventOrder === "transcript-first") {
            socket.serverEvent(transcript);
            socket.serverEvent(delegation);
          } else {
            socket.serverEvent(delegation);
            // Native control must finish while final ASR is withheld, not merely after both events.
            await waitForControlReply();
            socket.serverEvent(transcript);
          }
          await waitForControlReply();
          await flushClientVoiceSessionWrites({
            agentId: AGENT_ID,
            voiceSessionId: requireString(result, "voiceSessionId"),
          });
          await nextEventLoopTurn();
          expect({
            originalRunAborted: abortSignal.aborted,
            agentStarts: upstream.runEmbeddedAgent.mock.calls.length,
          }).toEqual({ originalRunAborted: text === "cancel", agentStarts: 1 });
          expect(
            socket.sent
              .slice(preControlSocketIndex)
              .filter((frame) => frame.includes("Internal OpenClaw voice control result.")),
          ).toHaveLength(1);
          expect(
            readSessionTranscriptMessageEvents({ agentId: AGENT_ID, sessionId: SESSION_ID }),
          ).toMatchObject(
            [text, text].map((transcriptText) => ({
              event: {
                message: { role: "user", content: [{ type: "text", text: transcriptText }] },
              },
            })),
          );
          if (text === "Status?") {
            expect(abortOwned).not.toHaveBeenCalled();
            expect(chatAbortControllers.has(runId)).toBe(true);
          } else {
            expect(abortOwned).toHaveBeenCalledOnce();
          }
          expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
        },
      );
    },
  );

  it.each([
    ["Status?", "I'm not working on an active request right now."],
    ["cancel", "There is no active OpenClaw run to cancel."],
  ])("answers idle native %s without starting a consult", async (text, reply) => {
    await withNativePlugin(async ({ create, offer }) => {
      const { socket, result } = await connectNativeSession({ create, offer });
      const beforeTranscript = socket.sent.slice();
      socket.serverEvent({ type: "turn.done", turn: { role: "user", transcript: text } });
      await flushClientVoiceSessionWrites({
        agentId: AGENT_ID,
        voiceSessionId: requireString(result, "voiceSessionId"),
      });
      await nextEventLoopTurn();
      expect(socket.sent).toEqual(beforeTranscript);
      expect(upstream.runEmbeddedAgent).not.toHaveBeenCalled();
      socket.serverEvent(nativeDelegation("idle-control", text));
      await vi.waitFor(() => expect(socket.sent.join("\n")).toContain(reply));
      await nextEventLoopTurn();
      expect(upstream.runEmbeddedAgent).not.toHaveBeenCalled();
      expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
    });
  });

  it.each(["empty", "partial", "rejection"] as const)(
    "preserves intentional native cancellation after %s backend settlement",
    async (settlement) => {
      const releaseBackend = createDeferredCore();
      let activeRun: RunEmbeddedAgentParams | undefined;
      let backendAborted = false;
      const abortOwned = vi.fn(() => {
        backendAborted = true;
      });
      upstream.runEmbeddedAgent
        .mockImplementationOnce(async (params) => {
          const handle = {
            ...createEmbeddedRunHandle({ runId: params.runId, abort: abortOwned }),
            isAborted: () => backendAborted,
          };
          setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
          activeRun = params;
          try {
            await releaseBackend.promise;
            if (settlement === "rejection") {
              params.abortSignal?.throwIfAborted();
              throw new Error("Expected the model's actual cancellation signal");
            }
            return {
              payloads: settlement === "partial" ? [{ text: "Canceled partial output." }] : [],
              meta: { durationMs: 0, aborted: true },
            };
          } finally {
            clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
          }
        })
        .mockImplementationOnce(
          async (params) =>
            await withRegisteredNativeEmbeddedRun(params, () => ({
              payloads: [{ text: "Fresh consult completed." }],
              meta: { durationMs: 0 },
            })),
        );
      const settleBackend = async () => {
        releaseBackend.resolve();
        await Promise.allSettled(
          upstream.runEmbeddedAgent.mock.results
            .filter((result) => result.type === "return")
            .map((result) => result.value),
        );
        // Drain the consult/broker Promise continuations before another delegation
        // could supersede the original signal and hide a canceled-result append.
        await nextEventLoopTurn();
      };

      await withNativePlugin(async ({ create, offer, broadcast, chatAbortControllers }) => {
        try {
          const { socket } = await connectNativeSession({ create, offer });
          const sentFrames = () => socket.sent.map((frame): unknown => JSON.parse(frame));
          socket.serverEvent(
            nativeDelegation("canceled-delegation", "Keep working until I cancel."),
          );
          await vi.waitFor(() => expect(activeRun).toBeDefined());
          if (!activeRun) {
            throw new Error("Native delegation did not reach the model backend");
          }
          const { runId, abortSignal } = activeRun;
          expect(chatAbortControllers.get(runId)).toMatchObject({
            agentId: AGENT_ID,
            sessionKey: SESSION_KEY,
            sessionId: SESSION_ID,
            ownerConnId: CONNECTION_ID,
          });
          expect(abortSignal?.aborted).toBe(false);

          socket.serverEvent({ type: "turn.done", turn: { role: "user", transcript: "cancel" } });
          socket.serverEvent(nativeDelegation("cancel-request", "cancel"));
          await vi.waitFor(() => expect(abortOwned).toHaveBeenCalledOnce());
          await vi.waitFor(() =>
            expect(sentFrames()).toContainEqual(
              expect.objectContaining({
                type: "delegation.context.append",
                delegation_item_id: "cancel-request",
                channel: "speakable",
                content: [
                  expect.objectContaining({
                    type: "input_text",
                    text: expect.stringContaining("Cancelled the active OpenClaw run."),
                  }),
                ],
              }),
            ),
          );
          expect(abortSignal?.aborted).toBe(true);
          expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);

          await settleBackend();
          expect(sentFrames()).not.toContainEqual(
            expect.objectContaining({
              type: "delegation.context.append",
              delegation_item_id: "canceled-delegation",
            }),
          );
          socket.serverEvent(nativeDelegation("late-cancel", "cancel"));
          await nextEventLoopTurn();
          expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
          socket.serverEvent(nativeDelegation("after-cancel", "Start a fresh small task."));
          await vi.waitFor(() =>
            expect(sentFrames()).toContainEqual({
              type: "delegation.context.append",
              delegation_item_id: "after-cancel",
              channel: "speakable",
              content: [{ type: "input_text", text: "Fresh consult completed." }],
            }),
          );
          expect(upstream.runEmbeddedAgent).toHaveBeenCalledTimes(2);
          expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
          expect(talkEventTypes(broadcast)).not.toContain("session.error");
        } finally {
          await settleBackend();
        }
      });
    },
  );

  it("keeps legacy native data-channel and client transcript ownership unchanged", async () => {
    await withNativePlugin(async ({ create, offer, invoke, broadcast }) => {
      const { result, socket } = await connectNativeSession({ create, offer }, false);
      socket.serverEvent({
        type: "turn.done",
        turn: { role: "user", transcript: "Client-owned speech" },
      });
      await flushClientVoiceSessionWrites({
        agentId: AGENT_ID,
        voiceSessionId: requireString(result, "voiceSessionId"),
      });
      expect(
        readSessionTranscriptMessageEvents({ agentId: AGENT_ID, sessionId: SESSION_ID }),
      ).toHaveLength(0);
      expect(talkEventTypes(broadcast)).not.toContain("transcript.done");
      await invoke("talk.client.transcript", {
        entryId: "legacy-final",
        role: "user",
        text: "Client-owned speech",
      });
      expect(
        readSessionTranscriptMessageEvents({ agentId: AGENT_ID, sessionId: SESSION_ID }),
      ).toHaveLength(1);
      upstream.runEmbeddedAgent.mockImplementation(
        async (params) =>
          await withRegisteredNativeEmbeddedRun(params, () => ({
            payloads: [{ text: "Legacy provider consultation." }],
            meta: { durationMs: 0 },
          })),
      );
      socket.serverEvent(nativeDelegation("legacy-status", "Status?"));
      await vi.waitFor(() =>
        expect(socket.sent.join("\n")).toContain("Legacy provider consultation."),
      );
      expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
    });
  });
});
