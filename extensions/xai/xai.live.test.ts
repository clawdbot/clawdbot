// Xai tests cover xai plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { encodePngRgba, fillPixel } from "openclaw/plugin-sdk/media-runtime";
import type { OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createCapturedPluginRegistration,
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  expectOpenClawLiveTranscriptMarker,
  runRealtimeSttLiveTest,
} from "openclaw/plugin-sdk/provider-test-contracts";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeEvent,
} from "openclaw/plugin-sdk/realtime-voice";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { isBillingErrorMessage } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createCodeExecutionTool } from "./code-execution.js";
import plugin from "./index.js";

const XAI_API_KEY = process.env.XAI_API_KEY ?? "";
const LIVE_IMAGE_MODEL = process.env.OPENCLAW_LIVE_XAI_IMAGE_MODEL?.trim() || "grok-imagine-image";
const ENABLE_VIDEO_LIVE = process.env.OPENCLAW_LIVE_XAI_VIDEO === "1";
const liveEnabled = XAI_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;
const EMPTY_AUTH_STORE = { version: 1, profiles: {} } as const;

function createLiveConfig(): OpenClawConfig {
  const cfg = getRuntimeConfig();
  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        xai: {
          ...cfg.models?.providers?.xai,
          apiKey: XAI_API_KEY,
          baseUrl: "https://api.x.ai/v1",
        },
      },
    },
  } as OpenClawConfig;
}

function createReferencePng(): Buffer {
  const width = 96;
  const height = 96;
  const buf = Buffer.alloc(width * height * 4, 255);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      fillPixel(buf, x, y, width, 230, 244, 255, 255);
    }
  }

  for (let y = 24; y < 72; y += 1) {
    for (let x = 24; x < 72; x += 1) {
      fillPixel(buf, x, y, width, 255, 153, 51, 255);
    }
  }

  return encodePngRgba(buf, width, height);
}

function createVideoReferencePng(): Buffer {
  const width = 384;
  const height = 384;
  const buf = Buffer.alloc(width * height * 4, 255);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const blue = Math.round(160 + (80 * y) / height);
      fillPixel(buf, x, y, width, 32, 96, blue, 255);
    }
  }

  for (let y = 112; y < 272; y += 1) {
    for (let x = 112; x < 272; x += 1) {
      fillPixel(buf, x, y, width, 255, 153, 51, 255);
    }
  }

  return encodePngRgba(buf, width, height);
}

async function createTempAgentDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "xai-plugin-live-"));
}

const registerXaiPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "xai",
    name: "xAI Provider",
  });

function registerXaiRealtimeVoiceProvider() {
  const captured = createCapturedPluginRegistration({
    id: "xai",
    name: "xAI Provider",
    source: "test",
  });
  plugin.register(captured.api);
  return requireRegisteredProvider(captured.realtimeVoiceProviders, "xai");
}

function registerXaiToolFactories(): Map<string, OpenClawPluginToolFactory> {
  const factories = new Map<string, OpenClawPluginToolFactory>();
  plugin.register(
    createTestPluginApi({
      registerTool(tool, options) {
        if (typeof tool === "function" && options?.name) {
          factories.set(options.name, tool);
        }
      },
    }),
  );
  return factories;
}

async function runXaiLiveCase(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isBillingErrorMessage(message)) {
      console.warn(`[xai:live] skip ${label}: billing drift: ${message}`);
      return;
    }
    throw error;
  }
}

