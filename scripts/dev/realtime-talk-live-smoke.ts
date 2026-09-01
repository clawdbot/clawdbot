// Realtime Talk Live Smoke script supports OpenClaw repository automation.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readBoundedResponseText } from "../lib/bounded-response.mjs";
import {
  parseStrictIntegerOption,
  previewForDevToolLog,
  redactJsonValueForDevToolLog,
} from "../lib/dev-tooling-safety.ts";
import { toErrorObject as toLintErrorObject } from "../lib/error-format.mts";

const OPENAI_REALTIME_MODEL =
  process.env.OPENCLAW_REALTIME_OPENAI_MODEL?.trim() || "gpt-realtime-2.1";
const OPENAI_REALTIME_VOICE = process.env.OPENCLAW_REALTIME_OPENAI_VOICE?.trim() || "alloy";
const DEFAULT_OPENAI_HTTP_TIMEOUT_MS = 30_000;
const OPENAI_HTTP_RESPONSE_MAX_BYTES = 256 * 1024;
const DEFAULT_OPENAI_AUDIO_CYCLES = 1;
const MAX_OPENAI_AUDIO_CYCLES = 10;
const OPENAI_AUDIO_CHUNK_BYTES = 960;
const OPENAI_AUDIO_CHUNK_DELAY_MS = 5;
const OPENAI_AUDIO_ROUNDTRIP_TIMEOUT_MS = 60_000;
const OPENAI_AUDIO_TRAILING_SILENCE_MS = 750;
// Match the shared TalkAudioLevel meter's -50 dBFS floor (TalkPlaybackLevelMeters.swift).
const OPENAI_BROWSER_SPEECH_MIN_RMS = 10 ** (-50 / 20);
const OPENAI_BROWSER_SPEECH_MIN_SECONDS = 0.1;
const GOOGLE_REALTIME_MODEL =
  process.env.OPENCLAW_REALTIME_GOOGLE_MODEL?.trim() || "gemini-3.1-flash-live-preview";
const GOOGLE_REALTIME_VOICE = process.env.OPENCLAW_REALTIME_GOOGLE_VOICE?.trim() || "Kore";
const GOOGLE_LIVE_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

type RealtimeSmokeCliOptions = {
  help: boolean;
  openAIAudioCycles: number;
  openAIOnly: boolean;
};

// Keep live stacks behind their owning smoke paths so help and safety helpers stay lightweight.
type Browser = import("playwright").Browser;
type RealtimeVoiceBridge = import("../../src/talk/provider-types.ts").RealtimeVoiceBridge;
type ViteDevServer = Awaited<ReturnType<(typeof import("vite"))["createServer"]>>;

type SmokeResult = {
  name: string;
  ok: boolean;
  details?: Record<string, unknown>;
};

type TimeoutOptions<T> = {
  label: string;
  timeoutMs: number;
  run: (signal: AbortSignal) => Promise<T>;
};

type OpenAIHttpOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type OpenAIRealtimeBrowserResponseReader = (
  response: Response,
  label: string,
  maxBytes: number,
) => Promise<string>;

type OpenAIWebRtcSmokeGlobal = typeof globalThis & {
  openclawReadBoundedRealtimeResponseText?: OpenAIRealtimeBrowserResponseReader;
};

class CliArgumentError extends Error {
  override name = "CliArgumentError";
}

function usage(): string {
  return [
    "Usage: node --import tsx scripts/dev/realtime-talk-live-smoke.ts [options]",
    "",
    "Options:",
    "  --openai-only             Run only the OpenAI legs",
    "  --openai-audio-cycles N   Run 1-10 backend audio roundtrip cycles (default: 1)",
    "  -h, --help                Show this help",
    "",
    "Environment:",
    "  OPENAI_API_KEY",
    "  GEMINI_API_KEY or GOOGLE_API_KEY",
  ].join("\n");
}

function parseRealtimeSmokeArgs(argv = process.argv.slice(2)): RealtimeSmokeCliOptions {
  let openAIAudioCycles = DEFAULT_OPENAI_AUDIO_CYCLES;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h" || arg === "--openai-only") {
      continue;
    }
    if (arg === "--openai-audio-cycles") {
      const rawCycles = argv[index + 1];
      if (!rawCycles) {
        throw new CliArgumentError("--openai-audio-cycles requires a value");
      }
      openAIAudioCycles = parseStrictIntegerOption({
        fallback: DEFAULT_OPENAI_AUDIO_CYCLES,
        label: "--openai-audio-cycles",
        min: 1,
        raw: rawCycles,
      });
      if (openAIAudioCycles > MAX_OPENAI_AUDIO_CYCLES) {
        throw new CliArgumentError(
          `--openai-audio-cycles must be <= ${MAX_OPENAI_AUDIO_CYCLES}; got ${openAIAudioCycles}`,
        );
      }
      index += 1;
      continue;
    }
    throw new CliArgumentError(`Unknown argument: ${arg}`);
  }
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    openAIAudioCycles,
    openAIOnly: argv.includes("--openai-only"),
  };
}

function getEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function shortError(error: unknown): string {
  return previewForDevToolLog(error instanceof Error ? error.message : String(error), 800);
}

