import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GoogleGenAI, Modality } from "@google/genai";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { buildOpenAIRealtimeVoiceProvider } from "../../extensions/openai/realtime-voice-provider.ts";

const OPENAI_REALTIME_MODEL =
  process.env.OPENCLAW_REALTIME_OPENAI_MODEL?.trim() || "gpt-realtime-2";
const OPENAI_REALTIME_VOICE = process.env.OPENCLAW_REALTIME_OPENAI_VOICE?.trim() || "alloy";
const GOOGLE_REALTIME_MODEL =
  process.env.OPENCLAW_REALTIME_GOOGLE_MODEL?.trim() ||
  "gemini-2.5-flash-native-audio-preview-12-2025";
const GOOGLE_REALTIME_VOICE = process.env.OPENCLAW_REALTIME_GOOGLE_VOICE?.trim() || "Kore";
const GOOGLE_LIVE_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

type SmokeResult = {
  name: string;
  ok: boolean;
  details?: Record<string, unknown>;
};

function getEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function shortError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readBoundedText(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > 600 ? `${text.slice(0, 600)}...` : text;
}

function printResult(result: SmokeResult): void {
  console.log(`${result.name}: ${result.ok ? "ok" : "failed"}`, result.details ?? {});
}

function compareStrings(left: string | undefined, right: string | undefined): number {
  return (left ?? "").localeCompare(right ?? "");
}

async function createOpenAIClientSecret(apiKey: string): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
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
          output: { voice: OPENAI_REALTIME_VOICE },
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `OpenAI Realtime client secret failed (${response.status}): ${await readBoundedText(
        response,
      )}`,
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
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

async function smokeOpenAIWebRtc(browser: Browser, apiKey: string): Promise<SmokeResult> {
  try {
    const clientSecret = await createOpenAIClientSecret(apiKey);
    const context = await browser.newContext({
      permissions: ["microphone"],
    });
    const page = await context.newPage();
    const result = await page.evaluate(
      async ({ clientSecret: secret }) => {
        let media: MediaStream;
        if (navigator.mediaDevices?.getUserMedia) {
          media = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          const audioContext = new AudioContext();
          const destination = audioContext.createMediaStreamDestination();
          const oscillator = audioContext.createOscillator();
          oscillator.connect(destination);
          oscillator.start();
          media = destination.stream;
        }
        const peer = new RTCPeerConnection();
        for (const track of media.getAudioTracks()) {
          peer.addTrack(track, media);
        }
        const channel = peer.createDataChannel("oai-events");
        const connectionState = new Promise<string>((resolve) => {
          const timeout = window.setTimeout(() => resolve(peer.connectionState), 12_000);
          peer.addEventListener("connectionstatechange", () => {
            if (peer.connectionState === "connected" || peer.connectionState === "failed") {
              window.clearTimeout(timeout);
              resolve(peer.connectionState);
            }
          });
          channel.addEventListener("open", () => {
            window.clearTimeout(timeout);
            resolve(peer.connectionState || "data-channel-open");
          });
        });
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        const response = await fetch("https://api.openai.com/v1/realtime/calls", {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/sdp",
          },
        });
        if (!response.ok) {
          throw new Error(`OpenAI Realtime SDP offer failed (${response.status})`);
        }
        const answer = await response.text();
        await peer.setRemoteDescription({ type: "answer", sdp: answer });
        const state = await connectionState;
        peer.close();
        media.getTracks().forEach((track) => track.stop());
        return {
          answerHasAudio: answer.includes("m=audio"),
          remoteDescriptionApplied: peer.remoteDescription?.type === "answer",
          connectionState: state,
        };
      },
      { clientSecret },
    );
    await context.close();
    return {
      name: "openai-webrtc-browser",
      ok: result.answerHasAudio && result.remoteDescriptionApplied,
      details: {
        model: OPENAI_REALTIME_MODEL,
        answerHasAudio: result.answerHasAudio,
        remoteDescriptionApplied: result.remoteDescriptionApplied,
        connectionState: result.connectionState,
      },
    };
  } catch (error) {
    return { name: "openai-webrtc-browser", ok: false, details: { error: shortError(error) } };
  }
}

