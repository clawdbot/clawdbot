import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import type { TtsStatusEntry } from "../tts/tts-runtime-types.js";
import {
  clearRuntimeConfigSnapshot,
  createMockSpeechProvider,
  createTtsConfig,
  installSpeechProviders,
  maybeApplyTtsToPayloadCore,
  prepareSynthesisMock,
  setTtsMachinePrefsPathResolver,
  synthesizeMock,
  transcodeAudioBufferMock,
} from "../tts/tts-runtime.test-support.js";
import { buildPayloads } from "./embedded-agent-runner/run/payloads.test-helpers.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./sessions/agent-session-loop-correctness.test-support.js";

registerAgentSessionLoopTestLifecycle();

describe("assistant speech facts through session settlement", () => {
  let previousTtsAttempt: TtsStatusEntry | undefined;

  beforeEach(async () => {
    const { getLastTtsAttempt } = await import("../tts/tts-payload.js");
    previousTtsAttempt = getLastTtsAttempt();
    synthesizeMock.mockClear();
    prepareSynthesisMock.mockClear();
    transcodeAudioBufferMock.mockClear();
    installSpeechProviders([createMockSpeechProvider()]);
  });

  afterEach(async () => {
    const { setLastTtsAttempt } = await import("../tts/tts-payload.js");
    setLastTtsAttempt(previousTtsAttempt);
    setTtsMachinePrefsPathResolver();
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
  });

  it.each([
    { queued: false, mixed: false, phase: false },
    { queued: true, mixed: false, phase: false },
    { queued: false, mixed: true, phase: false },
    { queued: true, mixed: true, phase: false },
    { queued: false, mixed: true, phase: true },
    { queued: true, mixed: true, phase: true },
  ])(
    "retains authored speech after persistence with queued=$queued mixed=$mixed phase=$phase",
    async ({ queued, mixed, phase }) => {
      const spokenText = "The report has finished successfully.";
      const speechText = `[[tts:text]]${spokenText}[[/tts:text]]`;
      const rawText = mixed ? `[[reply_to:message-42]]Report ready. ${speechText}` : speechText;
      const model = phase ? { ...testModel, api: "openai-completions" as const } : testModel;
      let calls = 0;
      streamMocks.streamSimple.mockImplementation(() => {
        const message = createAssistant(
          model,
          ++calls === 1
            ? [
                { type: "text", text: "Preparing your report." },
                { type: "toolCall", id: "report-1", name: "report", arguments: {} },
              ]
            : [{ type: "text", text: rawText }],
          calls === 1 ? "toolUse" : "stop",
        );
        if (phase && calls > 1) {
          // Chat Completions preserves this phase hint after reasoning reaches its final answer.
          message.openclawDelivery = { textPhaseRequiresTerminal: true };
        }
        return createAssistantResultStream(message);
      });
      const { session, sessionManager } = await createTestSession({
        model,
        customTools: [
          {
            name: "report",
            label: "Report",
            description: "Prepare the report.",
            parameters: Type.Object({}),
            execute: async () => ({
              content: [{ type: "text", text: "ready" }],
              details: undefined,
            }),
          },
        ],
      });
      const pending = createDeferred();
      const deliveredBlocks: ReplyPayload[] = [];
      const subscription = subscribeEmbeddedAgentSession({
        session,
        runId: `speech-facts-${queued}`,
        ...(queued
          ? {
              onBlockReply: (payload: ReplyPayload) => {
                deliveredBlocks.push(payload);
                return pending.promise;
              },
              onBlockReplyFlush: () => {},
            }
          : {}),
        blockReplyBreak: "message_end",
      });
      const prompt = session.prompt("Prepare a report and respond with speech only.");
      try {
        // The real session writes while an earlier delivery callback is pending.
        await vi.waitFor(() => {
          expect(sessionManager.getEntries()).toContainEqual(
            expect.objectContaining({
              type: "message",
              message: expect.objectContaining({
                openclawDelivery: {
                  ...(mixed ? { replyToId: "message-42" } : {}),
                  tts: { tagged: true, text: spokenText },
                },
              }),
            }),
          );
        });
        pending.resolve();
        await prompt;
        const assistant = subscription.getCurrentAttemptAssistant();
        if (queued && !mixed) {
          expect(deliveredBlocks.map((payload) => payload.text)).toEqual([
            "Preparing your report.",
            rawText,
          ]);
        }
        const payloads = buildPayloads({
          assistantTexts: subscription.assistantTexts,
          currentAssistant: assistant,
          lastAssistant: assistant,
        });
        expect(payloads).toHaveLength(1);
        expect(payloads[0]?.text).not.toContain("Preparing your report.");
        expect(
          payloads.some(
            (payload) =>
              getReplyPayloadMetadata(payload)?.tts?.text === spokenText ||
              payload.text?.includes(speechText),
          ),
        ).toBe(true);
        const speechPayload = queued && !mixed ? deliveredBlocks.at(-1) : payloads.at(-1);
        expect(speechPayload).toBeDefined();
        if (mixed) {
          expect(speechPayload).toMatchObject({ replyToId: "message-42", replyToTag: true });
        }
        const audio = await maybeApplyTtsToPayloadCore(
          {
            payload: speechPayload!,
            cfg: createTtsConfig(`openclaw-queued-speech-${randomUUID()}`),
            channel: "telegram",
            kind: "final",
            ttsAuto: "tagged",
          },
          async () => "/tmp/queued-speech-proof.ogg",
        );
        expect(synthesizeMock).toHaveBeenCalledTimes(1);
        expect(synthesizeMock.mock.calls[0]?.[0].text).toBe(spokenText);
        expect(audio).toMatchObject({
          mediaUrl: "/tmp/queued-speech-proof.ogg",
          spokenText,
          text: mixed ? "Report ready." : undefined,
        });
      } finally {
        pending.resolve();
        try {
          await prompt;
        } finally {
          subscription.unsubscribe();
        }
      }
    },
  );
});