async function readBoundedText(
  response: Response,
  label: string,
  maxBytes = OPENAI_HTTP_RESPONSE_MAX_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  return await readBoundedResponseText(response, label, maxBytes, {
    createTooLargeError: (message: string) => new Error(message),
    signal,
  });
}

async function readBoundedJsonResponse(
  response: Response,
  label: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const text = await readBoundedText(response, label, OPENAI_HTTP_RESPONSE_MAX_BYTES, signal);
  return JSON.parse(text) as Record<string, unknown>;
}

function resolveOpenAIHttpTimeoutMs(
  raw = process.env.OPENCLAW_REALTIME_OPENAI_HTTP_TIMEOUT_MS,
): number {
  return parseStrictIntegerOption({
    fallback: DEFAULT_OPENAI_HTTP_TIMEOUT_MS,
    label: "OPENCLAW_REALTIME_OPENAI_HTTP_TIMEOUT_MS",
    min: 1,
    raw,
  });
}

async function withTimeout<T>(options: TimeoutOptions<T>): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`${options.label} exceeded timeout of ${options.timeoutMs}ms`);
      reject(error);
      controller.abort(error);
    }, options.timeoutMs);
  });
  try {
    return await Promise.race([options.run(controller.signal), timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function printResult(result: SmokeResult): void {
  console.log(
    `${result.name}: ${result.ok ? "ok" : "failed"}`,
    redactJsonValueForDevToolLog(result.details ?? {}),
  );
}

function compareStrings(left: string | undefined, right: string | undefined): number {
  return (left ?? "").localeCompare(right ?? "");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function appendBounded<T>(items: T[], item: T, maxItems: number): void {
  if (items.length < maxItems) {
    items.push(item);
  }
}

function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim();
}

function transcriptIncludesMarker(transcripts: string[], marker: string): boolean {
  return normalizeTranscript(transcripts.join(" ")).includes(normalizeTranscript(marker));
}

function resolveGatewayRelayModulePath(repoRoot = process.cwd()): string {
  return `/@fs/${repoRoot.replaceAll("\\", "/")}/ui/src/pages/chat/realtime-talk-gateway-relay.ts`;
}

async function sendPcmAudioInChunks(
  bridge: RealtimeVoiceBridge,
  audio: Buffer,
  options: { chunkBytes?: number; delayMs?: number } = {},
): Promise<number> {
  const chunkBytes = options.chunkBytes ?? OPENAI_AUDIO_CHUNK_BYTES;
  const delayMs = options.delayMs ?? OPENAI_AUDIO_CHUNK_DELAY_MS;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    throw new Error(`PCM audio chunk size must be a positive integer; got ${chunkBytes}`);
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`PCM audio chunk delay must be a non-negative number; got ${delayMs}`);
  }
  let chunks = 0;
  for (let offset = 0; offset < audio.byteLength; offset += chunkBytes) {
    bridge.sendAudio(audio.subarray(offset, Math.min(offset + chunkBytes, audio.byteLength)));
    chunks += 1;
    if (delayMs > 0) {
      await delay(delayMs);
    }
  }
  return chunks;
}

async function readOpenAIRealtimeBrowserResponseText(
  response: Response,
  label: string,
  maxBytes: number,
): Promise<string> {
  const responseBodyTooLargeError = (errorLabel: string, errorMaxBytes: number): Error =>
    new Error(`${errorLabel} response body exceeded ${errorMaxBytes} bytes`);
  const rawContentLength = response.headers.get("content-length");
  if (rawContentLength && /^\d+$/u.test(rawContentLength)) {
    const contentLength = Number(rawContentLength);
    if (!Number.isSafeInteger(contentLength) || contentLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw responseBodyTooLargeError(label, maxBytes);
    }
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  let canceled = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail) {
          chunks.push(tail);
        }
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        canceled = true;
        await reader.cancel().catch(() => undefined);
        throw responseBodyTooLargeError(label, maxBytes);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    if (!canceled) {
      reader.releaseLock();
    }
  }

  return chunks.join("");
}

function openAIRealtimeBrowserResponseReaderInitScript(): string {
  return `globalThis.openclawReadBoundedRealtimeResponseText = ${readOpenAIRealtimeBrowserResponseText.toString()};`;
}

async function createOpenAIClientSecret(
  apiKey: string,
  options: OpenAIHttpOptions = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? resolveOpenAIHttpTimeoutMs();
  const payload = await withTimeout({
    label: "OpenAI Realtime client secret request",
    timeoutMs,
    run: async (signal) => {
      const response = await fetchImpl("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model: OPENAI_REALTIME_MODEL,
            audio: {
              // Synthetic microphone input must not compete with the requested spoken marker.
              input: { turn_detection: null },
              output: { voice: OPENAI_REALTIME_VOICE },
            },
          },
        }),
        signal,
      });
      if (!response.ok) {
        throw new Error(
          `OpenAI Realtime client secret failed (${response.status}): ${previewForDevToolLog(
            await readBoundedText(
              response,
              "OpenAI Realtime client secret error",
              OPENAI_HTTP_RESPONSE_MAX_BYTES,
              signal,
            ),
            600,
          )}`,
        );
      }
      return await readBoundedJsonResponse(response, "OpenAI Realtime client secret", signal);
    },
  });
  const nested =
    payload.client_secret && typeof payload.client_secret === "object"
      ? (payload.client_secret as Record<string, unknown>)
      : undefined;
  const value = typeof payload.value === "string" ? payload.value : undefined;
  const nestedValue = typeof nested?.value === "string" ? nested.value : undefined;
  const secret = value ?? nestedValue;
  if (!secret) {
    throw new Error("OpenAI Realtime client secret response did not include a value");
  }
  return secret;
}