async function waitForXaiLive(
  label: string,
  predicate: () => boolean,
  timeoutMs = 45_000,
  describeState?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      const state = describeState?.();
      throw new Error(`xAI live timeout waiting for ${label}${state ? ` (${state})` : ""}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

function isRealtimeOpenBillingDrift(error: Error): boolean {
  return isBillingErrorMessage(error.message) || error.message.includes("server response: 429");
}

describeLive("xai plugin live", () => {
  it("gates registered billed tools and honors explicit cross-provider consent", async () => {
    await runXaiLiveCase("billed-tool-policy", async () => {
      const codeExecutionFactory = registerXaiToolFactories().get("code_execution");
      if (!codeExecutionFactory) {
        throw new Error("expected code_execution factory to be registered");
      }
      const baseConfig = {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: { apiKey: XAI_API_KEY },
              },
            },
          },
        },
      } as OpenClawConfig;
      const explicitConfig = {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: { apiKey: XAI_API_KEY },
                codeExecution: { enabled: true, maxTurns: 1, timeoutSeconds: 90 },
              },
            },
          },
        },
      } as OpenClawConfig;

      expect(
        codeExecutionFactory({
          config: baseConfig,
          activeModel: { provider: "xai", modelId: "grok-4.3" },
        }),
      ).not.toBeNull();
      expect(
        codeExecutionFactory({
          config: baseConfig,
          activeModel: { provider: "openai", modelId: "gpt-5.4" },
        }),
      ).toBeNull();
      expect(
        codeExecutionFactory({
          config: explicitConfig,
        }),
      ).toBeNull();

      const explicitCrossProviderTool = codeExecutionFactory({
        config: explicitConfig,
        activeModel: { provider: "openai", modelId: "gpt-5.4" },
      });
      if (!explicitCrossProviderTool || Array.isArray(explicitCrossProviderTool)) {
        throw new Error("expected explicit cross-provider code_execution tool");
      }
      const result = await explicitCrossProviderTool.execute("code-execution:cross-provider-live", {
        task: "Use the code interpreter to calculate 6 multiplied by 7.",
      });
      const details = (result.details ?? {}) as {
        content?: string;
        model?: string;
        usedCodeExecution?: boolean;
      };

      expect(details.model).toBe("grok-4.3");
      expect(details.usedCodeExecution).toBe(true);
      expect(details.content).toContain("42");
    });
  }, 120_000);

  it("runs remote code execution with the current default model", async () => {
    await runXaiLiveCase("code-execution", async () => {
      const tool = createCodeExecutionTool({
        config: {
          plugins: {
            entries: {
              xai: {
                config: {
                  webSearch: { apiKey: XAI_API_KEY },
                  codeExecution: { enabled: true, maxTurns: 1, timeoutSeconds: 90 },
                },
              },
            },
          },
        },
      });
      if (!tool) {
        throw new Error("expected code_execution tool to be registered");
      }

      const result = await tool.execute("code-execution:xai-live", {
        task: "Use the code interpreter to calculate the sum of the integers from 1 through 100.",
      });
      const details = (result.details ?? {}) as {
        content?: string;
        model?: string;
        usedCodeExecution?: boolean;
      };

      expect(details.model).toBe("grok-4.3");
      expect(details.usedCodeExecution).toBe(true);
      expect(details.content).toContain("5050");
    });
  }, 120_000);

  it("synthesizes TTS through the registered speech provider", async () => {
    await runXaiLiveCase("tts", async () => {
      const { speechProviders } = await registerXaiPlugin();
      const speechProvider = requireRegisteredProvider(speechProviders, "xai");
      const cfg = createLiveConfig();

      const voices = await speechProvider.listVoices?.({
        cfg,
        providerConfig: {
          apiKey: XAI_API_KEY,
          baseUrl: "https://api.x.ai/v1",
        },
      });
      expect(voices?.some((voice) => voice.id === "eve")).toBe(true);
      expect(voices?.some((voice) => voice.id === "altair")).toBe(true);

      const audioFile = await speechProvider.synthesize({
        text: "OpenClaw xAI text to speech integration test OK.",
        cfg,
        providerConfig: {
          apiKey: XAI_API_KEY,
          baseUrl: "https://api.x.ai/v1",
          voiceId: "altair",
        },
        target: "audio-file",
        timeoutMs: 90_000,
      });

      expect(audioFile.outputFormat).toBe("mp3");
      expect(audioFile.fileExtension).toBe(".mp3");
      expect(audioFile.voiceCompatible).toBe(false);
      expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);

      const streaming = await speechProvider.streamSynthesize?.({
        text: "OpenClaw xAI streaming text to speech integration test OK.",
        cfg,
        providerConfig: {
          apiKey: XAI_API_KEY,
          baseUrl: "https://api.x.ai/v1",
          voiceId: "altair",
        },
        target: "audio-file",
        timeoutMs: 90_000,
      });
      if (!streaming) {
        throw new Error("xAI streaming TTS did not return an audio stream");
      }
      try {
        const reader = streaming.audioStream.getReader();
        let streamedBytes = 0;
        while (true) {
          const result = await reader.read();
          if (result.done) {
            break;
          }
          streamedBytes += result.value.byteLength;
        }
        expect(streamedBytes).toBeGreaterThan(512);
        expect(streaming.outputFormat).toBe("mp3");
        expect(streaming.fileExtension).toBe(".mp3");
        expect(streaming.voiceCompatible).toBe(false);
      } finally {
        await streaming.release?.();
      }

      const telephony = await speechProvider.synthesizeTelephony?.({
        text: "OpenClaw xAI telephony check OK.",
        cfg,
        providerConfig: {
          apiKey: XAI_API_KEY,
          baseUrl: "https://api.x.ai/v1",
          voiceId: "eve",
        },
        timeoutMs: 90_000,
      });
      if (!telephony) {
        throw new Error("xAI telephony synthesis did not return audio");
      }
      expect(telephony.outputFormat).toBe("pcm");
      expect(telephony.sampleRate).toBe(24_000);
      expect(telephony?.audioBuffer.byteLength).toBeGreaterThan(512);
    });
  }, 120_000);

  it("transcribes audio through the registered media provider", async () => {
    await runXaiLiveCase("stt", async () => {
      const { mediaProviders, speechProviders } = await registerXaiPlugin();
      const mediaProvider = requireRegisteredProvider(mediaProviders, "xai");
      const speechProvider = requireRegisteredProvider(speechProviders, "xai");
      const cfg = createLiveConfig();
      const phrase = "OpenClaw xAI speech to text integration test OK.";

      const audioFile = await speechProvider.synthesize({
        text: phrase,
        cfg,
        providerConfig: {
          apiKey: XAI_API_KEY,
          baseUrl: "https://api.x.ai/v1",
          voiceId: "eve",
        },
        target: "audio-file",
        timeoutMs: 90_000,
      });

      const transcript = await mediaProvider.transcribeAudio?.({
        buffer: audioFile.audioBuffer,
        fileName: "xai-stt-live.mp3",
        mime: "audio/mpeg",
        apiKey: XAI_API_KEY,
        baseUrl: "https://api.x.ai/v1",
        timeoutMs: 90_000,
      });

      const normalized = transcript?.text.toLowerCase() ?? "";
      expect(transcript?.model).toBeUndefined();
      expectOpenClawLiveTranscriptMarker(normalized);
      expect(normalized).toContain("speech");
      expect(normalized).toContain("text");
      expect(normalized).toContain("integration");
    });
  }, 180_000);

  it("opens xAI realtime STT before sending audio", async () => {
    await runXaiLiveCase("realtime-open", async () => {
      const { realtimeTranscriptionProviders } = await registerXaiPlugin();
      const realtimeProvider = requireRegisteredProvider(realtimeTranscriptionProviders, "xai");
      const errors: Error[] = [];
      const session = realtimeProvider.createSession({
        providerConfig: {
          apiKey: XAI_API_KEY,
          baseUrl: "https://api.x.ai/v1",
          sampleRate: 16_000,
          encoding: "pcm",
          interimResults: true,
          endpointingMs: 800,
          language: "en",
        },
        onError: (error) => errors.push(error),
      });

      try {
        try {
          await session.connect();
        } catch (error) {
          const thrown = error instanceof Error ? error : new Error(String(error));
          if (isRealtimeOpenBillingDrift(thrown)) {
            console.warn(`[xai:live] skip realtime-open: billing drift: ${thrown.message}`);
            return;
          }
          throw error;
        }
        const billingError = errors.find(isRealtimeOpenBillingDrift);
        if (billingError) {
          console.warn(`[xai:live] skip realtime-open: billing drift: ${billingError.message}`);
          return;
        }
        expect(errors).toStrictEqual([]);
        expect(session.isConnected()).toBe(true);
      } finally {
        session.close();
      }
    });
  }, 30_000);

  it("streams realtime STT through the registered transcription provider", async () => {
    await runXaiLiveCase("realtime-stream", async () => {
      const { realtimeTranscriptionProviders, speechProviders } = await registerXaiPlugin();
      const realtimeProvider = requireRegisteredProvider(realtimeTranscriptionProviders, "xai");
      const speechProvider = requireRegisteredProvider(speechProviders, "xai");
      const cfg = createLiveConfig();
      const phrase = "OpenClaw xAI realtime transcription integration test OK.";

      const telephony = await speechProvider.synthesizeTelephony?.({
        text: phrase,
        cfg,
        providerConfig: {
          apiKey: XAI_API_KEY,
          baseUrl: "https://api.x.ai/v1",
          voiceId: "eve",
        },
        timeoutMs: 90_000,
      });
      if (!telephony) {
        throw new Error("xAI telephony synthesis did not return audio");
      }
      expect(telephony.outputFormat).toBe("pcm");
      expect(telephony.sampleRate).toBe(24_000);

      const chunkSize = Math.max(1, Math.floor(telephony.sampleRate * 2 * 0.1));
      const { transcripts, partials } = await runRealtimeSttLiveTest({
        provider: realtimeProvider,
        providerConfig: {
          apiKey: XAI_API_KEY,
          baseUrl: "https://api.x.ai/v1",
          sampleRate: telephony.sampleRate,
          encoding: "pcm",
          interimResults: true,
          endpointingMs: 500,
          language: "en",
        },
        audio: telephony.audioBuffer,
        chunkSize,
        delayMs: 20,
        closeBeforeWait: true,
      });

      const normalized = transcripts.join(" ").toLowerCase();
      expectOpenClawLiveTranscriptMarker(normalized);
      expect(normalized).toContain("transcription");
      expect(partials.length + transcripts.length).toBeGreaterThan(0);
    });
  }, 180_000);

  it("runs realtime voice audio, tool, barge-in, and resumed-context flow", async () => {
    const { speechProviders } = await registerXaiPlugin();
    const realtimeProvider = registerXaiRealtimeVoiceProvider();
    const speechProvider = requireRegisteredProvider(speechProviders, "xai");
    const cfg = createLiveConfig();
    const marker = "OPENCLAW_XAI_RESUME_42";
    const input = await speechProvider.synthesizeTelephony?.({
      text: "Stop counting now.",
      cfg,
      providerConfig: {
        apiKey: XAI_API_KEY,
        baseUrl: "https://api.x.ai/v1",
        voiceId: "altair",
      },
      timeoutMs: 90_000,
    });
    if (!input) {
      throw new Error("xAI realtime voice live input synthesis did not return audio");
    }
    expect(input.outputFormat).toBe("pcm");
    expect(input.sampleRate).toBe(24_000);

    const clientEvents: string[] = [];
    const serverEvents: string[] = [];
    const realtimeEvents: RealtimeVoiceBridgeEvent[] = [];
    const finalAssistantTranscripts: string[] = [];
    const finalUserTranscripts: string[] = [];
    const toolCalls: Array<{ callId: string; name: string }> = [];
    const clearAudioReasons: Array<string | undefined> = [];
    const errors: Error[] = [];
    let outputAudioBytes = 0;
    let holdPlaybackMarks = false;
    let holdNextResponseMarks = false;
    const bridge: RealtimeVoiceBridge = realtimeProvider.createBridge({
      cfg,
      providerConfig: {
        apiKey: XAI_API_KEY,
        baseUrl: "https://api.x.ai/v1",
        model: "grok-voice-latest",
        voice: "eve",
        sessionResumption: true,
        vadThreshold: 0.1,
        silenceDurationMs: 1200,
      },
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      instructions:
        "Reply briefly to spoken input. When a text message asks to call the live probe, call openclaw_live_probe. After a tool result, say its marker exactly.",
      tools: [
        {
          type: "function",
          name: "openclaw_live_probe",
          description: "Return the live validation marker.",
          parameters: {
            type: "object",
            properties: { token: { type: "string" } },
            required: ["token"],
          },
        },
      ],
      onAudio: (audio) => {
        outputAudioBytes += audio.byteLength;
      },
      onClearAudio: (reason) => {
        clearAudioReasons.push(reason);
        if (reason === "barge-in") {
          holdPlaybackMarks = false;
        }
      },
      onMark: (markName) => {
        if (!holdPlaybackMarks) {
          bridge.acknowledgeMark(markName);
        }
      },
      onTranscript: (role, text, isFinal) => {
        if (role === "assistant" && isFinal) {
          finalAssistantTranscripts.push(text);
        }
        if (role === "user" && isFinal) {
          finalUserTranscripts.push(text);
        }
      },
      onEvent: (event) => {
        realtimeEvents.push(event);
        (event.direction === "client" ? clientEvents : serverEvents).push(event.type);
        if (
          event.direction === "server" &&
          event.type === "response.created" &&
          holdNextResponseMarks
        ) {
          holdPlaybackMarks = true;
          holdNextResponseMarks = false;
        }
      },
      onToolCall: (event) => toolCalls.push({ callId: event.callId, name: event.name }),
      onError: (error) => errors.push(error),
    });

    try {
      await bridge.connect();
      const chunkBytes = 24_000 * 2 * 0.1;
      const audioBytesBeforeBargeIn = outputAudioBytes;
      const targetEventStart = realtimeEvents.length;
      bridge.setMediaTimestamp(1000);
      holdNextResponseMarks = true;
      bridge.sendUserMessage?.(
        "Count slowly from one to one hundred without stopping until interrupted.",
      );
      await waitForXaiLive(
        "barge-in target audio",
        () =>
          realtimeEvents
            .slice(targetEventStart)
            .some((event) => event.direction === "server" && event.type === "response.created") &&
          outputAudioBytes > audioBytesBeforeBargeIn + 512,
      );
      const bargeInClientEventStart = clientEvents.length;
      const bargeInServerEventStart = serverEvents.length;
      const bargeInRealtimeEventStart = realtimeEvents.length;
      const userTranscriptsBeforeBargeIn = finalUserTranscripts.length;
      bridge.setMediaTimestamp(1250);
      // Stream the interruption first so xAI's server VAD drives the same
      // speech-started barge-in path used by real microphone input.
      for (let offset = 0; offset < input.audioBuffer.length; offset += chunkBytes) {
        bridge.sendAudio(input.audioBuffer.subarray(offset, offset + chunkBytes));
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
      }
      for (let index = 0; index < 20; index += 1) {
        bridge.sendAudio(Buffer.alloc(chunkBytes));
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
      }
      await waitForXaiLive(
        "server-VAD audio barge-in",
        () => {
          const serverBargeInEvents = new Set(serverEvents.slice(bargeInServerEventStart));
          return (
            serverBargeInEvents.has("input_audio_buffer.speech_started") &&
            serverBargeInEvents.has("conversation.item.truncated") &&
            clientEvents.slice(bargeInClientEventStart).includes("conversation.item.truncate") &&
            clearAudioReasons.includes("barge-in")
          );
        },
        45_000,
        () =>
          [
            `server=${serverEvents.slice(-30).join(",")}`,
            `client=${clientEvents.slice(-30).join(",")}`,
            `userFinals=${finalUserTranscripts.length}`,
            `responseDone=${serverEvents.filter((event) => event === "response.done").length}`,
            `audioBytes=${outputAudioBytes}`,
            `errors=${errors.map((error) => error.message).join("|")}`,
          ].join(" "),
      );
      const bargeInClientEvents = clientEvents.slice(bargeInClientEventStart);
      expect(bargeInClientEvents).not.toContain("response.cancel");
      expect(bargeInClientEvents).toContain("conversation.item.truncate");
      await waitForXaiLive(
        "post-barge-in audio transcription",
        () => finalUserTranscripts.length > userTranscriptsBeforeBargeIn,
        45_000,
        () =>
          [
            `server=${serverEvents.slice(-20).join(",")}`,
            `client=${clientEvents.slice(-20).join(",")}`,
            `userFinals=${finalUserTranscripts.length}`,
            `responseDone=${serverEvents.filter((event) => event === "response.done").length}`,
            `audioBytes=${outputAudioBytes}`,
            `errors=${errors.map((error) => error.message).join("|")}`,
          ].join(" "),
      );
      await waitForXaiLive(
        "barge-in completion",
        () => {
          const responseEvents = realtimeEvents
            .slice(bargeInRealtimeEventStart)
            .filter((event) => event.direction === "server");
          const postBargeResponseId = responseEvents.find(
            (event) => event.type === "response.created",
          )?.responseId;
          return Boolean(
            postBargeResponseId &&
            responseEvents.some(
              (event) =>
                event.type === "response.done" &&
                event.responseId === postBargeResponseId &&
                event.detail?.includes("status=completed"),
            ),
          );
        },
        45_000,
        () =>
          realtimeEvents
            .slice(bargeInRealtimeEventStart)
            .filter((event) => event.direction === "server")
            .map(
              (event) =>
                `${event.type}:${event.responseId ?? "none"}:${event.detail ?? "no-detail"}`,
            )
            .join(","),
      );
      expect(
        finalUserTranscripts.slice(userTranscriptsBeforeBargeIn).join(" ").toLowerCase(),
      ).toMatch(/stop|interrupt/);

      bridge.sendUserMessage?.("Call openclaw_live_probe now with token bluebird.");
      await waitForXaiLive("realtime tool call", () => toolCalls.length > 0);
      expect(toolCalls[0]?.name).toBe("openclaw_live_probe");
      await bridge.submitToolResult(toolCalls[0]?.callId ?? "", { marker });
      await waitForXaiLive("tool-result audio", () =>
        finalAssistantTranscripts.some((text) => text.includes(marker)),
      );

      const reconnectStart = clientEvents.length;
      const socket = (bridge as unknown as { ws?: { terminate(): void } }).ws;
      if (!socket) {
        throw new Error("xAI realtime voice live bridge has no active WebSocket");
      }
      socket.terminate();
      await waitForXaiLive("resumed reconnect", () =>
        clientEvents.slice(reconnectStart).includes("session.reconnect.ready"),
      );

      const transcriptStart = finalAssistantTranscripts.length;
      bridge.sendUserMessage?.(
        "What exact marker did the live probe return earlier? Reply with only that marker.",
      );
      await waitForXaiLive("resumed marker recall", () =>
        finalAssistantTranscripts.slice(transcriptStart).some((text) => text.includes(marker)),
      );
      expect(errors).toStrictEqual([]);
    } finally {
      bridge.close();
    }
  }, 240_000);

  it("generates and edits images through the registered image provider", async () => {
    await runXaiLiveCase("image", async () => {
      const { imageProviders } = await registerXaiPlugin();
      const imageProvider = requireRegisteredProvider(imageProviders, "xai");
      const cfg = createLiveConfig();
      const agentDir = await createTempAgentDir();

      try {
        const generated = await imageProvider.generateImage({
          provider: "xai",
          model: LIVE_IMAGE_MODEL,
          prompt: "Create a minimal flat orange square centered on a white background.",
          cfg,
          agentDir,
          authStore: EMPTY_AUTH_STORE,
          timeoutMs: 180_000,
          count: 1,
          aspectRatio: "20:9",
          resolution: "1K",
        });

        expect(generated.model).toBe(LIVE_IMAGE_MODEL);
        expect(generated.images.length).toBeGreaterThan(0);
        expect(generated.images[0]?.mimeType.startsWith("image/")).toBe(true);
        expect(generated.images[0]?.buffer.byteLength).toBeGreaterThan(1_000);

        const edited = await imageProvider.generateImage({
          provider: "xai",
          model: LIVE_IMAGE_MODEL,
          prompt: "Combine these three references into one detailed pencil sketch.",
          cfg,
          agentDir,
          authStore: EMPTY_AUTH_STORE,
          timeoutMs: 180_000,
          count: 1,
          resolution: "1K",
          inputImages: [
            {
              buffer: createReferencePng(),
              mimeType: "image/png",
              fileName: "reference-1.png",
            },
            {
              buffer: createReferencePng(),
              mimeType: "image/png",
              fileName: "reference-2.png",
            },
            {
              buffer: createReferencePng(),
              mimeType: "image/png",
              fileName: "reference-3.png",
            },
          ],
        });

        expect(edited.model).toBe(LIVE_IMAGE_MODEL);
        expect(edited.images.length).toBeGreaterThan(0);
        expect(edited.images[0]?.mimeType.startsWith("image/")).toBe(true);
        expect(edited.images[0]?.buffer.byteLength).toBeGreaterThan(1_000);
      } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
      }
    });
  }, 300_000);

  it.skipIf(!ENABLE_VIDEO_LIVE)(
    "generates a classic Grok Imagine clip with inherited image geometry",
    async () => {
      await runXaiLiveCase("video-classic-i2v", async () => {
        const { videoProviders } = await registerXaiPlugin();
        const videoProvider = requireRegisteredProvider(videoProviders, "xai");
        const cfg = createLiveConfig();
        const agentDir = await createTempAgentDir();

        try {
          const generated = await videoProvider.generateVideo({
            provider: "xai",
            model: "grok-imagine-video",
            prompt: "Animate the square gently while preserving the square framing.",
            cfg,
            agentDir,
            authStore: EMPTY_AUTH_STORE,
            timeoutMs: 10 * 60_000,
            durationSeconds: 1,
            inputImages: [
              {
                buffer: createVideoReferencePng(),
                mimeType: "image/png",
                fileName: "video-reference.png",
              },
            ],
          });

          expect(generated.model).toBe("grok-imagine-video");
          expect(generated.videos).toHaveLength(1);
          const video = generated.videos[0];
          if (!video?.buffer) {
            throw new Error("xAI classic image-to-video did not return a buffered video");
          }
          expect(video.mimeType.startsWith("video/")).toBe(true);
          expect(video.buffer.byteLength).toBeGreaterThan(1_000);
          const outputPath = process.env.OPENCLAW_LIVE_XAI_VIDEO_OUTPUT?.trim();
          if (outputPath) {
            await fs.writeFile(outputPath, video.buffer);
          }
        } finally {
          await fs.rm(agentDir, { recursive: true, force: true });
        }
      });
    },
    12 * 60_000,
  );

  it.skipIf(!ENABLE_VIDEO_LIVE)(
    "generates a Grok Imagine Video 1.5 clip from one image",
    async () => {
      await runXaiLiveCase("video-1.5", async () => {
        const { videoProviders } = await registerXaiPlugin();
        const videoProvider = requireRegisteredProvider(videoProviders, "xai");
        const cfg = createLiveConfig();
        const agentDir = await createTempAgentDir();

        try {
          const generated = await videoProvider.generateVideo({
            provider: "xai",
            model: "grok-imagine-video-1.5",
            prompt:
              "Animate the orange square with a subtle slow rotation. Keep the framing fixed.",
            cfg,
            agentDir,
            authStore: EMPTY_AUTH_STORE,
            timeoutMs: 10 * 60_000,
            durationSeconds: 1,
            resolution: "1080P",
            inputImages: [
              {
                buffer: createVideoReferencePng(),
                mimeType: "image/png",
                fileName: "video-reference.png",
              },
            ],
          });

          expect(generated.model).toBe("grok-imagine-video-1.5");
          expect(generated.videos).toHaveLength(1);
          const video = generated.videos[0];
          if (!video?.buffer) {
            throw new Error("xAI Video 1.5 did not return a buffered video");
          }
          expect(video.mimeType.startsWith("video/")).toBe(true);
          expect(video.buffer.byteLength).toBeGreaterThan(1_000);
          const outputPath = process.env.OPENCLAW_LIVE_XAI_VIDEO_15_OUTPUT?.trim();
          if (outputPath) {
            await fs.writeFile(outputPath, video.buffer);
          }
        } finally {
          await fs.rm(agentDir, { recursive: true, force: true });
        }
      });
    },
    12 * 60_000,
  );
});