async function createGoogleLiveToken(apiKey: string): Promise<string> {
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: "v1alpha" },
  });
  const now = Date.now();
  const token = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
      newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
      liveConnectConstraints: {
        model: GOOGLE_REALTIME_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: GOOGLE_REALTIME_VOICE },
            },
          },
          systemInstruction: "OpenClaw browser Talk live smoke.",
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      },
    },
  });
  const name = token.name?.trim();
  if (!name) {
    throw new Error("Google Live auth token response did not include a token name");
  }
  return name;
}

async function smokeGoogleLiveBrowserWs(browser: Browser, apiKey: string): Promise<SmokeResult> {
  try {
    const token = await createGoogleLiveToken(apiKey);
    const page = await browser.newPage();
    await page.evaluate("globalThis.__name = (fn) => fn");
    const result = await page.evaluate(
      async ({ model, tokenName, websocketUrl }) => {
        const debug: {
          opened: boolean;
          messages: string[];
          close?: { code: number; reason: string };
          error: boolean;
        } = { opened: false, messages: [], error: false };
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
            ws.send(
              JSON.stringify({
                setup: {
                  model: model.startsWith("models/") ? model : `models/${model}`,
                  generationConfig: { responseModalities: ["AUDIO"] },
                  inputAudioTranscription: {},
                  outputAudioTranscription: {},
                },
              }),
            );
          });
          ws.addEventListener("message", (event) => {
            void (async () => {
              const text = await dataToText(event.data);
              debug.messages.push(text.slice(0, 300));
              const message = JSON.parse(text) as { setupComplete?: unknown };
              if (!message.setupComplete) {
                return;
              }
              window.clearTimeout(timeout);
              resolve({ setupComplete: true, readyState: ws.readyState });
            })().catch((error) => {
              window.clearTimeout(timeout);
              reject(error);
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
        model: GOOGLE_REALTIME_MODEL,
        tokenName: token,
        websocketUrl: GOOGLE_LIVE_WS_URL,
      },
    );
    await page.close();
    return {
      name: "google-live-browser-ws",
      ok: result.setupComplete === true,
      details: { model: GOOGLE_REALTIME_MODEL, setupComplete: result.setupComplete === true },
    };
  } catch (error) {
    return { name: "google-live-browser-ws", ok: false, details: { error: shortError(error) } };
  }
}

async function smokeGatewayRelayBrowser(browser: Browser): Promise<SmokeResult> {
  let server: ViteDevServer | undefined;
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-realtime-talk-"));
  try {
    const repoRoot = process.cwd().replaceAll("\\", "/");
    await writeFile(
      path.join(dir, "index.html"),
      '<!doctype html><meta charset="utf-8"><script type="module" src="/main.ts"></script>',
    );
    await writeFile(
      path.join(dir, "main.ts"),
      `
import { GatewayRelayRealtimeTalkTransport } from "/@fs/${repoRoot}/ui/src/ui/chat/realtime-talk-gateway-relay.ts";

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
  await transport.start();
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
  window.__relaySmokeResult = { requests, statuses, transcripts };
  window.__relaySmokeDone = true;
} catch (error) {
  window.__relaySmokeResult = { error: error instanceof Error ? error.message : String(error), requests, statuses, transcripts };
  window.__relaySmokeDone = true;
}
`,
    );
    server = await createServer({
      root: dir,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
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
    await page.waitForFunction(() => globalThis.__relaySmokeDone === true, undefined, {
      timeout: 15_000,
    });
    const result = (await page.evaluate(() => globalThis.__relaySmokeResult)) as {
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

async function main(): Promise<void> {
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
      results.push(await smokeOpenAIWebRtc(browser, openAIKey));
    }
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

await main();