async function smokeOpenAIBackendBridge(apiKey: string): Promise<SmokeResult> {
  const { buildOpenAIRealtimeVoiceProvider } =
    await import("../../extensions/openai/realtime-voice-provider.ts");
  const provider = buildOpenAIRealtimeVoiceProvider();
  const events: string[] = [];
  const bridge = provider.createBridge({
    providerConfig: {
      apiKey,
      model: OPENAI_REALTIME_MODEL,
      voice: OPENAI_REALTIME_VOICE,
    },
    instructions: "OpenClaw backend realtime live smoke. Do not speak yet.",
    onAudio: () => {},
    onClearAudio: () => {},
    onEvent: (event) => {
      events.push(`${event.direction}:${event.type}`);
    },
  });

  try {
    await bridge.connect();
    return {
      name: "openai-backend-bridge",
      ok: bridge.isConnected(),
      details: {
        model: OPENAI_REALTIME_MODEL,
        connected: bridge.isConnected(),
        events: events.slice(0, 10),
      },
    };
  } catch (error) {
    return {
      name: "openai-backend-bridge",
      ok: false,
      details: { model: OPENAI_REALTIME_MODEL, error: shortError(error) },
    };
  } finally {
    bridge.close();
  }
}

async function smokeOpenAIAudioRoundtrip(apiKey: string, cycleCount: number): Promise<SmokeResult> {
  const cycles: Array<Record<string, unknown>> = [];
  try {
    const [
      { buildOpenAIRealtimeVoiceProvider },
      { buildOpenAISpeechProvider },
      { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ },
    ] = await Promise.all([
      import("../../extensions/openai/realtime-voice-provider.ts"),
      import("../../extensions/openai/speech-provider.ts"),
      import("../../src/talk/provider-types.ts"),
    ]);
    const speechProvider = buildOpenAISpeechProvider();
    const synthesized = await speechProvider.synthesizeTelephony?.({
      text: "Please reply with the single word glacier.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: {
        apiKey,
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
      timeoutMs: 45_000,
    });
    if (!synthesized) {
      throw new Error("OpenAI speech provider did not return telephony audio");
    }
    if (synthesized.outputFormat !== "pcm" || synthesized.sampleRate !== 24_000) {
      throw new Error(
        `OpenAI speech provider returned ${synthesized.outputFormat} at ${synthesized.sampleRate} Hz`,
      );
    }
    const trailingSilenceBytes = Math.ceil(
      (synthesized.sampleRate * 2 * OPENAI_AUDIO_TRAILING_SILENCE_MS) / 1_000,
    );
    const inputAudio = Buffer.concat([synthesized.audioBuffer, Buffer.alloc(trailingSilenceBytes)]);

    for (let cycle = 1; cycle <= cycleCount; cycle += 1) {
      const provider = buildOpenAIRealtimeVoiceProvider();
      const events: string[] = [];
      const finalUserTranscripts: string[] = [];
      const finalAssistantTranscripts: string[] = [];
      let outputAudioBytes = 0;
      let lateAudioBytes = 0;
      let responseDone = false;
      let closed = false;
      let resolveRoundtrip: ((error?: Error) => void) | undefined;
      const roundtrip = new Promise<Error | undefined>((resolve) => {
        resolveRoundtrip = resolve;
      });
      const maybeResolveRoundtrip = () => {
        if (
          responseDone &&
          outputAudioBytes > 512 &&
          transcriptIncludesMarker(finalUserTranscripts, "glacier") &&
          transcriptIncludesMarker(finalAssistantTranscripts, "glacier")
        ) {
          resolveRoundtrip?.();
        }
      };
      const bridgeRef: { current?: RealtimeVoiceBridge } = {};
      const bridge = provider.createBridge({
        providerConfig: {
          apiKey,
          model: OPENAI_REALTIME_MODEL,
          voice: OPENAI_REALTIME_VOICE,
          vadThreshold: 0.1,
          silenceDurationMs: 500,
          prefixPaddingMs: 300,
        },
        audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
        instructions:
          "Follow the speaker's request exactly. Reply briefly and do not add commentary.",
        onAudio: (audio) => {
          if (closed) {
            lateAudioBytes += audio.byteLength;
            return;
          }
          outputAudioBytes += audio.byteLength;
          maybeResolveRoundtrip();
        },
        onClearAudio: () => {},
        onMark: (markName) => bridgeRef.current?.acknowledgeMark(markName),
        onTranscript: (role, text, isFinal) => {
          if (!isFinal) {
            return;
          }
          appendBounded(
            role === "user" ? finalUserTranscripts : finalAssistantTranscripts,
            text,
            8,
          );
          maybeResolveRoundtrip();
        },
        onEvent: (event) => {
          appendBounded(events, `${event.direction}:${event.type}`, 80);
          if (event.direction === "server" && event.type === "response.done") {
            responseDone = true;
            maybeResolveRoundtrip();
          }
        },
        onError: (error) => resolveRoundtrip?.(error),
        onClose: (reason) => {
          if (!closed && reason === "error") {
            resolveRoundtrip?.(new Error("OpenAI audio roundtrip bridge closed with an error"));
          }
        },
      });
      bridgeRef.current = bridge;

      let chunksSent = 0;
      try {
        await bridge.connect();
        const boundedRoundtrip = withTimeout({
          label: `OpenAI audio roundtrip cycle ${cycle}`,
          timeoutMs: OPENAI_AUDIO_ROUNDTRIP_TIMEOUT_MS,
          run: () => roundtrip,
        });
        // Observe failures immediately; the same promise is awaited after input streaming completes.
        void boundedRoundtrip.catch(() => undefined);
        chunksSent = await sendPcmAudioInChunks(bridge, inputAudio);
        const roundtripError = await boundedRoundtrip;
        if (roundtripError) {
          throw roundtripError;
        }
      } catch (error) {
        resolveRoundtrip?.(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        closed = true;
        bridge.close();
        bridge.close();
        bridgeRef.current = undefined;
        await delay(100);
      }
      if (lateAudioBytes > 0) {
        throw new Error(
          `OpenAI audio roundtrip cycle ${cycle} received ${lateAudioBytes} audio bytes after close`,
        );
      }
      cycles.push({
        cycle,
        inputAudioBytes: inputAudio.byteLength,
        chunksSent,
        outputAudioBytes,
        userTranscript: finalUserTranscripts.join(" "),
        assistantTranscript: finalAssistantTranscripts.join(" "),
        responseDone,
        lateAudioBytes,
        events,
      });
    }

    return {
      name: "openai-backend-audio-roundtrip",
      ok: cycles.length === cycleCount,
      details: {
        model: OPENAI_REALTIME_MODEL,
        cycles,
      },
    };
  } catch (error) {
    return {
      name: "openai-backend-audio-roundtrip",
      ok: false,
      details: {
        model: OPENAI_REALTIME_MODEL,
        completedCycles: cycles.length,
        error: shortError(error),
      },
    };
  }
}

async function smokeOpenAIWebRtc(browser: Browser, apiKey: string): Promise<SmokeResult> {
  try {
    const openAIHttpTimeoutMs = resolveOpenAIHttpTimeoutMs();
    const clientSecret = await createOpenAIClientSecret(apiKey, { timeoutMs: openAIHttpTimeoutMs });
    const context = await browser.newContext({
      permissions: ["microphone"],
    });
    try {
      const page = await context.newPage();
      await page.evaluate("globalThis.__name = (fn) => fn");
      await page.evaluate(openAIRealtimeBrowserResponseReaderInitScript());
      const result = await page.evaluate(
        async ({
          clientSecret: secret,
          sdpAnswerMaxBytes,
          timeoutMs,
          audioTimeoutMs,
          minSpeechRms,
          minSpeechSeconds,
        }) => {
          const readBoundedTextLocal = (globalThis as OpenAIWebRtcSmokeGlobal)
            .openclawReadBoundedRealtimeResponseText;
          if (!readBoundedTextLocal) {
            throw new Error("OpenAI Realtime bounded response reader was not installed");
          }
          const withBrowserTimeout = async <T>(
            label: string,
            run: (signal: AbortSignal) => Promise<T>,
            durationMs = timeoutMs,
          ): Promise<T> => {
            const controller = new AbortController();
            let timeout: number | undefined;
            const timeoutPromise = new Promise<T>((_resolve, reject) => {
              timeout = window.setTimeout(() => {
                const error = new Error(`${label} exceeded timeout of ${durationMs}ms`);
                reject(error);
                controller.abort(error);
              }, durationMs);
            });
            try {
              return await Promise.race([run(controller.signal), timeoutPromise]);
            } finally {
              if (timeout !== undefined) {
                window.clearTimeout(timeout);
              }
            }
          };
          let media: MediaStream | undefined;
          let peer: RTCPeerConnection | undefined;
          let audioContext: AudioContext | undefined;
          let oscillator: OscillatorNode | undefined;
          const playback = new Audio();
          let providerError: string | undefined;
          let transcriptMarker = false;
          let responseDone = false;
          try {
            if (navigator.mediaDevices?.getUserMedia) {
              media = await navigator.mediaDevices.getUserMedia({ audio: true });
            } else {
              audioContext = new AudioContext();
              const destination = audioContext.createMediaStreamDestination();
              oscillator = audioContext.createOscillator();
              oscillator.connect(destination);
              oscillator.start();
              media = destination.stream;
            }
            peer = new RTCPeerConnection();
            peer.addEventListener("track", (event) => {
              playback.srcObject = event.streams[0] ?? new MediaStream([event.track]);
              void playback.play().catch((error: unknown) => {
                providerError = error instanceof Error ? error.message : String(error);
              });
            });
            for (const track of media.getAudioTracks()) {
              peer.addTrack(track, media);
            }
            const channel = peer.createDataChannel("oai-events");
            channel.addEventListener("open", () => {
              channel.send(
                JSON.stringify({
                  type: "response.create",
                  response: { instructions: "Say only the word glacier." },
                }),
              );
            });
            channel.addEventListener("message", (event: MessageEvent<string>) => {
              const message = JSON.parse(event.data) as {
                type?: string;
                transcript?: string;
                response?: { status?: string };
                error?: { message?: string };
              };
              if (message.type === "response.output_audio_transcript.done") {
                transcriptMarker = /\bglacier\b/iu.test(message.transcript ?? "");
              }
              if (message.type === "response.done") {
                responseDone = message.response?.status === "completed";
                if (!responseDone) {
                  providerError = `OpenAI browser response ${message.response?.status ?? "missing status"}`;
                }
              }
              if (message.type === "error") {
                providerError = message.error?.message ?? "OpenAI browser realtime error";
              }
            });
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            const offerSdp = offer.sdp;
            if (!offerSdp) {
              throw new Error("OpenAI Realtime SDP offer did not include SDP");
            }
            const answer = await withBrowserTimeout(
              "OpenAI Realtime SDP offer request",
              async (signal) => {
                const response = await fetch("https://api.openai.com/v1/realtime/calls", {
                  method: "POST",
                  body: offerSdp,
                  headers: {
                    Authorization: `Bearer ${secret}`,
                    "Content-Type": "application/sdp",
                  },
                  signal,
                });
                if (!response.ok) {
                  throw new Error(`OpenAI Realtime SDP offer failed (${response.status})`);
                }
                return await readBoundedTextLocal(
                  response,
                  "OpenAI Realtime SDP answer",
                  sdpAnswerMaxBytes,
                );
              },
            );
            await peer.setRemoteDescription({ type: "answer", sdp: answer });
            let outputAudioBytes = 0;
            let outputAudioEnergy = 0;
            let outputAudioSamplesDuration = 0;
            let outputAudioSpeechDuration = 0;
            let outputAudioPeakRms = 0;
            const mediaPeer = peer;
            await withBrowserTimeout(
              "OpenAI Realtime browser audio",
              async (signal) => {
                while (!signal.aborted) {
                  if (providerError) {
                    throw new Error(providerError);
                  }
                  if (["failed", "closed"].includes(mediaPeer.connectionState)) {
                    return;
                  }
                  const stats = await mediaPeer.getStats();
                  const previousEnergy = outputAudioEnergy;
                  const previousDuration = outputAudioSamplesDuration;
                  outputAudioBytes = 0;
                  outputAudioEnergy = 0;
                  outputAudioSamplesDuration = 0;
                  stats.forEach((entry: RTCInboundRtpStreamStats) => {
                    if (entry.type === "inbound-rtp" && entry.kind === "audio") {
                      outputAudioBytes += entry.bytesReceived ?? 0;
                      outputAudioEnergy += entry.totalAudioEnergy ?? 0;
                      outputAudioSamplesDuration += entry.totalSamplesDuration ?? 0;
                    }
                  });
                  const energyDelta = outputAudioEnergy - previousEnergy;
                  const durationDelta = outputAudioSamplesDuration - previousDuration;
                  if (energyDelta >= 0 && durationDelta > 0) {
                    const rms = Math.sqrt(energyDelta / durationDelta);
                    outputAudioPeakRms = Math.max(outputAudioPeakRms, rms);
                    if (rms >= minSpeechRms) {
                      outputAudioSpeechDuration += durationDelta;
                    }
                  }
                  if (
                    mediaPeer.connectionState === "connected" &&
                    transcriptMarker &&
                    responseDone &&
                    outputAudioBytes > 512 &&
                    outputAudioSpeechDuration >= minSpeechSeconds
                  ) {
                    return;
                  }
                  await new Promise((resolve) => {
                    window.setTimeout(resolve, 50);
                  });
                }
                signal.throwIfAborted();
              },
              audioTimeoutMs,
            );
            return {
              answerHasAudio: answer.includes("m=audio"),
              remoteDescriptionApplied: peer.remoteDescription?.type === "answer",
              connectionState: peer.connectionState,
              transcriptMarker,
              responseDone,
              outputAudioBytes,
              outputAudioEnergy,
              outputAudioSamplesDuration,
              outputAudioSpeechDuration,
              outputAudioPeakRms,
            };
          } finally {
            playback.pause();
            playback.srcObject = null;
            peer?.close();
            media?.getTracks().forEach((track) => track.stop());
            oscillator?.stop();
            await audioContext?.close();
          }
        },
        {
          clientSecret,
          sdpAnswerMaxBytes: OPENAI_HTTP_RESPONSE_MAX_BYTES,
          timeoutMs: openAIHttpTimeoutMs,
          audioTimeoutMs: OPENAI_AUDIO_ROUNDTRIP_TIMEOUT_MS,
          minSpeechRms: OPENAI_BROWSER_SPEECH_MIN_RMS,
          minSpeechSeconds: OPENAI_BROWSER_SPEECH_MIN_SECONDS,
        },
      );
      return {
        name: "openai-webrtc-browser",
        ok:
          result.answerHasAudio &&
          result.remoteDescriptionApplied &&
          result.connectionState === "connected" &&
          result.transcriptMarker &&
          result.responseDone &&
          result.outputAudioBytes > 512 &&
          result.outputAudioSpeechDuration >= OPENAI_BROWSER_SPEECH_MIN_SECONDS,
        details: {
          model: OPENAI_REALTIME_MODEL,
          protocol: "ga-realtime",
          answerHasAudio: result.answerHasAudio,
          remoteDescriptionApplied: result.remoteDescriptionApplied,
          connectionState: result.connectionState,
          transcriptMarker: result.transcriptMarker,
          responseDone: result.responseDone,
          outputAudioBytes: result.outputAudioBytes,
          outputAudioEnergy: result.outputAudioEnergy,
          outputAudioSamplesDuration: result.outputAudioSamplesDuration,
          outputAudioSpeechDuration: result.outputAudioSpeechDuration,
          outputAudioPeakRms: result.outputAudioPeakRms,
        },
      };
    } finally {
      await context.close();
    }
  } catch (error) {
    return { name: "openai-webrtc-browser", ok: false, details: { error: shortError(error) } };
  }
}

async function smokeGoogleLiveBrowserWs(browser: Browser, apiKey: string): Promise<SmokeResult> {
  try {
    const { REALTIME_VOICE_DESCRIBE_VIEW_TOOL } =
      await import("../../src/talk/describe-view-tool.ts");
    const { buildGoogleRealtimeVoiceProvider } =
      await import("../../extensions/google/realtime-voice-provider.ts");
    const provider = buildGoogleRealtimeVoiceProvider();
    const session = await provider.createBrowserSession?.({
      cfg: {},
      providerConfig: {
        apiKey,
        model: GOOGLE_REALTIME_MODEL,
        voice: GOOGLE_REALTIME_VOICE,
      },
      model: GOOGLE_REALTIME_MODEL,
      voice: GOOGLE_REALTIME_VOICE,
      instructions:
        "OpenClaw browser Video Talk live smoke. After receiving a visual frame and request, call describe_view exactly once.",
      tools: [REALTIME_VOICE_DESCRIBE_VIEW_TOOL],
    });
    if (
      !session ||
      session.transport !== "provider-websocket" ||
      session.protocol !== "google-live-bidi"
    ) {
      throw new Error("Google Live provider did not create a browser WebSocket session");
    }
    const page = await browser.newPage();
    await page.evaluate("globalThis.__name = (fn) => fn");
    const result = await page.evaluate(
      async ({
        initialMessage,
        tokenName,
        websocketUrl,
      }: {
        initialMessage: unknown;
        tokenName: string;
        websocketUrl: string;
      }) => {
        const debug: {
          opened: boolean;
          messages: string[];
          close?: { code: number; reason: string };
          error: boolean;
        } = { opened: false, messages: [], error: false };
        let setupComplete = false;
        let videoFrameSent = false;
        let describeViewCalled = false;
        let functionResponseSent = false;
        const dataToText = async (data: unknown): Promise<string> => {
          if (typeof data === "string") {
            return data;
          }
          if (data instanceof Blob) {
            return await data.text();
          }
          if (data instanceof ArrayBuffer) {
            return new TextDecoder().decode(data);
          }
          return String(data);
        };
        const url = new URL(websocketUrl);
        url.searchParams.set("access_token", tokenName);
        const ws = new WebSocket(url.toString());
        const done = new Promise<Record<string, unknown>>((resolve, reject) => {
          const timeout = window.setTimeout(
            () => reject(new Error(`Google Live setup timed out: ${JSON.stringify(debug)}`)),
            15_000,
          );
          ws.addEventListener("open", () => {
            debug.opened = true;
            ws.send(JSON.stringify(initialMessage));
          });
          ws.addEventListener("message", (event) => {
            void (async () => {
              const text = await dataToText(event.data);
              debug.messages.push(text.slice(0, 300));
              const message = JSON.parse(text) as {
                setupComplete?: unknown;
                serverContent?: unknown;
                toolCall?: {
                  functionCalls?: Array<{ id?: string; name?: string }>;
                };
              };
              if (message.setupComplete) {
                setupComplete = true;
                const canvas = document.createElement("canvas");
                canvas.width = 8;
                canvas.height = 8;
                const context = canvas.getContext("2d");
                if (!context) {
                  throw new Error("Google Live smoke could not create a camera fixture");
                }
                context.fillStyle = "#2f81f7";
                context.fillRect(0, 0, canvas.width, canvas.height);
                const frame = canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
                if (!frame) {
                  throw new Error("Google Live smoke camera fixture was empty");
                }
                ws.send(
                  JSON.stringify({
                    realtimeInput: { video: { data: frame, mimeType: "image/jpeg" } },
                  }),
                );
                videoFrameSent = true;
                ws.send(
                  JSON.stringify({
                    realtimeInput: { text: "Call describe_view now for the visual frame." },
                  }),
                );
                return;
              }
              const describeView = message.toolCall?.functionCalls?.find(
                (call) => call.name === "describe_view" && call.id,
              );
              if (describeView?.id) {
                describeViewCalled = true;
                ws.send(
                  JSON.stringify({
                    toolResponse: {
                      functionResponses: [
                        {
                          id: describeView.id,
                          name: "describe_view",
                          response: { ok: true, cameraStreamActive: true },
                        },
                      ],
                    },
                  }),
                );
                functionResponseSent = true;
                return;
              }
              if (message.serverContent && functionResponseSent) {
                window.clearTimeout(timeout);
                resolve({
                  setupComplete,
                  videoFrameSent,
                  describeViewCalled,
                  functionResponseAccepted: true,
                  readyState: ws.readyState,
                });
              }
            })().catch((error: unknown) => {
              window.clearTimeout(timeout);
              reject(toLintErrorObject(error, "Non-Error rejection"));
            });
          });
          ws.addEventListener("error", () => {
            debug.error = true;
            window.clearTimeout(timeout);
            reject(new Error("Google Live browser WebSocket errored"));
          });
          ws.addEventListener("close", (event) => {
            debug.close = { code: event.code, reason: event.reason };
            if (event.code !== 1000) {
              window.clearTimeout(timeout);
              reject(new Error(`Google Live browser WebSocket closed: ${JSON.stringify(debug)}`));
            }
          });
        });
        const value = await done;
        ws.close(1000);
        return value;
      },
      {
        initialMessage: session.initialMessage ?? { setup: {} },
        tokenName: session.clientSecret,
        websocketUrl: session.websocketUrl || GOOGLE_LIVE_WS_URL,
      },
    );
    await page.close();
    return {
      name: "google-live-browser-ws",
      ok:
        result.setupComplete === true &&
        result.videoFrameSent === true &&
        result.describeViewCalled === true &&
        result.functionResponseAccepted === true,
      details: {
        model: GOOGLE_REALTIME_MODEL,
        setupComplete: result.setupComplete === true,
        videoFrameSent: result.videoFrameSent === true,
        describeViewCalled: result.describeViewCalled === true,
        functionResponseAccepted: result.functionResponseAccepted === true,
      },
    };
  } catch (error) {
    return { name: "google-live-browser-ws", ok: false, details: { error: shortError(error) } };
  }
}

async function smokeGatewayRelayBrowser(browser: Browser): Promise<SmokeResult> {
  let server: ViteDevServer | undefined;
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-realtime-talk-"));
  try {
    const { createServer } = await import("vite");
    const repoRoot = process.cwd();
    const relayModulePath = JSON.stringify(resolveGatewayRelayModulePath(repoRoot));
    await writeFile(
      path.join(dir, "index.html"),
      '<!doctype html><meta charset="utf-8"><script type="module" src="/main.ts"></script>',
    );
    await writeFile(
      path.join(dir, "main.ts"),
      `
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listeners = new Set();
const requests = [];
const statuses = [];
const transcripts = [];

function emit(event) {
  for (const listener of [...listeners]) {
    listener(event);
  }
}

function base64ZeroPcm(bytes) {
  let text = "";
  for (let index = 0; index < bytes; index += 1) {
    text += String.fromCharCode(0);
  }
  return btoa(text);
}

const client = {
  addEventListener(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async request(method, params) {
    requests.push({ method, params });
    if (method === "talk.client.toolCall") {
      const runId = params.idempotencyKey || "run-smoke";
      window.setTimeout(() => {
        emit({ event: "chat", payload: { runId, state: "final", message: { text: "relay consult ok" } } });
      }, 50);
      return { runId };
    }
    return { ok: true };
  },
};

try {
  const { GatewayRelayRealtimeTalkTransport } = await import(${relayModulePath});
  const transport = new GatewayRelayRealtimeTalkTransport(
    {
      provider: "smoke",
      transport: "gateway-relay",
      relaySessionId: "relay-live-smoke",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 24000,
        outputEncoding: "pcm16",
        outputSampleRateHz: 24000,
      },
    },
    {
      client,
      sessionKey: "main",
      callbacks: {
        onStatus: (status, detail) => statuses.push({ status, detail }),
        onTranscript: (entry) => transcripts.push(entry),
      },
    },
  );
  const startResult = await transport.start();
  if (startResult !== "ready") {
    throw new Error("Relay smoke transport did not become ready: " + startResult);
  }
  transport.activate();
  emit({ event: "talk.event", payload: { relaySessionId: "relay-live-smoke", type: "ready" } });
  emit({
    event: "talk.event",
    payload: { relaySessionId: "relay-live-smoke", type: "transcript", role: "user", text: "relay user", final: true },
  });
  emit({
    event: "talk.event",
    payload: { relaySessionId: "relay-live-smoke", type: "transcript", role: "assistant", text: "relay assistant", final: false },
  });
  emit({
    event: "talk.event",
    payload: { relaySessionId: "relay-live-smoke", type: "audio", audioBase64: base64ZeroPcm(480) },
  });
  const processor = transport.inputProcessor;
  processor?.onaudioprocess?.({
    inputBuffer: { getChannelData: () => new Float32Array(160).fill(0.01) },
  });
  emit({ event: "talk.event", payload: { relaySessionId: "relay-live-smoke", type: "mark" } });
  emit({
    event: "talk.event",
    payload: {
      relaySessionId: "relay-live-smoke",
      type: "toolCall",
      callId: "call-smoke",
      name: "openclaw_agent_consult",
      args: { question: "confirm relay consult path" },
    },
  });
  await delay(400);
  transport.stop();
  await delay(100);
  window.relaySmokeResult = { requests, statuses, transcripts };
  window.relaySmokeDone = true;
} catch (error) {
  window.relaySmokeResult = { error: error instanceof Error ? error.message : String(error), requests, statuses, transcripts };
  window.relaySmokeDone = true;
}
`,
    );
    server = await createServer({
      configFile: path.join(repoRoot, "ui/vite.config.ts"),
      root: dir,
      logLevel: "silent",
      server: {
        host: "127.0.0.1",
        port: 0,
        fs: { allow: [dir, repoRoot] },
      },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") {
      throw new Error("Vite did not expose a local port");
    }
    const url = `http://127.0.0.1:${address.port}/`;
    const context = await browser.newContext({ permissions: ["microphone"] });
    await context.grantPermissions(["microphone"], { origin: url });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(
      () => (globalThis as Record<string, unknown>).relaySmokeDone === true,
      undefined,
      {
        timeout: 15_000,
      },
    );
    const result = (await page.evaluate(
      () => (globalThis as Record<string, unknown>).relaySmokeResult,
    )) as {
      error?: string;
      requests?: Array<{ method?: string }>;
      statuses?: Array<{ status?: string }>;
      transcripts?: Array<{ role?: string; text?: string }>;
    };
    await context.close();
    if (result.error) {
      throw new Error(result.error);
    }
    const methods = new Set((result.requests ?? []).map((request) => request.method));
    const statusNames = new Set((result.statuses ?? []).map((entry) => entry.status));
    const transcriptTexts = new Set((result.transcripts ?? []).map((entry) => entry.text));
    const expectedMethods = [
      "talk.client.toolCall",
      "talk.session.appendAudio",
      "talk.session.submitToolResult",
      "talk.session.close",
    ];
    const ok =
      expectedMethods.every((method) => methods.has(method)) &&
      statusNames.has("listening") &&
      statusNames.has("thinking") &&
      transcriptTexts.has("relay user") &&
      transcriptTexts.has("relay assistant");
    return {
      name: "gateway-relay-browser-adapter",
      ok,
      details: {
        methods: [...methods].toSorted(compareStrings),
        statuses: [...statusNames].toSorted(compareStrings),
        transcripts: [...transcriptTexts].toSorted(compareStrings),
      },
    };
  } catch (error) {
    return {
      name: "gateway-relay-browser-adapter",
      ok: false,
      details: { error: shortError(error) },
    };
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const cli = parseRealtimeSmokeArgs(argv);
  if (cli.help) {
    console.log(usage());
    return;
  }
  const { chromium } = await import("playwright");
  const openAIKey = getEnv("OPENAI_API_KEY");
  const googleKey = getEnv("GEMINI_API_KEY") ?? getEnv("GOOGLE_API_KEY");
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  const results: SmokeResult[] = [];
  try {
    if (!openAIKey) {
      results.push({
        name: "openai-backend-bridge",
        ok: false,
        details: { error: "OPENAI_API_KEY missing" },
      });
      results.push({
        name: "openai-webrtc-browser",
        ok: false,
        details: { error: "OPENAI_API_KEY missing" },
      });
    } else {
      results.push(await smokeOpenAIBackendBridge(openAIKey));
      results.push(await smokeOpenAIAudioRoundtrip(openAIKey, cli.openAIAudioCycles));
      results.push(await smokeOpenAIWebRtc(browser, openAIKey));
    }
    if (!cli.openAIOnly) {
      if (!googleKey) {
        results.push({
          name: "google-live-browser-ws",
          ok: false,
          details: { error: "GEMINI_API_KEY or GOOGLE_API_KEY missing" },
        });
      } else {
        results.push(await smokeGoogleLiveBrowserWs(browser, googleKey));
      }
      results.push(await smokeGatewayRelayBrowser(browser));
    }
  } finally {
    await browser.close();
  }
  for (const result of results) {
    printResult(result);
  }
  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof CliArgumentError ? error.message : shortError(error));
    process.exitCode = 1;
  });
}

export const testing = {
  OPENAI_HTTP_RESPONSE_MAX_BYTES,
  createOpenAIClientSecret,
  parseRealtimeSmokeArgs,
  readOpenAIRealtimeBrowserResponseText,
  readBoundedText,
  resolveGatewayRelayModulePath,
  resolveOpenAIHttpTimeoutMs,
  sendPcmAudioInChunks,
  transcriptIncludesMarker,
  usage,
};
