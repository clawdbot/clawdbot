import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPayloads } from "../../agents/embedded-agent-runner/run/payloads.test-helpers.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../../auto-reply/reply-payload.js";
import type { TtsStatusEntry } from "../../tts/tts-runtime-types.js";
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
} from "../../tts/tts-runtime.test-support.js";
import { maybeApplyTtsToCronPayloads } from "./delivery-dispatch-policy.js";
import { normalizeDirectCronDeliveryPayloads } from "./delivery-payload-normalization.js";
import { resolveCronPayloadOutcome } from "./helpers.js";

// Keep the production TTS policy and provider adapter; only audio persistence
// is replaced so this owner-boundary proof creates no media or channel sends.
vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: (params: Parameters<typeof maybeApplyTtsToPayloadCore>[0]) =>
    maybeApplyTtsToPayloadCore(params, async () => "/tmp/cron-speech-proof.ogg"),
}));

describe("cron canonical speech payload delivery", () => {
  let previousTtsAttempt: TtsStatusEntry | undefined;

  beforeEach(async () => {
    const { getLastTtsAttempt } = await import("../../tts/tts-payload.js");
    previousTtsAttempt = getLastTtsAttempt();
    synthesizeMock.mockClear();
    prepareSynthesisMock.mockClear();
    transcodeAudioBufferMock.mockClear();
    installSpeechProviders([createMockSpeechProvider()]);
  });

  afterEach(async () => {
    const { setLastTtsAttempt } = await import("../../tts/tts-payload.js");
    setLastTtsAttempt(previousTtsAttempt);
    setTtsMachinePrefsPathResolver();
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
  });

  it.each(["Report complete.", "NO_REPLY\nReport complete."])(
    "preserves direct-delivery ownership while normalizing %j",
    (text) => {
      const metadata = {
        tts: { tagged: true as const, text: "The report is complete." },
        channelReplyTransformOwner: {},
        sourceReplyTranscriptMirror: { sessionKey: "agent:main:source" },
      };
      const source = setReplyPayloadMetadata({ text }, metadata);
      const normalized = normalizeDirectCronDeliveryPayloads({ deliveryPayloads: [source] });

      expect(normalized.kind).toBe("deliver");
      if (normalized.kind !== "deliver") {
        throw new Error("expected visible report after normalization");
      }
      expect(normalized.payload).toEqual([{ text: "Report complete." }]);
      expect(getReplyPayloadMetadata(normalized.payload[0]!)).toEqual(metadata);
      expect(source.text).toBe(text);
    },
  );

  it.each(
    ["whatsapp", "telegram", "discord", "slack"].flatMap((channel) =>
      (["tagged", "always"] as const).map((auto) => ({ channel, auto })),
    ),
  )("preserves authored speech for $channel with $auto TTS", async ({ channel, auto }) => {
    const visibleText = "Your report is ready.";
    const spokenText = "The report has finished successfully.";
    const payloads = buildPayloads({
      isCronTrigger: true,
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: visibleText }],
        openclawDelivery: { tts: { tagged: true, text: spokenText } },
      } as AssistantMessage,
    });
    const outcome = resolveCronPayloadOutcome({
      payloads,
      finalAssistantVisibleText: visibleText,
      preferFinalAssistantVisibleText: channel !== "whatsapp",
    });
    const normalized = normalizeDirectCronDeliveryPayloads(outcome);
    expect(normalized.kind).toBe("deliver");
    if (normalized.kind !== "deliver") {
      throw new Error("expected the canonical cron reply to remain deliverable");
    }

    const result = await maybeApplyTtsToCronPayloads({
      cfg: createTtsConfig(`openclaw-cron-speech-${randomUUID()}`),
      payloads: normalized.payload,
      delivery: { ok: true, channel, to: "test-recipient", mode: "explicit" },
      agentId: "main",
      ttsAuto: auto,
    });

    expect(synthesizeMock).toHaveBeenCalledTimes(1);
    expect(synthesizeMock.mock.calls[0]?.[0].text).toBe(spokenText);
    expect(result).toEqual([
      expect.objectContaining({
        text: visibleText,
        spokenText,
        mediaUrl: "/tmp/cron-speech-proof.ogg",
      }),
    ]);
    expect(getReplyPayloadMetadata(payloads[0]!)?.tts?.text).toBe(spokenText);
  });
});
